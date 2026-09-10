import { MetadataRoute } from 'next';
// Phoenix WS2d — dual-run catalog reads (E-012).
import { listBooksForSitemap } from '@/lib/data/books';
import { listAuthorsForSitemap } from '@/lib/data/authors';
import { getSiteUrl } from '@/lib/seo/siteUrl';
import { FEATURE_COMICS, FEATURE_PAPERS, FEATURE_AUDIO } from '@/lib/flags';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = getSiteUrl();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: baseUrl, lastModified: new Date(), changeFrequency: 'daily', priority: 1.0 },
    { url: `${baseUrl}/books`, lastModified: new Date(), changeFrequency: 'daily', priority: 0.95 },
    // Flag-off contract: excluded from sitemap when feature is disabled (P-057)
    ...(FEATURE_COMICS
      ? [
          {
            url: `${baseUrl}/comics`,
            lastModified: new Date(),
            changeFrequency: 'weekly' as const,
            priority: 0.8,
          },
        ]
      : []),
    ...(FEATURE_PAPERS
      ? [
          {
            url: `${baseUrl}/papers`,
            lastModified: new Date(),
            changeFrequency: 'weekly' as const,
            priority: 0.75,
          },
        ]
      : []),
    ...(FEATURE_AUDIO
      ? [
          {
            url: `${baseUrl}/audio`,
            lastModified: new Date(),
            changeFrequency: 'weekly' as const,
            priority: 0.75,
          },
        ]
      : []),
    {
      url: `${baseUrl}/authors`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: `${baseUrl}/discover`,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 0.9,
    },
    {
      url: `${baseUrl}/recommendations`,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 0.8,
    },
    {
      url: `${baseUrl}/discover/recommendations`,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 0.8,
    },
    {
      url: `${baseUrl}/book-clubs`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.7,
    },
    {
      url: `${baseUrl}/discover/book-clubs`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.7,
    },
    {
      url: `${baseUrl}/genres`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.85,
    },
    {
      url: `${baseUrl}/readers-hub`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.7,
    },
    {
      url: `${baseUrl}/about`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.6,
    },
    {
      url: `${baseUrl}/contact`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.6,
    },
    {
      url: `${baseUrl}/terms`,
      lastModified: new Date(),
      changeFrequency: 'yearly',
      priority: 0.4,
    },
    {
      url: `${baseUrl}/privacy`,
      lastModified: new Date(),
      changeFrequency: 'yearly',
      priority: 0.4,
    },
    {
      url: `${baseUrl}/cookies`,
      lastModified: new Date(),
      changeFrequency: 'yearly',
      priority: 0.35,
    },
    {
      url: `${baseUrl}/help`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.65,
    },
    {
      url: `${baseUrl}/faqs`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.6,
    },
    {
      url: `${baseUrl}/careers`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.45,
    },
    // /blog excluded: no real posts exist yet (P-004 — MISLEADING state)
    {
      url: `${baseUrl}/press`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.45,
    },
  ];

  let bookRoutes: MetadataRoute.Sitemap = [];
  let genreRoutes: MetadataRoute.Sitemap = [];
  try {
    const { books, genres } = await listBooksForSitemap();
    // Slug-less books skipped upstream — /books/{id} URLs 404 against the
    // slug-only PDP lookup, so emitting them tanks crawler trust.
    bookRoutes = books.map((book) => ({
      url: `${baseUrl}/books/${book.slug}`,
      lastModified: new Date(book.updated_at),
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    }));
    genreRoutes = genres.map((genre) => ({
      url: `${baseUrl}/genres/${encodeURIComponent(genre)}`,
      lastModified: new Date(),
      changeFrequency: 'weekly' as const,
      priority: 0.75,
    }));
  } catch (e) {
    console.error('Sitemap: books fetch failed', e);
  }

  let authorRoutes: MetadataRoute.Sitemap = [];
  try {
    const authors = await listAuthorsForSitemap();
    authorRoutes = authors.map((author) => ({
      url: `${baseUrl}/authors/${author.id}`,
      lastModified: new Date(author.updated_at),
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    }));
  } catch (e) {
    console.error('Sitemap: authors fetch failed', e);
  }

  return [...staticRoutes, ...bookRoutes, ...genreRoutes, ...authorRoutes];
}
