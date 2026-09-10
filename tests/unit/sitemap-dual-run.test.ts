/**
 * @jest-environment node
 *
 * Phoenix WS2d — sitemap catalog helpers route on DATABASE_PROVIDER, and both
 * providers skip slug-less books so /books/{id} 404s never enter the sitemap.
 */

jest.mock('mongodb', () => ({
  ObjectId: class ObjectId {
    id: string;
    constructor(id: string = '000000000000000000000000') {
      this.id = id;
    }
    toString() {
      return this.id;
    }
    static isValid(id: string) {
      return /^[a-fA-F0-9]{24}$/.test(id);
    }
  },
}));

const mockIsMongoPrimary = jest.fn(() => false);

jest.mock('@/lib/db/provider', () => ({
  isMongoPrimary: () => mockIsMongoPrimary(),
  getDatabaseProvider: () => (mockIsMongoPrimary() ? 'mongodb' : 'supabase'),
}));

jest.mock('@/lib/server-only-guard', () => ({}));

// Supabase branch — return three books, one slug-less; three authors, one blank pen_name.
const mockSupabaseFrom = jest.fn();
jest.mock('@/lib/supabase/public-queries', () => ({
  PUBLIC_AUTHOR_COLUMNS: 'id, pen_name',
  createPublicCatalogClient: () => ({ from: mockSupabaseFrom }),
}));

// Mongo branch stubs.
const mockGetDb = jest.fn();
jest.mock('@/lib/mongo', () => ({
  getDb: () => mockGetDb(),
}));

import { listBooksForSitemap } from '@/lib/data/books';
import { listAuthorsForSitemap } from '@/lib/data/authors';

function chainableSelect(rows: unknown[]) {
  return {
    select: () => ({
      eq: () => ({
        eq: () => ({
          order: () => ({
            range: async () => ({ data: rows, error: null }),
          }),
        }),
      }),
      order: async () => ({ data: rows, error: null }),
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('listBooksForSitemap (Supabase)', () => {
  it('skips slug-less rows and dedupes genres', async () => {
    mockIsMongoPrimary.mockReturnValue(false);
    mockSupabaseFrom.mockImplementation(() =>
      chainableSelect([
        { slug: 'a', genre: 'Fantasy', updated_at: '2026-01-01' },
        { slug: '', genre: 'Mystery', updated_at: '2026-01-02' }, // dropped
        { slug: 'b', genre: 'Fantasy', updated_at: '2026-01-03' },
      ])
    );

    const { books, genres } = await listBooksForSitemap();

    expect(books.map((b) => b.slug)).toEqual(['a', 'b']);
    expect(genres.sort()).toEqual(['Fantasy']);
  });
});

describe('listBooksForSitemap (Mongo)', () => {
  it('skips slug-less rows and stringifies ISO updated_at', async () => {
    mockIsMongoPrimary.mockReturnValue(true);
    const updatedAt = new Date('2026-02-02T00:00:00Z');
    mockGetDb.mockResolvedValue({
      collection: () => ({
        find: () => ({
          project: () => ({
            sort: () => ({
              toArray: async () => [
                { slug: 'x', genre: 'SciFi', updated_at: updatedAt },
                { slug: '  ', genre: 'Horror', updated_at: updatedAt }, // dropped
                { slug: 'y', genre: '', updated_at: updatedAt }, // no genre
              ],
            }),
          }),
        }),
      }),
    });

    const { books, genres } = await listBooksForSitemap();

    expect(books).toEqual([
      { slug: 'x', updated_at: updatedAt.toISOString(), genre: 'SciFi' },
      { slug: 'y', updated_at: updatedAt.toISOString(), genre: null },
    ]);
    expect(genres).toEqual(['SciFi']);
  });
});

describe('listAuthorsForSitemap (Supabase)', () => {
  it('skips rows with empty pen_name', async () => {
    mockIsMongoPrimary.mockReturnValue(false);
    mockSupabaseFrom.mockImplementation(() =>
      chainableSelect([
        { id: 'auth-1', pen_name: 'Real', updated_at: '2026-01-01' },
        { id: 'auth-2', pen_name: '   ', updated_at: '2026-01-02' }, // dropped
        { id: 'auth-3', pen_name: 'Real Two', updated_at: '2026-01-03' },
      ])
    );

    const authors = await listAuthorsForSitemap();

    expect(authors.map((a) => a.id)).toEqual(['auth-1', 'auth-3']);
  });
});
