/** @jest-environment node */

/**
 * F6.2 (docs/REPO_AUDIT_2026-08-21.md) — webhook event-log idempotency ledger
 * dual-run, Mongo leg.
 *
 * Scoped to `checkWebhookEventProcessed` / `recordWebhookEvent` /
 * `markWebhookEventProcessed` in `lib/mongo-queries.ts`, wired into
 * `app/api/webhook/route.ts` behind `isMongoPrimary()`. This ledger is
 * independent of order-level idempotency (`upsertOrderByPaymentIntent`,
 * already covered by `tests/unit/webhook-order-idempotency.test.ts`) — it
 * tracks "have we seen Stripe event id X before" regardless of which order
 * it maps to. We drive the route with `payment_intent.payment_failed`, a
 * handler that never touches orders, so this test stays scoped to the
 * event-log layer only.
 */

const mockIsMongoPrimary = jest.fn(() => true);

jest.mock('@/lib/db/provider', () => ({
  isMongoPrimary: () => mockIsMongoPrimary(),
}));

jest.mock('@/lib/server-only-guard', () => ({}));

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init: { status?: number; headers?: HeadersInit } = {}) => ({
      status: init.status ?? 200,
      headers: new Headers(init.headers),
      json: async () => body,
    }),
  },
}));

// Provider-isolation assertion (same style as tests/unit/admin-dashboard-dual-run.test.ts):
// `.from` must never be called while Mongo is primary.
const mockFrom = jest.fn();
jest.mock('@/lib/supabase/admin', () => ({
  createClient: jest.fn(() => ({
    from: (...args: unknown[]) => mockFrom(...args),
  })),
}));

jest.mock('@/lib/rate-limit', () => ({
  enforceRateLimit: jest.fn(async () => ({ success: true, headers: {} })),
  getClientIdentifier: () => 'test-client',
}));

jest.mock('@/lib/stripe/server', () => ({
  // Signature verification is covered by stripe-webhook-consolidation.test.ts;
  // here constructEvent just parses the payload we hand in.
  getStripe: () => ({
    webhooks: { constructEvent: (payload: string) => JSON.parse(payload) },
  }),
}));

jest.mock('@/lib/email/triggers', () => ({
  sendPurchaseReceiptForCheckoutSession: jest.fn(async () => undefined),
}));

const mockGetDb = jest.fn();
jest.mock('@/lib/mongo', () => ({
  getDb: (...args: unknown[]) => mockGetDb(...args),
}));

type WebhookEventDoc = {
  event_id: string;
  event_type: string;
  processed: boolean;
  error_message: string | null;
  processed_at: Date | null;
  created_at: Date;
};

/**
 * Minimal stateful stand-in for the `webhook_events` collection, covering
 * exactly the `findOne`/`updateOne` calls `lib/mongo-queries.ts` makes.
 */
function createFakeMongoDb() {
  const docs = new Map<string, WebhookEventDoc>();

  const collection = {
    findOne: jest.fn(async (filter: { event_id: string }) => docs.get(filter.event_id) ?? null),
    updateOne: jest.fn(
      async (
        filter: { event_id: string },
        update: { $setOnInsert?: Partial<WebhookEventDoc>; $set?: Partial<WebhookEventDoc> },
        options: { upsert?: boolean } = {}
      ) => {
        const existing = docs.get(filter.event_id);
        if (existing) {
          Object.assign(existing, update.$set ?? {});
          return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
        }
        if (!options.upsert) {
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
        }
        const doc: WebhookEventDoc = {
          event_id: filter.event_id,
          event_type: '',
          processed: false,
          error_message: null,
          processed_at: null,
          created_at: new Date(),
          ...(update.$setOnInsert ?? {}),
          ...(update.$set ?? {}),
        };
        docs.set(filter.event_id, doc);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
    ),
  };

  const db = {
    collection: jest.fn((name: string) => {
      if (name !== 'webhook_events') {
        throw new Error(`unexpected collection: ${name}`);
      }
      return collection;
    }),
  };

  return { db, docs };
}

describe('webhook event-log ledger dual-run (F6.2)', () => {
  type RouteResponse = { status: number; json: () => Promise<unknown> };
  let webhookPOST: (request: unknown) => Promise<RouteResponse>;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  const paymentFailedEvent = (eventId: string) => ({
    id: eventId,
    type: 'payment_intent.payment_failed',
    data: { object: { id: 'pi_test_1', last_payment_error: null } },
  });

  const deliver = (eventId: string) =>
    webhookPOST({
      text: async () => JSON.stringify(paymentFailedEvent(eventId)),
      headers: new Headers({ 'stripe-signature': 'sig' }),
    });

  beforeAll(() => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    // Late require: the route reads STRIPE_WEBHOOK_SECRET at module load time.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    webhookPOST = require('@/app/api/webhook/route').POST;
  });

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockIsMongoPrimary.mockReturnValue(true);
    mockFrom.mockClear();
    mockGetDb.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('two deliveries of the same event id leave exactly one processed doc, Supabase never touched', async () => {
    const { db, docs } = createFakeMongoDb();
    mockGetDb.mockResolvedValue(db);

    const first = await deliver('evt_pf_dup');
    const second = await deliver('evt_pf_dup');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      received: true,
      message: 'Event already processed',
    });

    expect(docs.size).toBe(1);
    const stored = docs.get('evt_pf_dup');
    expect(stored?.processed).toBe(true);
    expect(stored?.event_type).toBe('payment_intent.payment_failed');
    expect(stored?.error_message).toBeNull();

    // The whole delivery ran through the Mongo leg — the Supabase admin
    // client's query builder must never have been invoked.
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('distinct event ids each get their own ledger doc', async () => {
    const { db, docs } = createFakeMongoDb();
    mockGetDb.mockResolvedValue(db);

    await deliver('evt_pf_a');
    await deliver('evt_pf_b');

    expect(docs.size).toBe(2);
    expect(docs.get('evt_pf_a')?.processed).toBe(true);
    expect(docs.get('evt_pf_b')?.processed).toBe(true);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
