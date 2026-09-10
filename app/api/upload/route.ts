/* eslint-disable */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@/lib/supabase/admin';
import { isBlobPrimary } from '@/lib/storage/provider';

const ALLOWED_FILE_TYPES = new Map([
  ['application/pdf', 'pdf'],
  ['application/msword', 'doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['text/plain', 'txt'],
]);

/**
 * Phoenix WS3 dual-run (REPO_AUDIT_2026-08-21 F3) — Vercel Blob leg.
 * This route's Supabase leg has never been content-addressed
 * (`${userId}/${Date.now()}.${ext}`, no dedup) — deliberately different from
 * lib/uploads/store-asset.ts's hash-based convention. The Blob leg keeps
 * that same timestamp-based naming rather than introducing dedup semantics
 * this route has never had; see PR body for the full rationale.
 */
async function uploadManuscriptToBlob(
  userId: string,
  fileExt: string,
  file: File
): Promise<string> {
  const { put } = await import('@vercel/blob');

  const blobPath = `${userId}/manuscripts/${Date.now()}.${fileExt}`;
  const fileBuffer = Buffer.from(await file.arrayBuffer());

  const blob = await put(blobPath, fileBuffer, {
    access: 'public',
    contentType: file.type,
    addRandomSuffix: false,
  });

  return blob.url;
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ error: 'Invalid multipart form data' }, { status: 400 });
    }
    const file = formData.get('file');

    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // Validate file type and size
    const maxSize = 50 * 1024 * 1024; // 50MB
    if (file.size > maxSize) {
      return NextResponse.json({ error: 'File too large' }, { status: 400 });
    }

    const fileExt = ALLOWED_FILE_TYPES.get(file.type);
    if (!fileExt) {
      return NextResponse.json(
        { error: 'Unsupported file type. Upload a PDF, Word document, or plain text file.' },
        { status: 400 }
      );
    }

    if (isBlobPrimary()) {
      const url = await uploadManuscriptToBlob(user.id, fileExt, file);
      return NextResponse.json({ url });
    }

    const fileName = `${user.id}/${Date.now()}.${fileExt}`;

    const adminSupabase = createAdminClient();
    const { error } = await adminSupabase.storage.from('manuscripts').upload(fileName, file, {
      cacheControl: '3600',
      contentType: file.type,
      upsert: false,
    });

    if (error) {
      console.error('[Upload] Failed to store file:', error);
      return NextResponse.json({ error: 'Failed to upload file' }, { status: 500 });
    }

    const {
      data: { publicUrl },
    } = adminSupabase.storage.from('manuscripts').getPublicUrl(fileName);

    return NextResponse.json({ url: publicUrl });
  } catch (error) {
    console.error('[Upload] Unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
