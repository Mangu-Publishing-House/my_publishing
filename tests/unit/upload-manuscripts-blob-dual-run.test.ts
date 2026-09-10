/** @jest-environment node */

/**
 * Phoenix WS3 dual-run (REPO_AUDIT_2026-08-21 F3): storage-provider coverage
 * for app/api/upload/route.ts (generic manuscript documents: PDF/Word/txt).
 * The pre-existing Supabase-leg regression test lives in
 * tests/unit/api-route-hardening.test.ts ("rejects unsupported upload MIME
 * types before storage access") and is left unmodified by this PR — it
 * fails validation before either storage branch runs, so behavior there is
 * unchanged. This route's Supabase leg has never been content-addressed
 * (`${userId}/${Date.now()}.${ext}`, no dedup) — the Blob leg deliberately
 * keeps that same timestamp-based naming instead of introducing dedup
 * semantics this route has never had (see PR body).
 */
import { POST } from '@/app/api/upload/route';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@/lib/supabase/admin';
import { isBlobPrimary } from '@/lib/storage/provider';
import type { NextRequest } from 'next/server';

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init: { status?: number } = {}) => ({
      status: init.status ?? 200,
      json: async () => body,
    }),
  },
}));
jest.mock('@/lib/supabase/server', () => ({ createClient: jest.fn() }));
jest.mock('@/lib/supabase/admin', () => ({ createClient: jest.fn() }));
jest.mock('@/lib/storage/provider', () => ({ isBlobPrimary: jest.fn() }));
jest.mock('@vercel/blob', () => ({ put: jest.fn() }));

const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;
const mockedCreateAdminClient = createAdminClient as jest.MockedFunction<typeof createAdminClient>;
const mockedIsBlobPrimary = isBlobPrimary as jest.MockedFunction<typeof isBlobPrimary>;
const { put: mockedPut } = jest.requireMock('@vercel/blob') as { put: jest.Mock };

function uploadRequest(file: File): NextRequest {
  const formData = new FormData();
  formData.set('file', file);
  return { formData: jest.fn().mockResolvedValue(formData) } as unknown as NextRequest;
}

describe('POST /api/upload — manuscript storage dual-run', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedCreateClient.mockResolvedValue({
      auth: { getUser: jest.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
    } as never);
  });

  it('uploads to Vercel Blob with timestamp-based naming and never touches the Supabase admin client when STORAGE_PROVIDER=vercel-blob', async () => {
    mockedIsBlobPrimary.mockReturnValue(true);
    mockedPut.mockResolvedValue({
      url: 'https://example.public.blob.vercel-storage.com/manuscript.pdf',
    });

    const file = new File(['%PDF-1.4'], 'manuscript.pdf', { type: 'application/pdf' });
    const response = await POST(uploadRequest(file));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockedPut).toHaveBeenCalledTimes(1);
    const [path, , options] = mockedPut.mock.calls[0];
    // Same naming convention as the Supabase leg (`${userId}/${Date.now()}.${ext}`),
    // scoped under a manuscripts/ segment since Blob has a single flat namespace.
    expect(path).toMatch(/^user-1\/manuscripts\/\d+\.pdf$/);
    expect(options).toEqual(
      expect.objectContaining({
        access: 'public',
        contentType: 'application/pdf',
        addRandomSuffix: false,
      })
    );
    expect(mockedCreateAdminClient).not.toHaveBeenCalled();
    expect(payload.url).toBe('https://example.public.blob.vercel-storage.com/manuscript.pdf');
  });

  it('still uses the untouched Supabase leg when STORAGE_PROVIDER=supabase (default)', async () => {
    mockedIsBlobPrimary.mockReturnValue(false);
    const upload = jest.fn().mockResolvedValue({ error: null });
    const getPublicUrl = jest
      .fn()
      .mockReturnValue({ data: { publicUrl: 'https://supabase.example/manuscript.pdf' } });
    mockedCreateAdminClient.mockReturnValue({
      storage: { from: jest.fn(() => ({ upload, getPublicUrl })) },
    } as never);

    const file = new File(['%PDF-1.4'], 'manuscript.pdf', { type: 'application/pdf' });
    const response = await POST(uploadRequest(file));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockedPut).not.toHaveBeenCalled();
    expect(mockedCreateAdminClient).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalled();
    expect(payload.url).toBe('https://supabase.example/manuscript.pdf');
  });

  it('rejects unsupported MIME types before either storage branch runs, in Blob mode too', async () => {
    mockedIsBlobPrimary.mockReturnValue(true);
    const file = new File(['payload'], 'payload.exe', { type: 'application/x-msdownload' });

    const response = await POST(uploadRequest(file));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/Unsupported file type/);
    expect(mockedPut).not.toHaveBeenCalled();
    expect(mockedCreateAdminClient).not.toHaveBeenCalled();
  });
});
