/** @jest-environment node */

/**
 * Phoenix WS3 dual-run (REPO_AUDIT_2026-08-21 F3): Vercel Blob leg for
 * lib/uploads/store-asset.ts. storeBookAsset (Supabase) has no pre-existing
 * dedicated unit test in this suite — it is exercised indirectly through
 * app/api/upload/book-assets/route.ts — and is left completely untouched by
 * this change; see tests/unit/upload-book-assets-blob-dual-run.test.ts for
 * the route-level Supabase-leg regression check.
 */
import { createHash } from 'crypto';
import { storeBookAssetToBlob } from '@/lib/uploads/store-asset';

jest.mock('@vercel/blob', () => ({ put: jest.fn() }));

const { put: mockedPut } = jest.requireMock('@vercel/blob') as { put: jest.Mock };

function makeFile(name: string, content: string, type: string): File {
  return new File([content], name, { type });
}

describe('storeBookAssetToBlob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uploads via @vercel/blob put() with a content-addressed, bucket-scoped path', async () => {
    mockedPut.mockResolvedValue({ url: 'https://example.public.blob.vercel-storage.com/abc' });

    const file = makeFile('cover.png', 'image-bytes', 'image/png');
    const result = await storeBookAssetToBlob('cover', 'user-1', file);

    expect(mockedPut).toHaveBeenCalledTimes(1);
    const [path, , options] = mockedPut.mock.calls[0];
    expect(path).toMatch(/^user-1\/book-covers\/[0-9a-f]{64}\.png$/);
    expect(options).toEqual(
      expect.objectContaining({
        access: 'public',
        contentType: 'image/png',
        addRandomSuffix: false,
      })
    );
    expect(result).toEqual({
      url: 'https://example.public.blob.vercel-storage.com/abc',
      filePath: path,
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      // put() carries no overwrite/dedup signal in the installed @vercel/blob
      // SDK — every Blob upload reports deduplicated: false, matching the
      // same documented choice in lib/actions/upload.ts's uploadToBlob().
      deduplicated: false,
    });
  });

  it('scopes epub uploads under the published-epubs path segment and normalizes content-type', async () => {
    mockedPut.mockResolvedValue({ url: 'https://example.public.blob.vercel-storage.com/def' });

    const file = makeFile('book.epub', 'epub-bytes', 'application/octet-stream');
    const result = await storeBookAssetToBlob('epub', 'user-2', file);

    const [path, , options] = mockedPut.mock.calls[0];
    expect(path).toMatch(/^user-2\/published-epubs\/[0-9a-f]{64}\.epub$/);
    // Same MIME normalization as storeBookAsset (Supabase leg): loose
    // browser MIME types are coerced to application/epub+zip.
    expect(options.contentType).toBe('application/epub+zip');
    expect(result.deduplicated).toBe(false);
  });

  it('produces the same SHA-256 hash algorithm/content-addressing as the Supabase leg', async () => {
    mockedPut.mockResolvedValue({ url: 'https://example.public.blob.vercel-storage.com/ghi' });

    const file = makeFile('cover.jpg', 'identical-bytes', 'image/jpeg');
    const result = await storeBookAssetToBlob('cover', 'user-3', file);

    expect(result.hash).toBe(createHash('sha256').update('identical-bytes').digest('hex'));
    expect(result.filePath).toBe(`user-3/book-covers/${result.hash}.jpg`);
  });
});
