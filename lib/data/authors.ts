/**
 * Dual-run author helpers (Phoenix WS2d.1 Slice B).
 * Default: Supabase. Mongo when DATABASE_PROVIDER=mongodb.
 */

import '@/lib/server-only-guard';

import { isMongoPrimary } from '@/lib/db/provider';

export type FeaturedAuthor = {
  id: string;
  pen_name: string;
  bio: string | null;
  total_books: number;
  is_verified: boolean;
  profile: { full_name: string | null } | null;
};

export type DirectoryAuthor = {
  id: string;
  profile_id: string;
  pen_name: string;
  bio: string | null;
  is_verified: boolean;
  total_books: number;
  photo_url: string | null;
  created_at: string;
  profile: { full_name: string | null } | null;
};

/**
 * Sitemap entries for every author. Skips rows with no id/pen_name so we
 * never emit /authors/undefined URLs.
 */
export type SitemapAuthorEntry = { id: string; updated_at: string };

export async function listAuthorsForSitemap(): Promise<SitemapAuthorEntry[]> {
  if (isMongoPrimary()) {
    try {
      const { getDb } = await import('@/lib/mongo');
      const db = await getDb();
      const rows = await db
        .collection('authors')
        .find({})
        .project({ pen_name: 1, updated_at: 1 })
        .sort({ updated_at: -1 })
        .toArray();
      return rows
        .filter((row) => row._id != null && typeof row.pen_name === 'string' && row.pen_name.trim())
        .map((row) => ({
          id: String(row._id),
          updated_at:
            row.updated_at instanceof Date
              ? row.updated_at.toISOString()
              : String(row.updated_at ?? new Date().toISOString()),
        }));
    } catch {
      return [];
    }
  }

  const { createPublicCatalogClient } = await import('@/lib/supabase/public-queries');
  const supabase = createPublicCatalogClient();
  const { data, error } = await supabase
    .from('authors')
    .select('id, pen_name, updated_at')
    .order('updated_at', { ascending: false });
  if (error || !data) return [];
  return data
    .filter((row) => row.id && typeof row.pen_name === 'string' && row.pen_name.trim())
    .map((row) => ({
      id: String(row.id),
      updated_at: String(row.updated_at ?? new Date().toISOString()),
    }));
}

/**
 * Public /authors directory — all authors ordered by total_books desc.
 */
export async function listAuthorsForDirectory(): Promise<DirectoryAuthor[]> {
  if (isMongoPrimary()) {
    try {
      const { getDb } = await import('@/lib/mongo');
      const db = await getDb();
      const rows = await db.collection('authors').find({}).sort({ total_books: -1 }).toArray();

      return rows.map((row) => {
        const pen = String(row.pen_name ?? 'Author');
        const created =
          row.created_at instanceof Date
            ? row.created_at.toISOString()
            : String(row.created_at ?? '');
        return {
          id: String(row._id),
          profile_id: row.profile_id != null ? String(row.profile_id) : '',
          pen_name: pen,
          bio: (row.bio as string | null | undefined) ?? null,
          is_verified: Boolean(row.is_verified),
          total_books: Number(row.total_books ?? 0),
          photo_url: (row.photo_url as string | null | undefined) ?? null,
          created_at: created,
          profile: { full_name: pen },
        };
      });
    } catch {
      return [];
    }
  }

  const { createPublicCatalogClient, PUBLIC_AUTHOR_COLUMNS } =
    await import('@/lib/supabase/public-queries');
  const supabase = createPublicCatalogClient();
  const { data } = await supabase
    .from('authors')
    .select(PUBLIC_AUTHOR_COLUMNS)
    .order('total_books', { ascending: false })
    .order('created_at', { ascending: false });

  return (data as unknown as DirectoryAuthor[]) || [];
}

/**
 * Homepage Author Spotlight — verified authors ordered by total_books.
 */
export async function listFeaturedAuthors(limit = 4): Promise<FeaturedAuthor[]> {
  if (isMongoPrimary()) {
    try {
      const { getDb } = await import('@/lib/mongo');
      const db = await getDb();
      const rows = await db
        .collection('authors')
        .find({ is_verified: true })
        .sort({ total_books: -1 })
        .limit(limit)
        .toArray();

      return rows.map((row) => ({
        id: String(row._id),
        pen_name: String(row.pen_name ?? 'Author'),
        bio: (row.bio as string | null | undefined) ?? null,
        total_books: Number(row.total_books ?? 0),
        is_verified: Boolean(row.is_verified),
        profile: {
          full_name: (row.pen_name as string | undefined) ?? null,
        },
      }));
    } catch {
      return [];
    }
  }

  const { createPublicCatalogClient } = await import('@/lib/supabase/public-queries');
  const supabase = createPublicCatalogClient();
  const { data, error } = await supabase
    .from('authors')
    .select('id, pen_name, bio, total_books, is_verified, profile:profiles(full_name)')
    .eq('is_verified', true)
    .order('total_books', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as unknown as FeaturedAuthor[]) || [];
}

export type AuthorDetail = FeaturedAuthor & {
  profile_id: string;
  photo_url?: string | null;
};

/** Author PDP by id (ObjectId hex or legacy UUID string). */
export async function fetchAuthorById(id: string): Promise<AuthorDetail | null> {
  if (isMongoPrimary()) {
    const { getDb } = await import('@/lib/mongo');
    const { ObjectId } = await import('mongodb');
    const db = await getDb();
    const key = /^[a-fA-F0-9]{24}$/.test(id) ? new ObjectId(id) : id;
    const row = await db.collection('authors').findOne({
      $or: [{ _id: key as never }, { _id: id as never }],
    });
    if (!row) return null;
    const pen = String(row.pen_name ?? 'Author');
    return {
      id: String(row._id),
      profile_id: row.profile_id != null ? String(row.profile_id) : '',
      pen_name: pen,
      bio: (row.bio as string | null | undefined) ?? null,
      total_books: Number(row.total_books ?? 0),
      is_verified: Boolean(row.is_verified),
      photo_url: (row.photo_url as string | null | undefined) ?? null,
      profile: { full_name: pen },
    };
  }

  const { createPublicCatalogClient, PUBLIC_AUTHOR_COLUMNS } =
    await import('@/lib/supabase/public-queries');
  const supabase = createPublicCatalogClient();
  const { data } = await supabase
    .from('authors')
    .select(PUBLIC_AUTHOR_COLUMNS)
    .eq('id', id)
    .single();
  if (!data) return null;
  const row = data as unknown as AuthorDetail & { photo_url?: string | null };
  return {
    id: String(row.id),
    profile_id: String(row.profile_id ?? ''),
    pen_name: row.pen_name,
    bio: row.bio ?? null,
    total_books: Number(row.total_books ?? 0),
    is_verified: Boolean(row.is_verified),
    photo_url: row.photo_url ?? null,
    profile: row.profile ?? { full_name: row.pen_name },
  };
}

/** Published public books for an author (by author id on Mongo; by profile_id on Supabase). */
export async function listPublishedBooksForAuthor(opts: {
  authorId: string;
  profileId?: string;
}): Promise<unknown[]> {
  if (isMongoPrimary()) {
    const { getBooks } = await import('@/lib/mongo-queries');
    const result = await getBooks(
      { status: 'published', visibility: 'public', authorId: opts.authorId },
      { page: 1, perPage: 60 }
    );
    return result.items.map((b) => ({
      id: String(b._id),
      title: b.title,
      slug: b.slug,
      cover_url: b.cover_url ?? null,
      price: b.price ?? null,
      genre: b.genre ?? null,
      author_id: String(b.author_id),
      status: b.status,
      visibility: b.visibility,
      created_at:
        b.created_at instanceof Date ? b.created_at.toISOString() : String(b.created_at ?? ''),
      updated_at:
        b.updated_at instanceof Date ? b.updated_at.toISOString() : String(b.updated_at ?? ''),
      author: b.author
        ? {
            id: String(b.author._id),
            pen_name: b.author.pen_name,
            profile: { full_name: b.author.pen_name },
          }
        : null,
    }));
  }

  const { createPublicCatalogClient, PUBLIC_AUTHOR_COLUMNS } =
    await import('@/lib/supabase/public-queries');
  const supabase = createPublicCatalogClient();
  const profileId = opts.profileId;
  if (!profileId) return [];

  const { data } = await supabase
    .from('books')
    .select(`*, author:authors!inner(${PUBLIC_AUTHOR_COLUMNS})`)
    .eq('status', 'published')
    .eq('visibility', 'public')
    .eq('author.profile_id', profileId)
    .order('published_at', { ascending: false });

  return (data as unknown[]) || [];
}
