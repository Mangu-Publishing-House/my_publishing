import { NextRequest, NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/api/request-user';
import { createCheckoutSession } from '@/lib/stripe/server';
import { fetchBookForApi } from '@/lib/data/books';
import type { CheckoutSessionRequest, CheckoutSessionResponse } from '@/types';

export async function POST(request: NextRequest) {
  try {
    let body: CheckoutSessionRequest;
    try {
      body = (await request.json()) as CheckoutSessionRequest;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { book_id, book_slug, user_id } = body;

    if ((!book_id && !book_slug) || !user_id) {
      return NextResponse.json(
        { error: 'book_id (or book_slug) and user_id are required' },
        { status: 400 }
      );
    }

    // Dual-run session check (WS2b): the shim resolves Supabase today and
    // Better Auth after cutover — its supabase branch performs the same
    // getUser() this route did directly, so behavior is identical in prod.
    const user = await getRequestUser();
    if (!user || user.id !== user_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const book = await fetchBookForApi({
      id: book_id || undefined,
      slug: book_slug || undefined,
    });

    if (!book) {
      return NextResponse.json({ error: 'Book not found' }, { status: 404 });
    }

    const price =
      typeof book.discount_price === 'number' && book.discount_price > 0
        ? book.discount_price
        : Number(book.price ?? 0);

    const session = await createCheckoutSession({
      bookId: book.id,
      bookSlug: book.slug,
      userId: user_id,
      bookTitle: book.title,
      price,
    });

    const response: CheckoutSessionResponse = {
      sessionId: session.id,
      url: session.url || '',
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Checkout error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
