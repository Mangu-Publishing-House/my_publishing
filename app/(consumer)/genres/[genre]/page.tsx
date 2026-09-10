import { cache } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { BookOpen, ArrowLeft } from 'lucide-react';
import { listBooksByGenreParam } from '@/lib/data/books';
import type { Metadata } from 'next';

interface GenrePageProps {
  params: Promise<{
    genre: string;
  }>;
}

// One request-scoped fetch shared by generateMetadata and the page body —
// noindexing empty genres would otherwise cost a second query per request.
const getBooksForGenre = cache((genre: string) => listBooksByGenreParam(genre));

export async function generateMetadata({ params }: GenrePageProps): Promise<Metadata> {
  const { genre: genreParam } = await params;
  const genreName = decodeURIComponent(genreParam);
  const displayName = genreName.charAt(0).toUpperCase() + genreName.slice(1);
  const books = await getBooksForGenre(genreName);

  return {
    title: `${displayName} Books | MANGU Publishers`,
    description: `Browse ${displayName.toLowerCase()} books on MANGU Publishers. Discover new titles and bestsellers in ${displayName.toLowerCase()}.`,
    // Soft-404 for search engines: any /genres/{arbitrary} still renders the
    // browse-all fallback UI for humans, but doesn't add a thin-content page
    // to the index. Real genres flip back to the site default of indexable.
    robots: books.length === 0 ? { index: false, follow: true } : undefined,
  };
}

export default async function GenrePage({ params }: GenrePageProps) {
  const { genre: genreParam } = await params;
  const genreName = decodeURIComponent(genreParam);
  const books = await getBooksForGenre(genreName);
  const displayName = genreName.charAt(0).toUpperCase() + genreName.slice(1);

  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Header */}
      <div className="border-b border-zinc-800 bg-zinc-900/50">
        <div className="container mx-auto px-4 py-8">
          <Link
            href="/genres"
            className="mb-4 inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            All Genres
          </Link>
          <h1 className="text-3xl font-bold text-white md:text-4xl">{displayName}</h1>
          <p className="mt-2 text-zinc-400">
            {books.length} {books.length === 1 ? 'book' : 'books'} available
          </p>
        </div>
      </div>

      {/* Books Grid */}
      <div className="container mx-auto px-4 py-8">
        {books.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <BookOpen className="mb-4 h-16 w-16 text-zinc-600" />
            <h2 className="text-xl font-semibold text-white">No books found</h2>
            <p className="mt-2 text-zinc-400">There are no books in the {displayName} genre yet.</p>
            <Link
              href="/books"
              className="mt-6 rounded-lg bg-amber-500 px-6 py-2.5 font-medium text-black transition-colors hover:bg-amber-400"
            >
              Browse All Books
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {books.map((book) => {
              const author = book.author as
                | {
                    pen_name?: string | null;
                    full_name?: string | null;
                    profile?: { full_name?: string | null } | null;
                  }
                | null
                | undefined;
              const authorName =
                author?.profile?.full_name ||
                author?.full_name ||
                author?.pen_name ||
                (typeof book.author_name === 'string' ? book.author_name : null);
              const price = typeof book.price === 'number' ? book.price : null;

              return (
                <Link key={book.id} href={`/books/${book.slug || book.id}`} className="group">
                  <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-zinc-800">
                    {book.cover_url ? (
                      <Image
                        src={book.cover_url}
                        alt={book.title}
                        fill
                        className="object-cover transition-transform duration-300 group-hover:scale-105"
                        sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 16vw"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <BookOpen className="h-12 w-12 text-zinc-600" />
                      </div>
                    )}
                    {/* Hover overlay */}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100">
                      <div className="absolute bottom-0 left-0 right-0 p-3">
                        <p className="line-clamp-2 text-sm font-medium text-white">{book.title}</p>
                        {authorName && (
                          <p className="mt-1 truncate text-xs text-zinc-300">{authorName}</p>
                        )}
                        {price != null && (
                          <p className="mt-1 text-sm font-semibold text-amber-400">
                            ${price.toFixed(2)}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                  {/* Mobile-visible title */}
                  <div className="mt-2 md:hidden">
                    <p className="line-clamp-1 text-sm font-medium text-white">{book.title}</p>
                    {authorName && <p className="truncate text-xs text-zinc-400">{authorName}</p>}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
