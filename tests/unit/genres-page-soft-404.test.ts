/**
 * @jest-environment node
 *
 * Phoenix WS2d — /genres/[genre] soft-404 (E-018).
 *
 * generateMetadata must set robots.index=false when the genre has zero
 * published books, so arbitrary /genres/{typo} URLs render the friendly
 * "browse all" fallback for humans without polluting the search index with
 * thin-content pages.
 */

// React 18's cache() ships in the server bundle; the Jest env resolves the
// browser react entry which doesn't export it. Pass-through is fine — the
// helper is only a dedupe, not a semantic requirement.
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  cache: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

jest.mock('mongodb', () => ({
  ObjectId: class ObjectId {
    constructor(public id: string = '000000000000000000000000') {}
    toString() {
      return this.id;
    }
  },
}));

jest.mock('@/lib/db/provider', () => ({
  isMongoPrimary: () => false,
  getDatabaseProvider: () => 'supabase',
}));

jest.mock('@/lib/server-only-guard', () => ({}));

const mockListBooksByGenreParam = jest.fn();
jest.mock('@/lib/data/books', () => ({
  listBooksByGenreParam: (...args: unknown[]) => mockListBooksByGenreParam(...args),
}));

import { generateMetadata } from '@/app/(consumer)/genres/[genre]/page';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('/genres/[genre] generateMetadata soft-404', () => {
  const params = Promise.resolve({ genre: 'fantasy' });

  it('noindexes when the genre has zero published books', async () => {
    mockListBooksByGenreParam.mockResolvedValue([]);
    const meta = await generateMetadata({ params });
    expect(meta.robots).toEqual({ index: false, follow: true });
  });

  it('leaves robots undefined (site-default indexable) when books exist', async () => {
    mockListBooksByGenreParam.mockResolvedValue([{ id: 'b1', title: 'A', slug: 'a' }]);
    const meta = await generateMetadata({ params });
    expect(meta.robots).toBeUndefined();
  });
});
