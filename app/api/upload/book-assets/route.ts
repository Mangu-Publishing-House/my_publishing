import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@/lib/supabase/admin';
import {
  storeBookAsset,
  storeBookAssetToBlob,
  validateBookAsset,
  type BookAssetKind,
} from '@/lib/uploads/store-asset';
import { isBlobPrimary } from '@/lib/storage/provider';

/**
 * POST /api/upload/book-assets
 * Multipart upload for book covers and published EPUBs.
 * Fields: `file` (File), `asset` ('cover' | 'epub').
 * Auth: requires a signed-in user (rate-limited by middleware on /api/upload*).
 * Storage: dual-run on STORAGE_PROVIDER (Phoenix WS3, REPO_AUDIT_2026-08-21 F3).
 * Supabase leg (default): service-role client after the auth check, content-
 * addressed paths with SHA-256 dedup. Blob leg: same content-addressed
 * naming convention via storeBookAssetToBlob — see lib/uploads/store-asset.ts
 * for both.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ error: 'Invalid multipart form data' }, { status: 400 });
    }

    const assetParam = formData.get('asset');
    if (assetParam !== 'cover' && assetParam !== 'epub') {
      return NextResponse.json(
        { error: "Field 'asset' must be 'cover' or 'epub'" },
        { status: 400 }
      );
    }
    const asset: BookAssetKind = assetParam;

    const file = formData.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const validation = validateBookAsset(file, asset);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const result = isBlobPrimary()
      ? await storeBookAssetToBlob(asset, user.id, file)
      : await storeBookAsset(createAdminClient(), asset, user.id, file);

    return NextResponse.json(result);
  } catch (error) {
    // Never leak internals/stack traces to the client.
    console.error('Book asset upload error:', error);
    return NextResponse.json({ error: 'Upload failed. Please try again.' }, { status: 500 });
  }
}
