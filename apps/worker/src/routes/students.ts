/**
 * 生徒カルテ（講師用）
 *
 * 1人の生徒について散らばっている情報を1画面ぶんにまとめて返す。
 * 中身の考え方は `packages/db/src/students.ts` のコメントが正本。
 *
 * ★ 認証は API_KEY だけ。**生徒用の入口を作らない。**
 *   `/api/students/` は authMiddleware の素通しリストに入っていないので、
 *   共通ミドルウェアが鍵を見てくれる。`/api/eijaku/` 配下に置いてはいけない
 *   （あそこは idToken 用に素通しされているので、鍵なしで全生徒のメモが読める）。
 *
 * ★ 一覧の既定は「受講生タグ持ちだけ」。
 *   env の VOCAB_LINE_ACCOUNT_ID / VOCAB_ALLOW_TAG_ID ＝ テストを開ける人と同じ条件。
 *   ここに保護者やタグ無しの友だちが混ざると「止まっている生徒」の数が意味を失う。
 */

import { Hono } from 'hono';
import {
  getStudents,
  getStudentOverview,
  createFriendNote,
  updateFriendNote,
  deleteFriendNote,
  getFriendNotes,
} from '@line-crm/db';
import type { Env } from '../index.js';

export const students = new Hono<Env>();

/** メモ1本の長さの上限。長い考察は棚のドキュメントに置く前提で、ここは指導の要点だけ */
const MAX_NOTE_LENGTH = 4000;

students.get('/api/students', async (c) => {
  const lineAccountId = c.req.query('lineAccountId') || c.env.VOCAB_LINE_ACCOUNT_ID || null;
  // tagId=all を渡したときだけタグの縛りを外す（保護者や見込みも見たいとき用）
  const tagParam = c.req.query('tagId');
  const tagId = tagParam === 'all' ? null : tagParam || c.env.VOCAB_ALLOW_TAG_ID || null;
  const rows = await getStudents(c.env.DB, lineAccountId, tagId);
  return c.json({ success: true, students: rows });
});

students.get('/api/students/:friendId', async (c) => {
  const overview = await getStudentOverview(c.env.DB, c.req.param('friendId'));
  if (!overview.friend) return c.json({ success: false, error: '生徒が見つかりません' }, 404);
  return c.json({ success: true, ...overview });
});

/**
 * 配った教材（棚）。**カルテ本体とは別のエンドポイントにする。**
 * 棚は別ワーカー（eijaku-ai）なので、落ちているときにカルテ全体が
 * 開かなくなるほうが困る。ここだけ失敗させて、残りは出す。
 */
students.get('/api/students/:friendId/materials', async (c) => {
  const key = c.env.SHELF_API_KEY;
  const base = c.env.SHELF_PUBLIC_URL;
  if (!c.env.SHELF || !key || !base) {
    return c.json({ success: false, error: '棚の設定がありません' }, 503);
  }

  const friend = await c.env.DB.prepare(
    `SELECT line_user_id, display_name FROM friends WHERE id = ?`,
  )
    .bind(c.req.param('friendId'))
    .first<{ line_user_id: string; display_name: string | null }>();
  if (!friend) return c.json({ success: false, error: '生徒が見つかりません' }, 404);

  // 同ゾーンのワーカーはURLで呼ぶと 1042 になる。サービスバインディング経由で叩く
  const path =
    `/shelf/for-line/${encodeURIComponent(friend.line_user_id)}` +
    `?name=${encodeURIComponent(friend.display_name || '')}`;
  const r = await c.env.SHELF.fetch(`https://shelf${path}`, { headers: { 'X-Shelf-Key': key } });
  if (!r.ok) {
    console.error(`[students] 棚から取得できませんでした: ${r.status}`);
    return c.json({ success: false, error: '棚から取得できませんでした' }, 502);
  }
  const data = await r.json<{ linked: boolean; sets: any[] }>();
  const sets = (data.sets || []).map((s) => ({
    ...s,
    files: (s.files || []).map((f: any) => ({ ...f, url: `${base}${f.url}` })),
  }));
  return c.json({ success: true, linked: data.linked, sets });
});

// ── 講師メモ ────────────────────────────────────────────────────────────────

students.get('/api/students/:friendId/notes', async (c) => {
  const notes = await getFriendNotes(c.env.DB, c.req.param('friendId'));
  return c.json({ success: true, notes });
});

students.post('/api/students/:friendId/notes', async (c) => {
  const friendId = c.req.param('friendId');
  const body = await c.req.json<{ body?: string; pinned?: boolean }>().catch(() => ({}) as any);
  const text = String(body.body ?? '').trim();
  if (!text) return c.json({ success: false, error: '本文が空です' }, 400);

  const friend = await c.env.DB.prepare(`SELECT id FROM friends WHERE id = ?`)
    .bind(friendId)
    .first<{ id: string }>();
  if (!friend) return c.json({ success: false, error: '生徒が見つかりません' }, 404);

  const note = await createFriendNote(
    c.env.DB,
    friendId,
    text.slice(0, MAX_NOTE_LENGTH),
    body.pinned === true,
  );
  return c.json({ success: true, note });
});

students.patch('/api/students/:friendId/notes/:noteId', async (c) => {
  const body = await c.req.json<{ body?: string; pinned?: boolean }>().catch(() => ({}) as any);
  const patch: { body?: string; pinned?: boolean } = {};
  if (body.body !== undefined) {
    const text = String(body.body).trim();
    if (!text) return c.json({ success: false, error: '本文が空です' }, 400);
    patch.body = text.slice(0, MAX_NOTE_LENGTH);
  }
  if (body.pinned !== undefined) patch.pinned = body.pinned === true;

  const note = await updateFriendNote(
    c.env.DB,
    c.req.param('friendId'),
    c.req.param('noteId'),
    patch,
  );
  if (!note) return c.json({ success: false, error: '更新するものがありません' }, 400);
  return c.json({ success: true, note });
});

students.delete('/api/students/:friendId/notes/:noteId', async (c) => {
  await deleteFriendNote(c.env.DB, c.req.param('friendId'), c.req.param('noteId'));
  return c.json({ success: true });
});
