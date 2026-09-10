/**
 * @jest-environment node
 *
 * Unit tests for Phoenix WS2a mongo-queries (mocked Db — no live Atlas).
 * Node env required: the mongodb driver needs TextEncoder (not in jsdom).
 */

jest.mock('@/lib/server-only-guard', () => ({}));
jest.mock('@/lib/mongo', () => ({
  getDb: jest.fn(() => {
    throw new Error('getDb should not be called when Db is injected');
  }),
}));

import {
  DEFAULT_PAGE_SIZE,
  checkWebhookEventProcessed,
  getBookById,
  getBookBySlug,
  getBooks,
  getUserOrders,
  markWebhookEventProcessed,
  recordWebhookEvent,
  searchBooks,
  upsertOrderByPaymentIntent,
} from '@/lib/mongo-queries';

type AggFn = jest.Mock;
type FindFn = jest.Mock;
type CountFn = jest.Mock;

function mockDb(
  handlers: {
    aggregateResult?: unknown[];
    findResult?: unknown[];
    countResult?: number;
    findOneResult?: unknown;
    updateOneResult?: { upsertedCount?: number; matchedCount?: number; modifiedCount?: number };
    insertOneId?: string;
  } = {}
) {
  const toArray: AggFn = jest.fn().mockResolvedValue(handlers.aggregateResult ?? []);
  const aggregate = jest.fn().mockReturnValue({ toArray });

  const findToArray: FindFn = jest.fn().mockResolvedValue(handlers.findResult ?? []);
  const limit = jest.fn().mockReturnValue({ toArray: findToArray });
  const skip = jest.fn().mockReturnValue({ limit });
  const sort = jest.fn().mockReturnValue({ skip });
  const find = jest.fn().mockReturnValue({ sort });
  const countDocuments: CountFn = jest.fn().mockResolvedValue(handlers.countResult ?? 0);
  const findOne = jest.fn().mockResolvedValue(handlers.findOneResult ?? null);
  const updateOne = jest
    .fn()
    .mockResolvedValue(
      handlers.updateOneResult ?? { upsertedCount: 0, matchedCount: 1, modifiedCount: 0 }
    );
  const insertOne = jest.fn().mockResolvedValue({
    insertedId: handlers.insertOneId ?? '507f1f77bcf86cd799439099',
  });

  const collection = jest.fn().mockImplementation((name: string) => {
    if (name === 'orders') {
      return { find, countDocuments, findOne, updateOne, insertOne };
    }
    return { aggregate, findOne, updateOne, insertOne };
  });

  return {
    db: { collection } as unknown as import('mongodb').Db,
    aggregate,
    toArray,
    find,
    countDocuments,
    sort,
    skip,
    limit,
    findOne,
    updateOne,
    insertOne,
  };
}

describe('lib/mongo-queries', () => {
  it('exports default page size of 20', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(20);
  });

  it('getBooks aggregates with author lookup and pagination defaults', async () => {
    const { db, aggregate, toArray } = mockDb({
      aggregateResult: [
        {
          items: [{ _id: 'b1', title: 'Test', slug: 'test', author: { pen_name: 'A' } }],
          total: [{ count: 1 }],
        },
      ],
    });

    const result = await getBooks({ status: 'published' }, {}, db);

    expect(aggregate).toHaveBeenCalled();
    const pipeline = aggregate.mock.calls[0][0] as Record<string, unknown>[];
    expect(pipeline[0]).toEqual({ $match: { status: 'published' } });
    expect(pipeline[1]).toEqual({ $sort: { created_at: -1 } });
    const facet = pipeline[2] as { $facet: { items: unknown[] } };
    expect(facet.$facet.items[0]).toEqual({ $skip: 0 });
    expect(facet.$facet.items[1]).toEqual({ $limit: 20 });
    expect(facet.$facet.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ $lookup: expect.any(Object) })])
    );

    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.page).toBe(1);
    expect(result.perPage).toBe(20);
    expect(result.hasNext).toBe(false);
    expect(toArray).toHaveBeenCalled();
  });

  it('getBookBySlug returns null when missing', async () => {
    const { db } = mockDb({ aggregateResult: [] });
    await expect(getBookBySlug('missing', {}, db)).resolves.toBeNull();
  });

  it('getBookBySlug returns joined book', async () => {
    const doc = { _id: 'b2', slug: 'hello', title: 'Hello', author: null };
    const { db, aggregate } = mockDb({ aggregateResult: [doc] });
    const result = await getBookBySlug('hello', { status: 'published' }, db);
    expect(result?.slug).toBe('hello');
    const pipeline = aggregate.mock.calls[0][0] as Record<string, unknown>[];
    expect(pipeline[0]).toEqual({ $match: { slug: 'hello', status: 'published' } });
  });

  it('getUserOrders pages by user_id', async () => {
    const { db, find, countDocuments, sort, skip, limit } = mockDb({
      findResult: [
        {
          _id: 'o1',
          user_id: 'user-1',
          order_items: [],
          amount: 10,
          currency: 'usd',
          status: 'completed',
        },
      ],
      countResult: 21,
    });

    const result = await getUserOrders('user-1', { page: 2, perPage: 20 }, db);

    expect(countDocuments).toHaveBeenCalledWith({ user_id: 'user-1' });
    expect(find).toHaveBeenCalledWith({ user_id: 'user-1' });
    expect(sort).toHaveBeenCalledWith({ created_at: -1 });
    expect(skip).toHaveBeenCalledWith(20);
    expect(limit).toHaveBeenCalledWith(20);
    expect(result.total).toBe(21);
    expect(result.page).toBe(2);
    expect(result.hasNext).toBe(false);
    expect(result.hasPrev).toBe(true);
  });

  it('searchBooks returns empty for blank query without hitting the driver', async () => {
    const { db, aggregate } = mockDb();
    const result = await searchBooks('   ', {}, db);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('searchBooks uses $text and textScore sort', async () => {
    const { db, aggregate } = mockDb({
      aggregateResult: [{ items: [{ slug: 'a', score: 1.5 }], total: [{ count: 1 }] }],
    });

    const result = await searchBooks('resonance', { status: 'published', perPage: 10 }, db);
    expect(result.total).toBe(1);
    expect(result.perPage).toBe(10);

    const pipeline = aggregate.mock.calls[0][0] as Record<string, unknown>[];
    expect(pipeline[0]).toEqual({
      $match: { $text: { $search: 'resonance' }, status: 'published' },
    });
    expect(pipeline[1]).toEqual({ $addFields: { score: { $meta: 'textScore' } } });
    expect(pipeline[2]).toEqual({ $sort: { score: { $meta: 'textScore' } } });
  });

  it('upsertOrderByPaymentIntent inserts once then reports duplicate', async () => {
    const orderDoc = { _id: 'ord1', stripe_payment_intent_id: 'pi_123' };
    const { db, updateOne, findOne } = mockDb({
      updateOneResult: { upsertedCount: 1, matchedCount: 0, modifiedCount: 0 },
      findOneResult: orderDoc,
    });

    const first = await upsertOrderByPaymentIntent(
      {
        user_id: 'u1',
        stripe_payment_intent_id: 'pi_123',
        amount: 9.99,
        currency: 'usd',
        order_items: [
          {
            book_id: 'b1',
            title: 'T',
            quantity: 1,
            unit_amount: 9.99,
            currency: 'usd',
          },
        ],
      },
      db
    );
    expect(first.inserted).toBe(true);
    expect(first.orderId).toBe('ord1');
    expect(updateOne).toHaveBeenCalledWith(
      { stripe_payment_intent_id: 'pi_123' },
      expect.objectContaining({ $setOnInsert: expect.any(Object) }),
      { upsert: true }
    );

    updateOne.mockResolvedValueOnce({ upsertedCount: 0, matchedCount: 1, modifiedCount: 0 });
    findOne.mockResolvedValueOnce(orderDoc);
    const second = await upsertOrderByPaymentIntent(
      {
        user_id: 'u1',
        stripe_payment_intent_id: 'pi_123',
        amount: 9.99,
        currency: 'usd',
        order_items: [
          {
            book_id: 'b1',
            title: 'T',
            quantity: 1,
            unit_amount: 9.99,
            currency: 'usd',
          },
        ],
      },
      db
    );
    expect(second.inserted).toBe(false);
  });

  it('getBookById returns null when missing', async () => {
    const { db } = mockDb({ aggregateResult: [] });
    await expect(getBookById('507f1f77bcf86cd799439011', {}, db)).resolves.toBeNull();
  });

  // F6.2 — webhook_events event-log ledger (Mongo leg; see also
  // tests/unit/webhook-event-log-dual-run.test.ts for the route-level
  // deliver-twice coverage).
  describe('webhook event-log ledger', () => {
    it('checkWebhookEventProcessed is false when no record exists', async () => {
      const { db, findOne } = mockDb({ findOneResult: null });
      await expect(checkWebhookEventProcessed('evt_1', db)).resolves.toEqual({
        processed: false,
      });
      expect(findOne).toHaveBeenCalledWith({ event_id: 'evt_1' }, { projection: { processed: 1 } });
    });

    it('checkWebhookEventProcessed is false when recorded but not yet processed', async () => {
      const { db } = mockDb({ findOneResult: { event_id: 'evt_1', processed: false } });
      await expect(checkWebhookEventProcessed('evt_1', db)).resolves.toEqual({
        processed: false,
      });
    });

    it('checkWebhookEventProcessed is true once marked processed', async () => {
      const { db } = mockDb({ findOneResult: { event_id: 'evt_1', processed: true } });
      await expect(checkWebhookEventProcessed('evt_1', db)).resolves.toEqual({
        processed: true,
      });
    });

    it('recordWebhookEvent upserts by event_id, setting event_type and processed:false', async () => {
      const { db, updateOne } = mockDb();
      await recordWebhookEvent({ id: 'evt_1', type: 'checkout.session.completed' }, db);
      expect(updateOne).toHaveBeenCalledWith(
        { event_id: 'evt_1' },
        {
          $setOnInsert: { event_id: 'evt_1', created_at: expect.any(Date) },
          $set: { event_type: 'checkout.session.completed', processed: false },
        },
        { upsert: true }
      );
    });

    it('markWebhookEventProcessed sets processed:true and clears error_message on success', async () => {
      const { db, updateOne } = mockDb();
      await markWebhookEventProcessed('evt_1', undefined, db);
      expect(updateOne).toHaveBeenCalledWith(
        { event_id: 'evt_1' },
        {
          $set: {
            processed: true,
            error_message: null,
            processed_at: expect.any(Date),
          },
        }
      );
    });

    it('markWebhookEventProcessed sets processed:false and records error_message on failure', async () => {
      const { db, updateOne } = mockDb();
      await markWebhookEventProcessed('evt_1', 'boom', db);
      expect(updateOne).toHaveBeenCalledWith(
        { event_id: 'evt_1' },
        {
          $set: {
            processed: false,
            error_message: 'boom',
            processed_at: expect.any(Date),
          },
        }
      );
    });
  });
});
