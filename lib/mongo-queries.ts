/**
 * Centralized MongoDB query helpers (Phoenix WS2a Task 2a.3).
 *
 * Server-only. Accepts an optional `Db` for unit tests; production callers
 * omit it and use the cached singleton via `getDb()`.
 */

import '@/lib/server-only-guard';

import { ObjectId, type Db, type Document, type Filter } from 'mongodb';
import { getDb } from '@/lib/mongo';
import {
  MONGO_BOOK_EXTRA_WRITE_FIELDS,
  visibilityForStatus,
  type ContentType,
  type RetailerUrlField,
} from '@/lib/books/fields';
import type { Book, BookWithAuthor, MongoPagination, Order, PaginatedResult } from '@/types/mongo';

export const DEFAULT_PAGE_SIZE = 20;

/** Prefer ObjectId when the string is a 24-char hex id (Atlas imports). */
function coerceId(id: string): ObjectId | string {
  return /^[a-fA-F0-9]{24}$/.test(id) ? new ObjectId(id) : id;
}

/**
 * Match `_id` whether stored as ObjectId or legacy string UUID.
 * Driver Filter typings assume ObjectId-only `_id`; cast via unknown.
 */
function idMatchFilter(id: string): Filter<Document> {
  const coerced = coerceId(id);
  const filter =
    coerced instanceof ObjectId ? { $or: [{ _id: coerced }, { _id: id }] } : { _id: id };
  return filter as unknown as Filter<Document>;
}

export type GetBooksFilters = {
  status?: Book['status'];
  authorId?: string;
  genre?: string;
  visibility?: Book['visibility'];
};

export type SearchBooksOptions = MongoPagination & {
  /** Restrict to published by default for storefront search. */
  status?: Book['status'];
  visibility?: Book['visibility'];
};

function normalizePagination(opts: MongoPagination = {}): {
  page: number;
  perPage: number;
  skip: number;
} {
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const perPage = Math.min(100, Math.max(1, Math.floor(opts.perPage ?? DEFAULT_PAGE_SIZE)));
  return { page, perPage, skip: (page - 1) * perPage };
}

function toPaginatedResult<T>(
  items: T[],
  total: number,
  page: number,
  perPage: number
): PaginatedResult<T> {
  const totalPages = total === 0 ? 0 : Math.ceil(total / perPage);
  return {
    items,
    total,
    page,
    perPage,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1 && totalPages > 0,
  };
}

async function resolveDb(db?: Db): Promise<Db> {
  return db ?? getDb();
}

function authorLookupStages(): Document[] {
  return [
    {
      $lookup: {
        from: 'authors',
        localField: 'author_id',
        foreignField: '_id',
        as: '_authors',
      },
    },
    {
      $addFields: {
        author: { $ifNull: [{ $arrayElemAt: ['$_authors', 0] }, null] },
      },
    },
    { $project: { _authors: 0 } },
  ];
}

/**
 * Paginated book list with author `$lookup` (default 20 per page).
 */
export async function getBooks(
  filters: GetBooksFilters = {},
  pagination: MongoPagination = {},
  db?: Db
): Promise<PaginatedResult<BookWithAuthor>> {
  const database = await resolveDb(db);
  const { page, perPage, skip } = normalizePagination(pagination);

  const match: Filter<Document> = {};
  if (filters.status) match.status = filters.status;
  if (filters.genre) match.genre = filters.genre;
  if (filters.visibility) match.visibility = filters.visibility;
  if (filters.authorId) match.author_id = coerceId(filters.authorId);

  const pipeline: Document[] = [
    { $match: match },
    { $sort: { created_at: -1 } },
    {
      $facet: {
        items: [{ $skip: skip }, { $limit: perPage }, ...authorLookupStages()],
        total: [{ $count: 'count' }],
      },
    },
  ];

  const [facet] = await database.collection('books').aggregate(pipeline).toArray();
  const items = (facet?.items ?? []) as BookWithAuthor[];
  const total = Number(facet?.total?.[0]?.count ?? 0);
  return toPaginatedResult(items, total, page, perPage);
}

/**
 * Single book by id (ObjectId hex or legacy string UUID), with author join.
 */
export async function getBookById(
  id: string,
  options: { status?: Book['status']; visibility?: Book['visibility'] } = {},
  db?: Db
): Promise<BookWithAuthor | null> {
  const database = await resolveDb(db);
  const andClauses: Filter<Document>[] = [idMatchFilter(id)];
  if (options.status) andClauses.push({ status: options.status });
  if (options.visibility) andClauses.push({ visibility: options.visibility });

  const pipeline: Document[] = [
    { $match: andClauses.length === 1 ? andClauses[0] : { $and: andClauses } },
    ...authorLookupStages(),
    { $limit: 1 },
  ];

  const [doc] = await database.collection('books').aggregate(pipeline).toArray();
  return (doc as BookWithAuthor | undefined) ?? null;
}

/**
 * Catalog fields beyond the core columns (audio, retailer links, ISBN...).
 * Mirrors `AdminBookWriteInput` in `lib/mongo-books.ts`; declared locally so the
 * API path carries no dependency on the admin write module.
 */
type BookCatalogWriteFields = Partial<{
  content_type: ContentType;
  isbn: string | null;
  epub_url: string | null;
  audio_url: string | null;
  audio_toc: unknown;
  audio_narrator: string | null;
  audio_duration_seconds: number | null;
  trailer_vimeo_id: string | null;
  is_featured: boolean;
  page_count: number | null;
  word_count: number | null;
  tags: string[];
}> &
  Partial<Record<RetailerUrlField, string | null>>;

/**
 * `published_at` is derived from the status transition, never taken from the
 * caller, so it is excluded from the copied keys.
 */
const CATALOG_WRITE_FIELDS: readonly string[] = MONGO_BOOK_EXTRA_WRITE_FIELDS.filter(
  (field) => field !== 'published_at'
);

/** Core columns a book write may set, in addition to `CATALOG_WRITE_FIELDS`. */
const CORE_WRITE_FIELDS: readonly string[] = [
  'title',
  'slug',
  'description',
  'genre',
  'price',
  'currency',
  'status',
  'visibility',
  'cover_url',
  'manuscript_url',
];

/** Copy only supplied, whitelisted keys; `undefined` leaves the stored value alone. */
function assignWriteFields(target: Document, input: Record<string, unknown>): void {
  for (const key of [...CORE_WRITE_FIELDS, ...CATALOG_WRITE_FIELDS]) {
    if (input[key] !== undefined) target[key] = input[key];
  }
}

/**
 * Insert a book document. Returns the inserted id as string.
 */
export async function createBook(
  input: {
    title: string;
    slug: string;
    author_id: string;
    description?: string;
    genre?: string;
    price?: number;
    currency?: string;
    status?: Book['status'];
    visibility?: Book['visibility'];
    cover_url?: string | null;
    manuscript_url?: string | null;
  } & BookCatalogWriteFields,
  db?: Db
): Promise<string> {
  const database = await resolveDb(db);
  const now = new Date();
  const status = input.status ?? 'draft';
  const doc: Document = {
    title: input.title,
    slug: input.slug,
    description: input.description ?? '',
    author_id: coerceId(input.author_id),
    genre: input.genre,
    price: input.price ?? 0,
    currency: input.currency ?? 'usd',
    status,
    // Derived from status unless pinned: a book created as published has to be
    // publicly visible, otherwise the storefront queries skip it forever.
    visibility: input.visibility ?? visibilityForStatus(status),
    cover_url: input.cover_url ?? null,
    manuscript_url: input.manuscript_url ?? null,
    tags: input.tags ?? [],
    avg_rating: 0,
    review_count: 0,
    published_at: status === 'published' ? now : null,
    created_at: now,
    updated_at: now,
  };
  for (const key of CATALOG_WRITE_FIELDS) {
    const value = (input as Record<string, unknown>)[key];
    if (value !== undefined) doc[key] = value;
  }
  const result = await database.collection('books').insertOne(doc);
  return String(result.insertedId);
}

/**
 * Patch a book by id. Returns false when no document matched.
 */
export async function updateBook(
  id: string,
  patch: Partial<{
    title: string;
    slug: string;
    description: string;
    genre: string;
    price: number;
    currency: string;
    status: Book['status'];
    visibility: Book['visibility'];
    cover_url: string | null;
    manuscript_url: string | null;
  }> &
    BookCatalogWriteFields,
  db?: Db
): Promise<boolean> {
  const database = await resolveDb(db);
  const filter = idMatchFilter(id);

  const $set: Document = { updated_at: new Date() };
  assignWriteFields($set, patch as Record<string, unknown>);

  if (patch.status !== undefined && patch.visibility === undefined) {
    $set.visibility = visibilityForStatus(patch.status);
  }

  // Stamped on the first publication only: unpublishing must not erase the date
  // the book originally went live.
  if (patch.status === 'published') {
    const current = await database
      .collection('books')
      .findOne(filter, { projection: { published_at: 1 } });
    if (!current?.published_at) {
      $set.published_at = new Date();
    }
  }

  const result = await database.collection('books').updateOne(filter, { $set });
  return result.matchedCount > 0;
}

export type UpsertOrderInput = {
  user_id: string;
  stripe_payment_intent_id: string;
  stripe_session_id?: string;
  amount: number;
  currency: string;
  order_items: Order['order_items'];
};

/**
 * Idempotent order upsert by `stripe_payment_intent_id` (WS2b.1.4).
 * Returns `{ inserted: true }` on first write, `{ inserted: false }` on duplicate.
 */
export async function upsertOrderByPaymentIntent(
  input: UpsertOrderInput,
  db?: Db
): Promise<{ inserted: boolean; orderId: string }> {
  const database = await resolveDb(db);
  const now = new Date();
  const filter = { stripe_payment_intent_id: input.stripe_payment_intent_id };

  const result = await database.collection('orders').updateOne(
    filter,
    {
      $setOnInsert: {
        user_id: input.user_id,
        status: 'completed',
        amount: input.amount,
        currency: input.currency,
        order_items: input.order_items,
        stripe_session_id: input.stripe_session_id ?? null,
        stripe_payment_intent_id: input.stripe_payment_intent_id,
        created_at: now,
        updated_at: now,
      },
    },
    { upsert: true }
  );

  const doc = await database.collection('orders').findOne(filter);
  const orderId = doc?._id ? String(doc._id) : '';
  return { inserted: Boolean(result.upsertedCount), orderId };
}

/**
 * Mongo leg of the Stripe webhook event-log idempotency ledger (F6.2 /
 * docs/REPO_AUDIT_2026-08-21.md). Distinct from order-level idempotency
 * (`upsertOrderByPaymentIntent` above) — this tracks "have we seen Stripe
 * event id X before" independent of which order it maps to. Mirrors the
 * Supabase `webhook_events` helpers in `app/api/webhook/route.ts`
 * (`checkIdempotency` / `recordWebhookEvent` / `markEventProcessed`); relies
 * on the unique index on `event_id` (`webhook_events_event_id_uq`,
 * scripts/mongo-ensure-indexes.ts).
 */

/**
 * Has this Stripe event id already been fully processed?
 */
export async function checkWebhookEventProcessed(
  eventId: string,
  db?: Db
): Promise<{ processed: boolean }> {
  const database = await resolveDb(db);
  const existing = await database
    .collection('webhook_events')
    .findOne({ event_id: eventId }, { projection: { processed: 1 } });
  return { processed: Boolean(existing?.processed) };
}

/**
 * Record (or re-record, pre-processing) a received webhook event. Upsert by
 * `event_id`: `created_at` is set only on first sight; `event_type` and
 * `processed: false` are (re)written every call, matching the Supabase
 * `upsert(..., { onConflict: 'event_id' })` semantics this replaces.
 */
export async function recordWebhookEvent(
  event: { id: string; type: string },
  db?: Db
): Promise<void> {
  const database = await resolveDb(db);
  await database.collection('webhook_events').updateOne(
    { event_id: event.id },
    {
      $setOnInsert: {
        event_id: event.id,
        created_at: new Date(),
      },
      $set: {
        event_type: event.type,
        processed: false,
      },
    },
    { upsert: true }
  );
}

/**
 * Mark a recorded event processed (or failed, when `error` is set).
 */
export async function markWebhookEventProcessed(
  eventId: string,
  error?: string,
  db?: Db
): Promise<void> {
  const database = await resolveDb(db);
  await database.collection('webhook_events').updateOne(
    { event_id: eventId },
    {
      $set: {
        processed: !error,
        error_message: error ?? null,
        processed_at: new Date(),
      },
    }
  );
}

/**
 * Single book by slug, with author join. Returns null when not found.
 */
export async function getBookBySlug(
  slug: string,
  options: { status?: Book['status'] } = {},
  db?: Db
): Promise<BookWithAuthor | null> {
  const database = await resolveDb(db);
  const match: Filter<Document> = { slug };
  if (options.status) match.status = options.status;

  const pipeline: Document[] = [{ $match: match }, ...authorLookupStages(), { $limit: 1 }];

  const [doc] = await database.collection('books').aggregate(pipeline).toArray();
  return (doc as BookWithAuthor | undefined) ?? null;
}

/**
 * Orders for a user, newest first (default 20 per page).
 */
export async function getUserOrders(
  userId: string,
  pagination: MongoPagination = {},
  db?: Db
): Promise<PaginatedResult<Order>> {
  const database = await resolveDb(db);
  const { page, perPage, skip } = normalizePagination(pagination);

  const filter: Filter<Document> = { user_id: userId };
  const collection = database.collection('orders');

  const [total, items] = await Promise.all([
    collection.countDocuments(filter),
    collection.find(filter).sort({ created_at: -1 }).skip(skip).limit(perPage).toArray() as Promise<
      Order[]
    >,
  ]);

  return toPaginatedResult(items, total, page, perPage);
}

/**
 * Full-text book search (`$text`) sorted by text score (default 20 per page).
 * Requires the books text index from `npm run db:mongo:indexes`.
 */
export async function searchBooks(
  query: string,
  options: SearchBooksOptions = {},
  db?: Db
): Promise<PaginatedResult<BookWithAuthor>> {
  const database = await resolveDb(db);
  const { page, perPage, skip } = normalizePagination(options);
  const trimmed = query.trim();
  if (!trimmed) {
    return toPaginatedResult([], 0, page, perPage);
  }

  const match: Filter<Document> = {
    $text: { $search: trimmed },
  };
  if (options.status) match.status = options.status;
  if (options.visibility) match.visibility = options.visibility;

  const pipeline: Document[] = [
    { $match: match },
    { $addFields: { score: { $meta: 'textScore' } } },
    { $sort: { score: { $meta: 'textScore' } } },
    {
      $facet: {
        items: [{ $skip: skip }, { $limit: perPage }, ...authorLookupStages()],
        total: [{ $count: 'count' }],
      },
    },
  ];

  const [facet] = await database.collection('books').aggregate(pipeline).toArray();
  const items = (facet?.items ?? []) as BookWithAuthor[];
  const total = Number(facet?.total?.[0]?.count ?? 0);
  return toPaginatedResult(items, total, page, perPage);
}
