/**
 * 単語テスト（受講生専用）
 *
 * 生徒用は LIFF の idToken、講師用は API_KEY。認証経路を混ぜないこと。
 * アクセス制御の設計は `.company/英弱ニキ/lms/vocab/10-access-control.md` が正本。
 *
 * 生徒用エンドポイントは authMiddleware をスキップさせている（Authorization ヘッダを
 * API_KEY ではなく idToken に使うため）。したがって**このファイル内のゲートが唯一の壁**。
 * 各ハンドラの先頭で必ず requireStudent() を通す。
 */

import { Hono } from 'hono';
import {
  getVocabBooks,
  getVocabBookById,
  getVocabWords,
  getVocabDecoys,
  getReviewWords,
  getVocabDashboard,
  getVocabRecords,
  saveVocabSession,
  getVocabSessionAnswers,
  getVocabStudents,
  getVocabStudentDetail,
  upsertVocabBook,
  replaceVocabWords,
  getFriendByLineUserId,
  jstNow,
} from '@line-crm/db';
import type { Friend } from '@line-crm/db';
import type { Env } from '../index.js';

export const vocab = new Hono<Env>();

/** 1リクエストで返す語数の上限。全件取得の経路を作らないための線引き。 */
const MAX_WORDS_PER_REQUEST = 100;
const MAX_REVIEW_WORDS = 20;

// ── ゲート ──────────────────────────────────────────────────────────────────

type Gate = { ok: true; friend: Friend } | { ok: false; status: 401 | 403 | 503; message: string };

/**
 * 3段のゲート。1つでも欠けたら通さない。
 *
 *   1. idToken が LINE の検証エンドポイントで有効（client_id はサーバー側の env）
 *   2. 受講生専用OAの friends に存在する
 *   3. 受講生タグを持っている
 *
 * env が未設定のときは**通さない**（fail closed）。設定漏れのまま deploy して
 * 全員に開いてしまうほうが、初回に 503 で気づくよりずっと悪い。
 */
async function requireStudent(c: {
  req: { header(name: string): string | undefined };
  env: Env['Bindings'];
}): Promise<Gate> {
  const loginChannelId = c.env.VOCAB_LOGIN_CHANNEL_ID;
  const lineAccountId = c.env.VOCAB_LINE_ACCOUNT_ID;
  const allowTagId = c.env.VOCAB_ALLOW_TAG_ID;

  if (!loginChannelId || !lineAccountId || !allowTagId) {
    console.error(
      '[vocab] 設定が足りていません。VOCAB_LOGIN_CHANNEL_ID / VOCAB_LINE_ACCOUNT_ID / VOCAB_ALLOW_TAG_ID を設定してください',
    );
    return { ok: false, status: 503, message: 'not configured' };
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { ok: false, status: 401, message: 'unauthorized' };
  }
  const idToken = authHeader.slice('Bearer '.length);

  // ── 1段目：LINE に検証させる ──
  // 自前で JWT をデコードして sub を読むだけにしないこと。署名を見ていないので誰でも作れる。
  // client_id を渡さないと、別チャネルで発行されたトークンが通ってしまう。
  const verifyRes = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: loginChannelId }),
  });
  if (!verifyRes.ok) {
    return { ok: false, status: 401, message: 'unauthorized' };
  }
  const verified = await verifyRes.json<{ sub: string }>();

  // ── 2段目：受講生専用OAの友だちか ──
  const friend = await getFriendByLineUserId(c.env.DB, verified.sub, lineAccountId);
  if (!friend) {
    return { ok: false, status: 403, message: 'forbidden' };
  }

  // ── 3段目：受講生タグを持っているか ──
  // LINE公式アカウントは ID を知られれば誰でも友だち追加できる。
  // 「友だちであること」だけでは受講生に絞れない。
  const tagged = await c.env.DB.prepare(
    `SELECT 1 FROM friend_tags WHERE friend_id = ? AND tag_id = ? LIMIT 1`,
  )
    .bind(friend.id, allowTagId)
    .first();
  if (!tagged) {
    return { ok: false, status: 403, message: 'forbidden' };
  }

  return { ok: true, friend };
}

/** 403 のレスポンスに内部事情を書かない（語数・単語帳名・生徒の有無を漏らさない）。 */
function denied(status: 401 | 403 | 503) {
  const body =
    status === 503
      ? { success: false, error: 'サーバーの設定が完了していません' }
      : { success: false, error: '受講生の方のみご利用いただけます' };
  return { body, status } as const;
}

// ── 生徒用 ──────────────────────────────────────────────────────────────────

vocab.get('/api/vocab/books', async (c) => {
  const gate = await requireStudent(c);
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const books = await getVocabBooks(c.env.DB, gate.friend.line_account_id);
  return c.json({ success: true, books });
});

vocab.get('/api/vocab/words', async (c) => {
  const gate = await requireStudent(c);
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }

  const bookId = Number(c.req.query('book_id'));
  const from = Number(c.req.query('from'));
  const to = Number(c.req.query('to'));
  const order = c.req.query('order') === 'rnd' ? 'rnd' : 'seq';
  const limit = Number(c.req.query('limit') || MAX_WORDS_PER_REQUEST);

  // 範囲指定は必須。単語帳の全件を返す経路を作らない。
  if (!bookId || !Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < 1) {
    return c.json({ success: false, error: 'book_id / from / to は必須です' }, 400);
  }
  if (!Number.isFinite(limit) || limit < 1 || limit > MAX_WORDS_PER_REQUEST) {
    return c.json({ success: false, error: `1回に取得できるのは${MAX_WORDS_PER_REQUEST}語までです` }, 400);
  }
  if (Math.abs(to - from) + 1 > MAX_WORDS_PER_REQUEST && limit > MAX_WORDS_PER_REQUEST) {
    return c.json({ success: false, error: `1回に取得できるのは${MAX_WORDS_PER_REQUEST}語までです` }, 400);
  }

  const words = await getVocabWords(c.env.DB, bookId, from, to, limit, order);
  if (!words.length) {
    return c.json({ success: true, words: [], decoys: [] });
  }

  // 4択のダミーは、出題語が4語未満のときだけ範囲外から補う。
  const need = Math.max(0, 4 - words.length);
  const decoys = need
    ? await getVocabDecoys(
        c.env.DB,
        bookId,
        words.map((w) => w.id),
        need + 2,
      )
    : [];

  return c.json({ success: true, words, decoys });
});

vocab.get('/api/vocab/review', async (c) => {
  const gate = await requireStudent(c);
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const bookId = Number(c.req.query('book_id'));
  if (!bookId) return c.json({ success: false, error: 'book_id は必須です' }, 400);

  const limit = Math.min(Number(c.req.query('limit') || MAX_REVIEW_WORDS), MAX_REVIEW_WORDS);
  const words = await getReviewWords(c.env.DB, gate.friend.id, bookId, limit);
  return c.json({ success: true, count: words.length, words });
});

vocab.get('/api/vocab/dashboard', async (c) => {
  const gate = await requireStudent(c);
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const dashboard = await getVocabDashboard(c.env.DB, gate.friend.id, gate.friend.line_account_id);
  return c.json({ success: true, ...dashboard });
});

vocab.get('/api/vocab/records', async (c) => {
  const gate = await requireStudent(c);
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const bookId = Number(c.req.query('book_id'));
  if (!bookId) return c.json({ success: false, error: 'book_id は必須です' }, 400);

  const records = await getVocabRecords(c.env.DB, gate.friend.id, bookId);
  return c.json({ success: true, ...records });
});

vocab.post('/api/vocab/sessions', async (c) => {
  const gate = await requireStudent(c);
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }

  const body = await c.req.json<{
    client_session_id?: string;
    book_id?: number;
    kind?: string;
    range_from?: number | null;
    range_to?: number | null;
    format?: string;
    direction?: string;
    order_mode?: string;
    timer_sec?: number;
    started_at?: string;
    finished_at?: string;
    answers?: { word_id: number; ok: number; timed_out?: number; elapsed_ms?: number | null }[];
  }>();

  if (!body.client_session_id || !body.book_id || !Array.isArray(body.answers)) {
    return c.json({ success: false, error: 'client_session_id / book_id / answers は必須です' }, 400);
  }
  if (body.answers.length > MAX_WORDS_PER_REQUEST) {
    return c.json({ success: false, error: '1セッションの解答が多すぎます' }, 400);
  }

  const book = await getVocabBookById(c.env.DB, body.book_id);
  if (!book) return c.json({ success: false, error: '単語帳が見つかりません' }, 404);

  const kind = ['normal', 'review', 'retry'].includes(body.kind || '') ? (body.kind as string) : 'normal';
  const format = body.format === 'recall' ? 'recall' : 'choice';
  const direction = body.direction === 'je' ? 'je' : 'ej';
  const orderMode = body.order_mode === 'rnd' ? 'rnd' : 'seq';

  // クライアントの時計は信用しきらない。壊れていたらサーバー時刻に倒す。
  const now = jstNow();
  const safeTime = (v: string | undefined): string =>
    v && !Number.isNaN(new Date(v).getTime()) ? v : now;

  const result = await saveVocabSession(c.env.DB, {
    clientSessionId: body.client_session_id,
    friendId: gate.friend.id,
    lineAccountId: gate.friend.line_account_id,
    bookId: body.book_id,
    kind,
    rangeFrom: body.range_from ?? null,
    rangeTo: body.range_to ?? null,
    format,
    direction,
    orderMode,
    timerSec: Number(body.timer_sec) || 0,
    startedAt: safeTime(body.started_at),
    finishedAt: safeTime(body.finished_at),
    answers: body.answers.map((a) => ({
      word_id: Number(a.word_id),
      ok: a.ok ? 1 : 0,
      timed_out: a.timed_out ? 1 : 0,
      elapsed_ms: a.elapsed_ms ?? null,
    })),
  });

  return c.json({ success: true, ...result });
});

// ── 講師用（API_KEY。authMiddleware が先に弾く） ────────────────────────────

vocab.get('/api/vocab/admin/students', async (c) => {
  const lineAccountId = c.req.query('lineAccountId') || c.env.VOCAB_LINE_ACCOUNT_ID || null;
  const tagId = c.req.query('tagId') || null;
  const students = await getVocabStudents(c.env.DB, lineAccountId, tagId);
  return c.json({ success: true, students });
});

vocab.get('/api/vocab/admin/students/:friendId', async (c) => {
  const friendId = c.req.param('friendId');
  const detail = await getVocabStudentDetail(c.env.DB, friendId);
  return c.json({ success: true, ...detail });
});

vocab.get('/api/vocab/admin/sessions/:sessionId/answers', async (c) => {
  const sessionId = Number(c.req.param('sessionId'));
  if (!sessionId) return c.json({ success: false, error: 'sessionId が不正です' }, 400);
  const answers = await getVocabSessionAnswers(c.env.DB, sessionId);
  return c.json({ success: true, answers });
});

vocab.get('/api/vocab/admin/books', async (c) => {
  const books = await getVocabBooks(c.env.DB, c.req.query('lineAccountId') || null);
  return c.json({ success: true, books });
});

/**
 * 単語帳の登録・更新（貼り付け or JSON）。
 *
 * 単語データはリポジトリに置かない方針なので、投入はこのエンドポイントか
 * ローカルからの d1 execute で行う。
 */
vocab.post('/api/vocab/admin/books', async (c) => {
  const body = await c.req.json<{
    slug?: string;
    name?: string;
    lineAccountId?: string | null;
    sort?: number;
    words?: { no: number; en: string; ja: string; section?: string | null }[];
    tsv?: string;
  }>();

  if (!body.slug || !body.name) {
    return c.json({ success: false, error: 'slug / name は必須です' }, 400);
  }

  let words = body.words ?? [];
  if (!words.length && body.tsv) {
    words = parseTsv(body.tsv);
  }

  const book = await upsertVocabBook(c.env.DB, {
    slug: body.slug,
    name: body.name,
    lineAccountId: body.lineAccountId ?? null,
    sort: body.sort ?? 0,
  });

  const count = words.length ? await replaceVocabWords(c.env.DB, book.id, words) : 0;
  return c.json({ success: true, book, imported: count });
});

/** `No<TAB>単語<TAB>意味<TAB>章` を想定。カンマ区切りも受ける。 */
function parseTsv(raw: string): { no: number; en: string; ja: string; section: string | null }[] {
  const out: { no: number; en: string; ja: string; section: string | null }[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split(/\t|,/).map((x) => x.trim());
    if (cells.length < 2) continue;
    if (/^\d+$/.test(cells[0]) && cells.length >= 3) {
      out.push({ no: Number(cells[0]), en: cells[1], ja: cells[2], section: cells[4] || cells[3] || null });
    } else {
      out.push({ no: out.length + 1, en: cells[0], ja: cells[1], section: cells[2] || null });
    }
  }
  return out;
}
