/** @jest-environment node */

/**
 * POST /api/checkout — WS2b dual-run session check.
 *
 * The route authenticates through getRequestUser() (Supabase today,
 * Better Auth after cutover) instead of a hard-wired Supabase client, and
 * still requires the session to match the requested user_id.
 */

import { POST } from '@/app/api/checkout/route';
import { getRequestUser } from '@/lib/api/request-user';
import { createCheckoutSession } from '@/lib/stripe/server';
import { fetchBookForApi } from '@/lib/data/books';
import type { NextRequest } from 'next/server';

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init: { status?: number } = {}) => ({
      status: init.status ?? 200,
      json: async () => body,
    }),
  },
}));
jest.mock('@/lib/api/request-user', () => ({ getRequestUser: jest.fn() }));
jest.mock('@/lib/stripe/server', () => ({ createCheckoutSession: jest.fn() }));
jest.mock('@/lib/data/books', () => ({ fetchBookForApi: jest.fn() }));

const mockedUser = getRequestUser as jest.MockedFunction<typeof getRequestUser>;
const mockedSession = createCheckoutSession as jest.MockedFunction<typeof createCheckoutSession>;
const mockedBook = fetchBookForApi as jest.MockedFunction<typeof fetchBookForApi>;

function request(body: unknown): NextRequest {
  return { json: jest.fn().mockResolvedValue(body) } as unknown as NextRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedBook.mockResolvedValue({
    id: 'book-1',
    slug: 'book-one',
    title: 'Book One',
    price: 12.5,
    discount_price: null,
  } as never);
  mockedSession.mockResolvedValue({ id: 'cs_123', url: 'https://stripe.example/cs_123' } as never);
});

describe('POST /api/checkout dual-run auth', () => {
  it('creates a session for the authenticated matching user', async () => {
    mockedUser.mockResolvedValue({ id: 'user-1', email: null, role: 'reader' });

    const response = await POST(request({ book_id: 'book-1', user_id: 'user-1' }));

    expect(response.status).toBe(200);
    expect(mockedSession).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));
  });

  it('401s when there is no session', async () => {
    mockedUser.mockResolvedValue(null);

    const response = await POST(request({ book_id: 'book-1', user_id: 'user-1' }));

    expect(response.status).toBe(401);
    expect(mockedSession).not.toHaveBeenCalled();
  });

  it("401s when the session user does not match the body's user_id", async () => {
    mockedUser.mockResolvedValue({ id: 'user-2', email: null, role: 'reader' });

    const response = await POST(request({ book_id: 'book-1', user_id: 'user-1' }));

    expect(response.status).toBe(401);
    expect(mockedSession).not.toHaveBeenCalled();
  });
});
