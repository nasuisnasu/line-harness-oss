/**
 * 生徒カルテ（講師用）
 *
 * 1人の生徒について散らばっている情報を1画面ぶんにまとめて返す。
 * 中身の考え方は `packages/db/src/students.ts` のコメントが正本。
 *
 * ★ 入口が2つある。**中身の実装は1つ**（下の handle* 関数）。
 *
 *   1. `/api/students/*`        … API_KEY。insider-line-crm（Vercel）の管理画面から
 *   2. `/api/eijaku/karte/*`    … 共有鍵 X-Shelf-Key。eijakuniki.com/admin から
 *                                 （棚のワーカー eijaku-ai が中継する）
 *
 *   2 が要るのは、eijakuniki.com の管理画面が harness の API_KEY を持っていないから。
 *   あそこは adminPw で eijaku-ai を叩き、eijaku-ai が共有鍵でこちらに来る。
 *   `/api/eijaku/calendar` `/api/eijaku/students` と同じ経路に揃えてある。
 *
 * ★ `/api/eijaku/` は authMiddleware の素通しリストに入っている（生徒用の idToken 経路のため）。
 *   したがって **karte 側のハンドラは自分で共有鍵を確かめること**。
 *   確かめ忘れると、鍵なしで全生徒のカルテとメモが読める。
 */

import { Hono } from 'hono';
import {
  getStudents,
  getStudentOverview,
  createFriendNote,
  updateFriendNote,
  deleteFriendNote,
  getFriendNotes,
  addLessonRecord,
  deleteLessonRecord,
  isLessonType,
} from '@line-crm/db';
import type { Env } from '../index.js';

export const students = new Hono<Env>();

/** メモ1本の長さの上限。長い考察は棚のドキュメントに置く前提で、ここは指導の要点だけ */
const MAX_NOTE_LENGTH = 4000;

type Ctx = {
  env: Env['Bindings'];
  req: { header(name: string): string | undefined; query(name: string): string | undefined };
};

/** `/api/eijaku/karte/*` 専用のゲート。共通ミドルウェアが素通しする経路なのでここが唯一の壁。 */
function sharedKeyOk(c: Ctx): boolean {
  const shared = c.env.SHELF_API_KEY;
  return !!shared && c.req.header('X-Shelf-Key') === shared;
}

// ── 中身（入口2つで共有する） ───────────────────────────────────────────────

async function handleList(c: Ctx) {
  const lineAccountId = c.req.query('lineAccountId') || c.env.VOCAB_LINE_ACCOUNT_ID || null;
  // tagId=all を渡したときだけタグの縛りを外す（保護者や見込みも見たいとき用）
  const tagParam = c.req.query('tagId');
  const tagId = tagParam === 'all' ? null : tagParam || c.env.VOCAB_ALLOW_TAG_ID || null;
  return { success: true, students: await getStudents(c.env.DB, lineAccountId, tagId) };
}

async function handleNoteCreate(c: Ctx, friendId: string, body: { body?: string; pinned?: boolean }) {
  const text = String(body.body ?? '').trim();
  if (!text) return { status: 400 as const, payload: { success: false, error: '本文が空です' } };

  const friend = await c.env.DB.prepare(`SELECT id FROM friends WHERE id = ?`)
    .bind(friendId)
    .first<{ id: string }>();
  if (!friend) {
    return { status: 404 as const, payload: { success: false, error: '生徒が見つかりません' } };
  }

  const note = await createFriendNote(
    c.env.DB,
    friendId,
    text.slice(0, MAX_NOTE_LENGTH),
    body.pinned === true,
  );
  return { status: 200 as const, payload: { success: true, note } };
}

async function handleNoteUpdate(
  c: Ctx,
  friendId: string,
  noteId: string,
  body: { body?: string; pinned?: boolean },
) {
  const patch: { body?: string; pinned?: boolean } = {};
  if (body.body !== undefined) {
    const text = String(body.body).trim();
    if (!text) return { status: 400 as const, payload: { success: false, error: '本文が空です' } };
    patch.body = text.slice(0, MAX_NOTE_LENGTH);
  }
  if (body.pinned !== undefined) patch.pinned = body.pinned === true;

  const note = await updateFriendNote(c.env.DB, friendId, noteId, patch);
  if (!note) {
    return { status: 400 as const, payload: { success: false, error: '更新するものがありません' } };
  }
  return { status: 200 as const, payload: { success: true, note } };
}

/**
 * 配った教材（棚）。**カルテ本体とは別に取る。**
 * 棚は別ワーカー（eijaku-ai）なので、落ちているときにカルテ全体が
 * 開かなくなるほうが困る。ここだけ失敗させて、残りは出す。
 */
async function handleMaterials(c: Ctx, friendId: string) {
  const key = c.env.SHELF_API_KEY;
  const base = c.env.SHELF_PUBLIC_URL;
  if (!c.env.SHELF || !key || !base) {
    return { status: 503 as const, payload: { success: false, error: '棚の設定がありません' } };
  }

  const friend = await c.env.DB.prepare(
    `SELECT line_user_id, display_name FROM friends WHERE id = ?`,
  )
    .bind(friendId)
    .first<{ line_user_id: string; display_name: string | null }>();
  if (!friend) {
    return { status: 404 as const, payload: { success: false, error: '生徒が見つかりません' } };
  }

  // 同ゾーンのワーカーはURLで呼ぶと 1042 になる。サービスバインディング経由で叩く
  const path =
    `/shelf/for-line/${encodeURIComponent(friend.line_user_id)}` +
    `?name=${encodeURIComponent(friend.display_name || '')}`;
  const r = await c.env.SHELF.fetch(`https://shelf${path}`, { headers: { 'X-Shelf-Key': key } });
  if (!r.ok) {
    console.error(`[students] 棚から取得できませんでした: ${r.status}`);
    return { status: 502 as const, payload: { success: false, error: '棚から取得できませんでした' } };
  }
  const data = await r.json<{ linked: boolean; sets: any[] }>();
  const sets = (data.sets || []).map((s) => ({
    ...s,
    files: (s.files || []).map((f: any) => ({ ...f, url: `${base}${f.url}` })),
  }));
  return { status: 200 as const, payload: { success: true, linked: data.linked, sets } };
}

// ── 入口1：API_KEY（insider-line-crm） ──────────────────────────────────────

students.get('/api/students', async (c) => c.json(await handleList(c)));

students.get('/api/students/:friendId', async (c) => {
  const overview = await getStudentOverview(c.env.DB, c.req.param('friendId'));
  if (!overview.friend) return c.json({ success: false, error: '生徒が見つかりません' }, 404);
  return c.json({ success: true, ...overview });
});

students.get('/api/students/:friendId/materials', async (c) => {
  const r = await handleMaterials(c, c.req.param('friendId'));
  return c.json(r.payload, r.status);
});

students.get('/api/students/:friendId/notes', async (c) =>
  c.json({ success: true, notes: await getFriendNotes(c.env.DB, c.req.param('friendId')) }),
);

students.post('/api/students/:friendId/notes', async (c) => {
  const body = await c.req.json<{ body?: string; pinned?: boolean }>().catch(() => ({}) as any);
  const r = await handleNoteCreate(c, c.req.param('friendId'), body);
  return c.json(r.payload, r.status);
});

students.patch('/api/students/:friendId/notes/:noteId', async (c) => {
  const body = await c.req.json<{ body?: string; pinned?: boolean }>().catch(() => ({}) as any);
  const r = await handleNoteUpdate(c, c.req.param('friendId'), c.req.param('noteId'), body);
  return c.json(r.payload, r.status);
});

students.delete('/api/students/:friendId/notes/:noteId', async (c) => {
  await deleteFriendNote(c.env.DB, c.req.param('friendId'), c.req.param('noteId'));
  return c.json({ success: true });
});

// ── 入口2：共有鍵（eijakuniki.com/admin ← eijaku-ai が中継） ────────────────
//
// **各ハンドラの先頭で必ず sharedKeyOk を通すこと。**
// `/api/eijaku/` は authMiddleware が素通しするので、ここが唯一の壁。

const DENIED = { success: false, error: 'Unauthorized' } as const;

students.get('/api/eijaku/karte/students', async (c) => {
  if (!sharedKeyOk(c)) return c.json(DENIED, 401);
  return c.json(await handleList(c));
});

students.get('/api/eijaku/karte/students/:friendId', async (c) => {
  if (!sharedKeyOk(c)) return c.json(DENIED, 401);
  const friendId = c.req.param('friendId');
  const overview = await getStudentOverview(c.env.DB, friendId);
  if (!overview.friend) return c.json({ success: false, error: '生徒が見つかりません' }, 404);

  // 棚は同じ画面で使うので一緒に返す。取れなくてもカルテは返す（materials: null）
  const shelf = await handleMaterials(c, friendId).catch(() => null);
  return c.json({
    success: true,
    ...overview,
    materials: shelf && shelf.status === 200 ? shelf.payload : null,
  });
});

students.post('/api/eijaku/karte/students/:friendId/notes', async (c) => {
  if (!sharedKeyOk(c)) return c.json(DENIED, 401);
  const body = await c.req.json<{ body?: string; pinned?: boolean }>().catch(() => ({}) as any);
  const r = await handleNoteCreate(c, c.req.param('friendId'), body);
  return c.json(r.payload, r.status);
});

students.patch('/api/eijaku/karte/students/:friendId/notes/:noteId', async (c) => {
  if (!sharedKeyOk(c)) return c.json(DENIED, 401);
  const body = await c.req.json<{ body?: string; pinned?: boolean }>().catch(() => ({}) as any);
  const r = await handleNoteUpdate(c, c.req.param('friendId'), c.req.param('noteId'), body);
  return c.json(r.payload, r.status);
});

students.delete('/api/eijaku/karte/students/:friendId/notes/:noteId', async (c) => {
  if (!sharedKeyOk(c)) return c.json(DENIED, 401);
  await deleteFriendNote(c.env.DB, c.req.param('friendId'), c.req.param('noteId'));
  return c.json({ success: true });
});

// 授業記録。数え方（契約は count、実施とキャンセルは1回消化）は addLessonRecord が正本。
// `/api/friends/:id/lessons` と同じ台帳に入る。カルテからも友だち管理からも同じ数字になる。
students.post('/api/eijaku/karte/students/:friendId/lessons', async (c) => {
  if (!sharedKeyOk(c)) return c.json(DENIED, 401);
  const body = await c.req
    .json<{ type?: string; count?: number; recordDate?: string; note?: string }>()
    .catch(() => ({}) as any);
  if (!isLessonType(body.type)) {
    return c.json({ success: false, error: 'type must be contract | lesson | cancel' }, 400);
  }
  const friendId = c.req.param('friendId');
  const friend = await c.env.DB.prepare(`SELECT id FROM friends WHERE id = ?`)
    .bind(friendId)
    .first<{ id: string }>();
  if (!friend) return c.json({ success: false, error: '生徒が見つかりません' }, 404);

  const { id } = await addLessonRecord(c.env.DB, friendId, {
    type: body.type,
    count: body.count,
    recordDate: body.recordDate,
    note: body.note ?? null,
  });
  return c.json({ success: true, id });
});

students.delete('/api/eijaku/karte/students/:friendId/lessons/:recordId', async (c) => {
  if (!sharedKeyOk(c)) return c.json(DENIED, 401);
  await deleteLessonRecord(c.env.DB, c.req.param('friendId'), c.req.param('recordId'));
  return c.json({ success: true });
});
