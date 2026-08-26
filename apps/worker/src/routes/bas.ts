/**
 * 並び替えテスト（Build a Sentence／受講生専用）
 *
 * 単語テスト（`routes/vocab.ts`）・文法テスト（`routes/grammar.ts`）の弟。
 * アクセス制御の考え方は完全に同じなので、ゲートは `lib/student-gate.ts` を共有する。
 *
 * 生徒用は LIFF の idToken、講師用は API_KEY。認証経路を混ぜないこと。
 * 生徒用エンドポイントは authMiddleware をスキップさせている（Authorization ヘッダを
 * API_KEY ではなく idToken に使うため）。したがって**ゲートが唯一の壁**。
 * 各ハンドラの先頭で必ず requireStudent() を通す。
 *
 * ★ 出題はセット単位ではなく**プール全体**から行う。
 *   入り口は3つだけ：総合ランダム / 弱点だけ復習 / 記号を指定して解く。
 *   「第N週の100問」を選ばせる画面は作らない。
 */

import { Hono } from 'hono';
import {
  getBasTypes,
  getBasSets,
  getBasMixedQuestions,
  getBasTypeQuestions,
  getBasWeakQuestions,
  getBasDashboard,
  getBasTypeStats,
  groupBasTypeStats,
  saveBasSession,
  getBasSessionAnswers,
  getBasQuestions,
  upsertBasSet,
  upsertBasQuestions,
  replaceBasTypes,
  jstNow,
  type BasKind,
  type BasQuestionInput,
  type BasTypeRow,
} from '@line-crm/db';
import { requireStudent, denied } from '../lib/student-gate.js';
import type { Env } from '../index.js';

export const bas = new Hono<Env>();

/** 1回のテストで出せる問題数の上限。並び替えは1問が重いので文法より小さく取る。 */
const MAX_QUESTIONS_PER_REQUEST = 50;
/** 制限時間は10秒刻みで60秒まで。0 は「なし」。 */
const ALLOWED_TIMERS = [0, 10, 20, 30, 40, 50, 60];

// ── 生徒用 ──────────────────────────────────────────────────────────────────

/** ホーム。プールの大きさ・型カタログ・弱点の要約を1回で返す。 */
bas.get('/api/bas/home', async (c) => {
  const gate = await requireStudent(c, 'bas');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const accountId = gate.friend.line_account_id;
  // プールの大きさは dashboard が既に数えている。別に数え直さない
  const [types, sets, dashboard] = await Promise.all([
    getBasTypes(c.env.DB),
    getBasSets(c.env.DB, accountId),
    getBasDashboard(c.env.DB, gate.friend.id, accountId),
  ]);
  return c.json({
    success: true,
    pool: dashboard.pool,
    sets: sets.map((s) => ({ slug: s.slug, name: s.name })),
    types,
    dashboard,
    timers: ALLOWED_TIMERS,
  });
});

/**
 * 出題。
 *
 * `kind` は必須。**絞らずにプールを丸ごと返す経路は作らない。**
 * 弱点復習で弱点がまだ決まらないときは、問題ゼロで返す（適当な問題を
 * 「弱点」として出さない）。画面側で総合ランダムに誘導する。
 */
bas.get('/api/bas/questions', async (c) => {
  const gate = await requireStudent(c, 'bas');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }

  const kind = (c.req.query('kind') || 'mixed') as BasKind;
  const typeCode = c.req.query('type') || null;
  const limit = Number(c.req.query('limit') || 10);

  if (!['mixed', 'weak', 'type'].includes(kind)) {
    return c.json({ success: false, error: 'kind が不正です' }, 400);
  }
  if (kind === 'type' && !typeCode) {
    return c.json({ success: false, error: '記号を指定してください' }, 400);
  }
  if (!Number.isFinite(limit) || limit < 1 || limit > MAX_QUESTIONS_PER_REQUEST) {
    return c.json(
      { success: false, error: `1回に取得できるのは${MAX_QUESTIONS_PER_REQUEST}問までです` },
      400,
    );
  }

  const accountId = gate.friend.line_account_id;
  try {
    if (kind === 'weak') {
      const { questions, types } = await getBasWeakQuestions(
        c.env.DB,
        gate.friend.id,
        accountId,
        limit,
      );
      return c.json({ success: true, questions, weak_types: types });
    }
    if (kind === 'type') {
      const questions = await getBasTypeQuestions(c.env.DB, accountId, typeCode!, limit);
      return c.json({ success: true, questions });
    }
    const questions = await getBasMixedQuestions(c.env.DB, accountId, limit);
    return c.json({ success: true, questions });
  } catch (e) {
    // 画面には「通信に失敗しました」としか出ないので、原因はここに残す
    console.error(
      `[bas/questions] friend=${gate.friend.id} kind=${kind} type=${typeCode} limit=${limit}`,
      e,
    );
    return c.json(
      { success: false, error: '問題の準備に失敗しました。時間をおいて試してください' },
      500,
    );
  }
});

/** 弱点。大分類→型の2階層で返す。 */
bas.get('/api/bas/weakness', async (c) => {
  const gate = await requireStudent(c, 'bas');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const stats = await getBasTypeStats(c.env.DB, gate.friend.id, gate.friend.line_account_id);
  return c.json({ success: true, groups: groupBasTypeStats(stats), types: stats });
});

bas.get('/api/bas/dashboard', async (c) => {
  const gate = await requireStudent(c, 'bas');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const dashboard = await getBasDashboard(
    c.env.DB,
    gate.friend.id,
    gate.friend.line_account_id,
  );
  return c.json({ success: true, dashboard });
});

/** 結果の保存。採点はここでやり直す（クライアントの ok は受け取らない）。 */
bas.post('/api/bas/sessions', async (c) => {
  const gate = await requireStudent(c, 'bas');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }

  const body = await c.req.json<{
    client_session_id?: string;
    kind?: BasKind;
    focus_type?: string | null;
    timer_sec?: number;
    started_at?: string;
    answers?: {
      question_id: number;
      submitted: string[] | null;
      timed_out?: number;
      elapsed_ms?: number | null;
    }[];
  }>();

  if (!body.client_session_id) {
    return c.json({ success: false, error: 'client_session_id は必須です' }, 400);
  }
  const answers = body.answers ?? [];
  if (!answers.length) {
    return c.json({ success: false, error: '解答がありません' }, 400);
  }
  if (answers.length > MAX_QUESTIONS_PER_REQUEST) {
    return c.json({ success: false, error: '解答が多すぎます' }, 400);
  }

  const timerSec = ALLOWED_TIMERS.includes(Number(body.timer_sec)) ? Number(body.timer_sec) : 0;

  try {
    const result = await saveBasSession(c.env.DB, {
      clientSessionId: body.client_session_id,
      friendId: gate.friend.id,
      lineAccountId: gate.friend.line_account_id,
      // 'retry'（結果画面からの解き直し）も記録に残す。
      // 出題の入り口ではないので /questions では受けないが、セッションとしては別物。
      kind: (['mixed', 'weak', 'type', 'retry'].includes(body.kind ?? '')
        ? body.kind
        : 'mixed') as BasKind,
      focusType: body.focus_type ?? null,
      timerSec,
      startedAt: body.started_at || jstNow(),
      finishedAt: jstNow(),
      answers: answers.map((a) => ({
        question_id: Number(a.question_id),
        submitted: Array.isArray(a.submitted) ? a.submitted.map((s) => String(s)) : null,
        timed_out: a.timed_out ? 1 : 0,
        elapsed_ms: a.elapsed_ms ?? null,
      })),
    });
    return c.json({ success: true, ...result });
  } catch (e) {
    console.error(`[bas/sessions] friend=${gate.friend.id}`, e);
    return c.json({ success: false, error: '結果の保存に失敗しました' }, 500);
  }
});

bas.get('/api/bas/sessions/:id/answers', async (c) => {
  const gate = await requireStudent(c, 'bas');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const sessionId = Number(c.req.param('id'));
  if (!Number.isFinite(sessionId)) {
    return c.json({ success: false, error: 'session id が不正です' }, 400);
  }
  // 他人のセッションを覗けないよう、必ず friend_id で確かめる
  const own = await c.env.DB.prepare(`SELECT 1 FROM bas_sessions WHERE id = ? AND friend_id = ?`)
    .bind(sessionId, gate.friend.id)
    .first();
  if (!own) {
    const d = denied(403);
    return c.json(d.body, d.status);
  }
  const answers = await getBasSessionAnswers(c.env.DB, sessionId);
  return c.json({ success: true, answers });
});

// ── 講師用（API_KEY で守られる。authMiddleware を素通ししない） ──────────────

bas.post('/api/bas/admin/types', async (c) => {
  const body = await c.req.json<{ types?: BasTypeRow[] }>();
  const types = body.types ?? [];
  if (!types.length) return c.json({ success: false, error: 'types が空です' }, 400);
  const n = await replaceBasTypes(c.env.DB, types);
  return c.json({ success: true, count: n });
});

bas.get('/api/bas/admin/sets', async (c) => {
  const sets = await getBasSets(c.env.DB, c.req.query('lineAccountId') ?? null);
  return c.json({ success: true, sets });
});

bas.post('/api/bas/admin/sets', async (c) => {
  const body = await c.req.json<{
    slug?: string;
    name?: string;
    lineAccountId?: string | null;
    sort?: number;
    questions?: BasQuestionInput[];
  }>();
  if (!body.slug || !body.name) {
    return c.json({ success: false, error: 'slug と name は必須です' }, 400);
  }
  const set = await upsertBasSet(c.env.DB, {
    slug: body.slug,
    name: body.name,
    lineAccountId: body.lineAccountId ?? null,
    sort: body.sort ?? 0,
  });
  let count = 0;
  if (body.questions?.length) {
    count = await upsertBasQuestions(c.env.DB, set.id, body.questions);
  }
  return c.json({ success: true, set, count });
});

bas.get('/api/bas/admin/sets/:id/questions', async (c) => {
  const setId = Number(c.req.param('id'));
  if (!Number.isFinite(setId)) return c.json({ success: false, error: 'set id が不正です' }, 400);
  const questions = await getBasQuestions(c.env.DB, setId);
  return c.json({ success: true, questions });
});
