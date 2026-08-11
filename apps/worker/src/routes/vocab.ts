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
  getSectionTestWords,
  getVocabDecoys,
  getReviewWords,
  getCheckupWords,
  getVocabDashboard,
  getVocabRecords,
  saveVocabSession,
  getVocabSessionAnswers,
  getSelectedBookId,
  setSelectedBookId,
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

/**
 * 1リクエストで返す語数の上限。
 *
 * 「範囲を指定せずに単語帳を丸ごと取る」経路を作らないための線引きであって、
 * 受講生を縛るためのものではない（`10-access-control.md`）。
 * 出題数に「全部」を入れたので、1回のテストとして現実的な上限まで広げてある。
 */
const MAX_WORDS_PER_REQUEST = 500;
const MAX_REVIEW_WORDS = 20;
/** 実力テストで選べる問題数。多いほど点が安定する（20問は±9点、50問は±6点）。 */
const CHECKUP_SIZES = [20, 30, 50];

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

  // 状態（未挑戦／復習が必要／習得済み）を見て枠を配る。毎回ランダムに引くと
  // 2回目以降がただの引き直しになり、セクションが埋まらない。
  const words = await getSectionTestWords(c.env.DB, gate.friend.id, bookId, from, to, limit);
  if (!words.length) {
    return c.json({ success: true, words: [], decoys: [] });
  }

  // 4択のダミー。出題語だけで作ると選択肢が足りない場面があるので、必ず補充分を渡す。
  const decoys = await getVocabDecoys(
    c.env.DB,
    bookId,
    words.map((w) => w.id),
    8,
  );

  return c.json({ success: true, words, decoys });
});

/** 使う単語帳を決める／あとから切り替える。 */
vocab.put('/api/vocab/book', async (c) => {
  const gate = await requireStudent(c);
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const body = await c.req.json<{ book_id?: number }>();
  const bookId = Number(body.book_id);
  if (!bookId) return c.json({ success: false, error: 'book_id は必須です' }, 400);

  const book = await getVocabBookById(c.env.DB, bookId);
  if (!book || !book.active) return c.json({ success: false, error: '単語帳が見つかりません' }, 404);

  await setSelectedBookId(c.env.DB, gate.friend.id, bookId);
  return c.json({ success: true, selected_book_id: await getSelectedBookId(c.env.DB, gate.friend.id) });
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

  // 復習語が3語以下だと、出題語だけでは4択の選択肢が埋まらない（1語なら答えが自明になる）。
  // ダミーは必ずサーバーで用意する。
  const decoys = words.length
    ? await getVocabDecoys(
        c.env.DB,
        bookId,
        words.map((w) => w.id),
        8,
      )
    : [];
  return c.json({ success: true, count: words.length, words, decoys });
});

/**
 * 今日の定着テスト。単語帳の全範囲からランダムに20問。
 *
 * 範囲を絞らないので `MAX_WORDS_PER_REQUEST` の範囲チェックは通らない。
 * ここは語数を20に固定することで「全件取得の経路を作らない」線引きを守る。
 */
vocab.get('/api/vocab/checkup', async (c) => {
  const gate = await requireStudent(c);
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const bookId = Number(c.req.query('book_id'));
  if (!bookId) return c.json({ success: false, error: 'book_id は必須です' }, 400);

  const size = CHECKUP_SIZES.includes(Number(c.req.query('size')))
    ? Number(c.req.query('size'))
    : CHECKUP_SIZES[0];
  const words = await getCheckupWords(c.env.DB, bookId, size);
  if (!words.length) return c.json({ success: true, words: [], decoys: [] });

  // 全範囲から散らばって出るので、4択のダミーは必ずサーバー側で用意する
  const decoys = await getVocabDecoys(
    c.env.DB,
    bookId,
    words.map((w) => w.id),
    12,
  );
  return c.json({ success: true, words, decoys });
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

  const kind = ['normal', 'review', 'retry', 'checkup'].includes(body.kind || '')
    ? (body.kind as string)
    : 'normal';
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
  // 既定で受講生タグに絞る。単語テストを開けるのはタグ持ちだけなので、
  // 一覧に保護者やタグ無しの友だちが混ざると「未実施」の数が意味を失う。
  const tagId = c.req.query('tagId') || c.env.VOCAB_ALLOW_TAG_ID || null;
  const students = await getVocabStudents(c.env.DB, lineAccountId, tagId);
  return c.json({ success: true, students });
});

vocab.get('/api/vocab/admin/students/:friendId', async (c) => {
  const friendId = c.req.param('friendId');
  const bookId = Number(c.req.query('book_id')) || null;
  const detail = await getVocabStudentDetail(c.env.DB, friendId, bookId);
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
