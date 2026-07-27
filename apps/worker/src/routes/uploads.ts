import { Hono } from 'hono';
import type { Env } from '../index.js';

/**
 * Image upload + public delivery via R2.
 *
 * - POST /api/uploads/image (auth) accepts multipart/form-data with `image`
 *   and stores it in the UPLOADS R2 bucket under `images/<uuid>.<ext>`.
 *   Returns the public URL the operator can paste into LINE message JSON or
 *   Buttons template thumbnails.
 *
 * - GET /uploads/:key (no auth) streams the object back so LINE's servers and
 *   the in-app preview can fetch it. The auth middleware allow-lists this
 *   path explicitly because LINE doesn't send our API key when validating
 *   image URLs.
 */
const uploads = new Hono<Env>();

const ALLOWED_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const MAX_BYTES = 10 * 1024 * 1024; // 10MB — LINE image cap is 10MB for images

const ALLOWED_FILE_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
};
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB — generous cap for PDF distributables

uploads.post('/api/uploads/image', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('image');
    if (!(file instanceof File)) {
      return c.json({ success: false, error: 'image file required (multipart)' }, 400);
    }
    const ext = ALLOWED_TYPES[file.type];
    if (!ext) {
      return c.json({ success: false, error: 'PNG / JPEG / GIF / WebP のみ対応' }, 400);
    }
    if (file.size > MAX_BYTES) {
      return c.json({ success: false, error: '画像は10MB以下にしてください' }, 400);
    }

    const filename = `${crypto.randomUUID()}.${ext}`;
    const key = `images/${filename}`;
    const buffer = await file.arrayBuffer();
    await c.env.UPLOADS.put(key, buffer, {
      httpMetadata: { contentType: file.type },
    });

    // R2 stores under `images/<filename>` but the public URL routes through
    // `/uploads/<filename>` so the auth allow-list (which whitelists /uploads/)
    // keeps the GET reachable for LINE without leaking the rest of the API.
    const base = c.env.TRACKING_BASE_URL ?? new URL(c.req.url).origin;
    const url = `${base.replace(/\/$/, '')}/uploads/${filename}`;

    return c.json({ success: true, data: { key, url } });
  } catch (err) {
    console.error('POST /api/uploads/image error:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, 500);
  }
});

uploads.post('/api/uploads/file', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) {
      return c.json({ success: false, error: 'file required (multipart)' }, 400);
    }
    const ext = ALLOWED_FILE_TYPES[file.type];
    if (!ext) {
      return c.json({ success: false, error: 'PDFのみ対応' }, 400);
    }
    if (file.size > MAX_FILE_BYTES) {
      return c.json({ success: false, error: 'ファイルは25MB以下にしてください' }, 400);
    }

    // Account ownership: the uploader UI passes lineAccountId so per-account
    // listing works. Form data takes priority; query string is a fallback.
    const lineAccountId =
      (formData.get('lineAccountId') as string | null) ??
      c.req.query('lineAccountId') ??
      null;

    const id = crypto.randomUUID();
    const filename = `${id}.${ext}`;
    const key = `files/${filename}`;
    const buffer = await file.arrayBuffer();
    await c.env.UPLOADS.put(key, buffer, {
      httpMetadata: { contentType: file.type },
    });

    await c.env.DB
      .prepare(
        `INSERT INTO uploaded_files (id, line_account_id, filename, r2_key, original_name, size, content_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, lineAccountId, filename, key, file.name, file.size, file.type)
      .run();

    const base = c.env.TRACKING_BASE_URL ?? new URL(c.req.url).origin;
    const url = `${base.replace(/\/$/, '')}/uploads/files/${filename}`;

    return c.json({ success: true, data: { id, key, url } });
  } catch (err) {
    console.error('POST /api/uploads/file error:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, 500);
  }
});

// GET /api/uploads/files — list metadata, scoped per-account
uploads.get('/api/uploads/files', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId') ?? null;
    const base = c.env.TRACKING_BASE_URL ?? new URL(c.req.url).origin;
    const rows = lineAccountId
      ? await c.env.DB
          .prepare(
            `SELECT id, line_account_id as lineAccountId, filename, original_name as originalName,
                    size, content_type as contentType, created_at as createdAt
             FROM uploaded_files
             WHERE line_account_id = ?
             ORDER BY created_at DESC`,
          )
          .bind(lineAccountId)
          .all<{ id: string; lineAccountId: string | null; filename: string; originalName: string | null; size: number | null; contentType: string | null; createdAt: string }>()
      : await c.env.DB
          .prepare(
            `SELECT id, line_account_id as lineAccountId, filename, original_name as originalName,
                    size, content_type as contentType, created_at as createdAt
             FROM uploaded_files
             ORDER BY created_at DESC`,
          )
          .all<{ id: string; lineAccountId: string | null; filename: string; originalName: string | null; size: number | null; contentType: string | null; createdAt: string }>();
    const data = (rows.results ?? []).map((r) => ({
      ...r,
      url: `${base.replace(/\/$/, '')}/uploads/files/${r.filename}`,
    }));
    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/uploads/files error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/uploads/files/:id — remove metadata + R2 object
uploads.delete('/api/uploads/files/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const row = await c.env.DB
      .prepare('SELECT r2_key FROM uploaded_files WHERE id = ?')
      .bind(id)
      .first<{ r2_key: string }>();
    if (!row) return c.json({ success: false, error: 'Not found' }, 404);
    await c.env.UPLOADS.delete(row.r2_key);
    await c.env.DB.prepare('DELETE FROM uploaded_files WHERE id = ?').bind(id).run();
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/uploads/files/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

uploads.get('/uploads/files/:filename', async (c) => {
  try {
    const filename = c.req.param('filename');
    if (!filename || filename.includes('..') || filename.includes('/')) {
      return c.json({ success: false, error: 'Invalid key' }, 400);
    }
    const obj = await c.env.UPLOADS.get(`files/${filename}`);
    if (!obj) return c.json({ success: false, error: 'Not found' }, 404);

    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('etag', obj.httpEtag);
    return new Response(obj.body, { headers });
  } catch (err) {
    console.error('GET /uploads/files/:filename error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

uploads.get('/uploads/:filename', async (c) => {
  try {
    const filename = c.req.param('filename');
    if (!filename || filename.includes('..') || filename.includes('/')) {
      return c.json({ success: false, error: 'Invalid key' }, 400);
    }
    const obj = await c.env.UPLOADS.get(`images/${filename}`);
    if (!obj) return c.json({ success: false, error: 'Not found' }, 404);

    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('etag', obj.httpEtag);
    return new Response(obj.body, { headers });
  } catch (err) {
    console.error('GET /uploads/:filename error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { uploads };
