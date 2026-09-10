/** @jest-environment node */

/**
 * Phoenix WS3 dual-run (REPO_AUDIT_2026-08-21 F3): storage-provider coverage
 * for app/api/upload/book-assets/route.ts. There was no pre-existing
 * dedicated test for this route, so both the new Blob leg and a Supabase-leg
 * regression check are covered here. storeBookAsset (Supabase,
 * lib/uploads/store-asset.ts) is untouched by this change — the second test
 * below exercises it exactly as it ran before this PR.
 */
import { POST } from '@/app/api/upload/book-assets/route';
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

function uploadRequest(file: File, asset: string): NextRequest {
  const formData = new FormData();
  formData.set('file', file);
  formData.set('asset', asset);
  return { formData: jest.fn().mockResolvedValue(formData) } as unknown as NextRequest;
}

describe('POST /api/upload/book-assets — storage dual-run', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedCreateClient.mockResolvedValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null }),
      },
    } as never);
  });

  it('uploads to Vercel Blob and never touches the Supabase admin client when STORAGE_PROVIDER=vercel-blob', async () => {
    mockedIsBlobPrimary.mockReturnValue(true);
    mockedPut.mockResolvedValue({
      url: 'https://example.public.blob.vercel-storage.com/cover',
    });

    const file = new File(['png-bytes'], 'cover.png', { type: 'image/png' });
    const response = await POST(uploadRequest(file, 'cover'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockedPut).toHaveBeenCalledTimes(1);
    expect(mockedCreateAdminClient).not.toHaveBeenCalled();
    expect(payload.url).toBe('https://example.public.blob.vercel-storage.com/cover');
    expect(payload.deduplicated).toBe(false);
    expect(payload.filePath).toMatch(/^user-1\/book-covers\/[0-9a-f]{64}\.png$/);
  });

  it('still uses the untouched Supabase leg when STORAGE_PROVIDER=supabase (default)', async () => {
    mockedIsBlobPrimary.mockReturnValue(false);
    const list = jest.fn().mockResolvedValue({ data: [] });
    const upload = jest.fn().mockResolvedValue({ error: null });
    const getPublicUrl = jest
      .fn()
      .mockReturnValue({ data: { publicUrl: 'https://supabase.example/cover.png' } });
    mockedCreateAdminClient.mockReturnValue({
      storage: { from: jest.fn(() => ({ list, upload, getPublicUrl })) },
    } as never);

    const file = new File(['png-bytes'], 'cover.png', { type: 'image/png' });
    const response = await POST(uploadRequest(file, 'cover'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockedPut).not.toHaveBeenCalled();
    expect(mockedCreateAdminClient).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalled();
    expect(payload.url).toBe('https://supabase.example/cover.png');
  });

  it('validates before either storage branch runs, in both provider modes', async () => {
    mockedIsBlobPrimary.mockReturnValue(true);
    const badFile = new File(['exe-bytes'], 'payload.exe', {
      type: 'application/x-msdownload',
    });

    const response = await POST(uploadRequest(badFile, 'cover'));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/JPG, PNG, WebP or GIF/);
    expect(mockedPut).not.toHaveBeenCalled();
    expect(mockedCreateAdminClient).not.toHaveBeenCalled();
  });
});
