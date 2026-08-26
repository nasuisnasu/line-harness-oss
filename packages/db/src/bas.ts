/**
 * 並び替えテスト（Build a Sentence）— クエリと集計
 *
 * 文法テスト（`grammar.ts`）の弟。指標の考え方はそちらと揃えてある。
 *
 *   1. 問題ごとの状態は「直近の解答」で決める。何回やったかではなく、いま解けるか。
 *   2. 時間切れは不正解。
 *   3. 時刻はサーバーが JST で打つ。クライアントの時計は信じない。
 *
 * ★ 文法テストとの決定的な違いが2つある。
 *
 *   (1) **採点をサーバーでやり直す。**
 *       4択は「どれを選んだか」だけが残ればよかったが、並び替えは提出された
 *       並びそのものが答えなので、サーバーで組み直して照合できる。できるなら
 *       やる。クライアントの ok をそのまま信じる理由がない。
 *
 *   (2) **弱点は「分野」ではなく「型（A1〜G4）」で見る。**
 *       1問が型を複数持つ（["E1","B3","G2"]）ので、解答を型ごとにばらして
 *       `bas_answer_types` に落としてある。集計はそこを GROUP BY するだけ。
 */

import { jstNow } from './utils';

// ── 型 ──────────────────────────────────────────────────────────────────────

export interface BasSet {
  id: number;
  line_account_id: string | null;
  slug: string;
  name: string;
  sort: number;
  active: number;
  created_at: string;
}

export interface BasTypeRow {
  code: string;
  group_code: string;
  group_name: string;
  name: string;
  hint: string | null;
  sort: number;
}

export interface BasQuestionRow {
  id: number;
  set_id: number;
  no: number;
  lead: string;
  frame: string;
  answer: string;
  extra: string | null;
  types: string;
  steps: string;
  sentence: string;
  ja: string;
  level: string | null;
  accepted: string | null;
}

/** 出題1問。`words` はシャッフル済みなので、そのまま並べて出せる。 */
export interface BasQuestion {
  id: number;
  no: number;
  lead: string;
  frame: string;
  blanks: number;
  words: string[];
  answer: string[];
  /** 意味が変わらない別解の並び。完全一致で採点するので、ここに無いと誤答になる */
  accepted: string[][];
  extra: string | null;
  types: string[];
  steps: string[];
  sentence: string;
  ja: string;
}

/**
 * 出題の入り口。セットは選ばせない（プール全体から出す）。
 *
 * 'retry' だけは入り口ではなく**結果画面から**始まる。
 * その回で落とした問題をその場で解き直すので、サーバーに問題を取りに行かない。
 */
export type BasKind = 'mixed' | 'weak' | 'type' | 'retry';

export interface BasSession {
  id: number;
  client_session_id: string;
  friend_id: string;
  line_account_id: string | null;
  kind: string;
  focus_type: string | null;
  timer_sec: number;
  started_at: string;
  finished_at: string;
  total: number;
  correct: number;
}

// ── 採点 ────────────────────────────────────────────────────────────────────

/**
 * 並びを照合用の1本の文字列にする。
 *
 * 語群チップは文頭だけ小文字に落として表示するので、提出された語と
 * `answer` の語で**大文字小文字がずれる**。そこを吸収する。
 *
 * 語ごとではなく**つないだ文**で比べているのが肝。同じ語（the が2つ等）が
 * 語群にあるとき、どちらのチップを先に置いても文が同じなら正解にしたい。
 * 添字で比べると、見た目がまったく同じ文を不正解にしてしまう。
 */
function normalizeOrder(words: string[]): string {
  return words
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 採点。
 *
 * `accepted` は**意味が変わらない別解**。並び替えは1つの語群から
 * 複数の正しい文が作れることがあるので、そこを潰して問題を易しくするより、
 * 採点側で許すほうがよい（→ 067_bas_accepted.sql）。
 * 主語と目的語を入れ替えたような、意味が変わるものはここに入れない。
 */
export function gradeBas(
  submitted: string[] | null,
  answer: string[],
  accepted: string[][] = [],
): boolean {
  if (!submitted || !submitted.length) return false;
  const got = normalizeOrder(submitted);
  if (got === normalizeOrder(answer)) return true;
  return accepted.some((alt) => normalizeOrder(alt) === got);
}

// ── 行 → API の形 ───────────────────────────────────────────────────────────

/** 別解（配列の配列）。1問のデータ不備でテスト全体を落とさない。 */
function parseAccepted(raw: string | null): string[][] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x) => Array.isArray(x))
      .map((x: unknown[]) => x.map((y) => String(y)))
      .filter((x) => x.length > 0);
  } catch {
    return [];
  }
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    // 1問のデータ不備でテスト全体を 500 にしない。呼び出し側が空を弾く。
    return [];
  }
}

/** 実行のたびに違う並びにする。並びを覚えて解かれると測れない。 */
function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function toBasQuestion(row: BasQuestionRow): BasQuestion {
  const answer = parseJsonArray(row.answer);
  const extra = row.extra && row.extra.trim() ? row.extra.trim() : null;

  // 語群チップの1つめだけ大文字のままだと、文頭がそこだと丸見えになる。
  // 表示用に小文字へ落とす（I / I'll などの一人称だけは残す）。
  const disp = answer.slice();
  if (disp.length && !/^I(\b|')/.test(disp[0])) {
    disp[0] = disp[0].charAt(0).toLowerCase() + disp[0].slice(1);
  }

  let words = shuffle(extra ? [...disp, extra] : disp);
  // まれに正解の並びのまま出てしまうので、そのときだけ引っくり返す
  if (words.length > 2 && normalizeOrder(words.slice(0, answer.length)) === normalizeOrder(answer)) {
    words = words.reverse();
  }

  return {
    id: row.id,
    no: row.no,
    lead: row.lead,
    frame: row.frame,
    blanks: (row.frame.match(/\{\}/g) ?? []).length,
    words,
    answer,
    accepted: parseAccepted(row.accepted),
    extra,
    types: parseJsonArray(row.types),
    steps: parseJsonArray(row.steps),
    sentence: row.sentence,
    ja: row.ja,
  };
}

// ── 型カタログ ──────────────────────────────────────────────────────────────

export async function getBasTypes(db: D1Database): Promise<BasTypeRow[]> {
  const rows = await db
    .prepare(`SELECT * FROM bas_types ORDER BY sort ASC, code ASC`)
    .all<BasTypeRow>();
  return rows.results;
}

export async function getBasSets(
  db: D1Database,
  lineAccountId?: string | null,
): Promise<BasSet[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM bas_sets
       WHERE active = 1 AND (line_account_id IS NULL OR line_account_id = ?)
       ORDER BY sort ASC, id ASC`,
    )
    .bind(lineAccountId ?? null)
    .all<BasSet>();
  return rows.results;
}

/** プールの大きさ。生徒に「いま何問あるか」を出すためだけに使う。 */
export async function getBasPoolSize(
  db: D1Database,
  lineAccountId?: string | null,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM bas_questions q
       JOIN bas_sets s ON s.id = q.set_id
       WHERE s.active = 1 AND (s.line_account_id IS NULL OR s.line_account_id = ?)`,
    )
    .bind(lineAccountId ?? null)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ── 出題 ────────────────────────────────────────────────────────────────────

const POOL_JOIN = `JOIN bas_sets s ON s.id = q.set_id
   AND s.active = 1 AND (s.line_account_id IS NULL OR s.line_account_id = ?)`;

/** 総合ランダム。プール全体から素直に引く（実力チェック用なので偏らせない）。 */
export async function getBasMixedQuestions(
  db: D1Database,
  lineAccountId: string | null,
  limit: number,
): Promise<BasQuestion[]> {
  const rows = await db
    .prepare(
      `SELECT q.* FROM bas_questions q ${POOL_JOIN}
       ORDER BY RANDOM() LIMIT ?`,
    )
    .bind(lineAccountId ?? null, limit)
    .all<BasQuestionRow>();
  return rows.results.map(toBasQuestion).filter((q) => q.answer.length > 0);
}

/** 記号を指定して解く。'E1 の問題だけ10問' の経路。 */
export async function getBasTypeQuestions(
  db: D1Database,
  lineAccountId: string | null,
  typeCode: string,
  limit: number,
): Promise<BasQuestion[]> {
  const rows = await db
    .prepare(
      `SELECT q.* FROM bas_questions q ${POOL_JOIN}
       WHERE EXISTS (SELECT 1 FROM json_each(q.types) t WHERE t.value = ?)
       ORDER BY RANDOM() LIMIT ?`,
    )
    .bind(lineAccountId ?? null, typeCode, limit)
    .all<BasQuestionRow>();
  return rows.results.map(toBasQuestion).filter((q) => q.answer.length > 0);
}

/** 弱点だけ復習するときに、何回やった型から「弱い」と判断してよいか。 */
export const MIN_TRIED_FOR_WEAK = 3;
/** この正答率を下回る型を弱点とみなす（%）。 */
export const WEAK_RATE_THRESHOLD = 80;

/**
 * 弱点復習。
 *
 * 順番は3段。**間違い直しが最優先**で、そのあとに未挑戦、最後に既に解けた問題。
 * 「弱い型を含む問題」で絞ったうえでこの順に並べるので、
 * 苦手な型の中の、まだ落としたままの問題から出てくる。
 *
 * 弱点がまだ決まらない（解答数が足りない）ときは空を返す。
 * 適当な問題を「弱点」として出すと、集計を信じてもらえなくなる。
 */
export async function getBasWeakQuestions(
  db: D1Database,
  friendId: string,
  lineAccountId: string | null,
  limit: number,
): Promise<{ questions: BasQuestion[]; types: string[] }> {
  const stats = await getBasTypeStats(db, friendId, lineAccountId);
  const weak = stats
    .filter((t) => t.tried >= MIN_TRIED_FOR_WEAK && t.rate < WEAK_RATE_THRESHOLD)
    .sort((a, b) => a.rate - b.rate || b.tried - a.tried)
    .slice(0, 6)
    .map((t) => t.code);

  if (!weak.length) return { questions: [], types: [] };

  const marks = weak.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `WITH latest AS (
         SELECT question_id, ok,
                ROW_NUMBER() OVER (PARTITION BY question_id ORDER BY answered_at DESC, id DESC) AS rn
         FROM bas_answers WHERE friend_id = ?
       ),
       last AS (SELECT question_id, ok FROM latest WHERE rn = 1)
       SELECT q.*,
              CASE WHEN l.ok = 0 THEN 0
                   WHEN l.question_id IS NULL THEN 1
                   ELSE 2 END AS pri
       FROM bas_questions q ${POOL_JOIN}
       LEFT JOIN last l ON l.question_id = q.id
       WHERE EXISTS (SELECT 1 FROM json_each(q.types) t WHERE t.value IN (${marks}))
       ORDER BY pri ASC, RANDOM() LIMIT ?`,
    )
    .bind(friendId, lineAccountId ?? null, ...weak, limit)
    .all<BasQuestionRow>();

  return {
    questions: rows.results.map(toBasQuestion).filter((q) => q.answer.length > 0),
    types: weak,
  };
}

// ── 集計 ────────────────────────────────────────────────────────────────────

export interface BasTypeStat {
  code: string;
  group_code: string;
  group_name: string;
  name: string;
  hint: string | null;
  /** プールにこの型を含む問題が何問あるか */
  total: number;
  /** そのうち1回以上解いた問題数（直近の解答ベース） */
  tried: number;
  ok: number;
  /** 0〜100。tried が 0 なら 0 */
  rate: number;
}

export interface BasGroupStat {
  code: string;
  name: string;
  total: number;
  tried: number;
  ok: number;
  rate: number;
  types: BasTypeStat[];
}

/**
 * 型ごとの成績。
 *
 * **同じ問題を何回解いても1件として数える**（直近の解答だけを見る）。
 * 延べ回数で数えると、解き直した問題が多いだけで正答率が動いてしまい、
 * 「いま何が弱いか」を表さなくなる。
 */
export async function getBasTypeStats(
  db: D1Database,
  friendId: string,
  lineAccountId: string | null,
): Promise<BasTypeStat[]> {
  const types = await getBasTypes(db);

  const totals = await db
    .prepare(
      `SELECT t.value AS code, COUNT(*) AS total
       FROM bas_questions q ${POOL_JOIN}
       CROSS JOIN json_each(q.types) t
       GROUP BY t.value`,
    )
    .bind(lineAccountId ?? null)
    .all<{ code: string; total: number }>();
  const totalMap = new Map(totals.results.map((r) => [r.code, r.total]));

  const agg = await db
    .prepare(
      `WITH latest AS (
         SELECT question_id, type_code, ok,
                ROW_NUMBER() OVER (
                  PARTITION BY question_id, type_code ORDER BY answered_at DESC, id DESC
                ) AS rn
         FROM bas_answer_types WHERE friend_id = ?
       )
       SELECT type_code AS code, COUNT(*) AS tried, SUM(ok) AS ok
       FROM latest WHERE rn = 1 GROUP BY type_code`,
    )
    .bind(friendId)
    .all<{ code: string; tried: number; ok: number }>();
  const aggMap = new Map(agg.results.map((r) => [r.code, r]));

  return types.map((t) => {
    const a = aggMap.get(t.code);
    const tried = a?.tried ?? 0;
    const ok = a?.ok ?? 0;
    return {
      code: t.code,
      group_code: t.group_code,
      group_name: t.group_name,
      name: t.name,
      hint: t.hint,
      total: totalMap.get(t.code) ?? 0,
      tried,
      ok,
      rate: tried ? Math.round((ok / tried) * 100) : 0,
    };
  });
}

/** 大分類（A〜G）に畳む。画面はまずこの粒度で出して、開くと型が並ぶ。 */
export function groupBasTypeStats(stats: BasTypeStat[]): BasGroupStat[] {
  const map = new Map<string, BasGroupStat>();
  for (const s of stats) {
    let g = map.get(s.group_code);
    if (!g) {
      g = { code: s.group_code, name: s.group_name, total: 0, tried: 0, ok: 0, rate: 0, types: [] };
      map.set(s.group_code, g);
    }
    g.total += s.total;
    g.tried += s.tried;
    g.ok += s.ok;
    g.types.push(s);
  }
  const out = [...map.values()];
  for (const g of out) {
    g.rate = g.tried ? Math.round((g.ok / g.tried) * 100) : 0;
    // 型は「弱い順」。まだ解いていない型は下に落とす（0% と混ざると読めない）
    g.types.sort((a, b) => {
      if (!a.tried !== !b.tried) return a.tried ? -1 : 1;
      return a.rate - b.rate || b.tried - a.tried;
    });
  }
  out.sort((a, b) => {
    if (!a.tried !== !b.tried) return a.tried ? -1 : 1;
    return a.rate - b.rate || a.code.localeCompare(b.code);
  });
  return out;
}

export interface BasRecentSession {
  id: number;
  kind: string;
  focus_type: string | null;
  timer_sec: number;
  total: number;
  correct: number;
  finished_at: string;
}

export interface BasDashboard {
  pool: number;
  tried: number;
  sessions: number;
  answered: number;
  correct: number;
  rate: number;
  groups: BasGroupStat[];
  /** ワースト。tried が閾値に届かないうちは空（当てにならない数字を出さない） */
  weak: BasTypeStat[];
  recent: BasRecentSession[];
}

export async function getBasDashboard(
  db: D1Database,
  friendId: string,
  lineAccountId: string | null,
): Promise<BasDashboard> {
  const pool = await getBasPoolSize(db, lineAccountId);

  const tried = await db
    .prepare(`SELECT COUNT(DISTINCT question_id) AS n FROM bas_answers WHERE friend_id = ?`)
    .bind(friendId)
    .first<{ n: number }>();

  const sess = await db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total, COALESCE(SUM(correct),0) AS correct
       FROM bas_sessions WHERE friend_id = ?`,
    )
    .bind(friendId)
    .first<{ n: number; total: number; correct: number }>();

  const recent = await db
    .prepare(
      `SELECT id, kind, focus_type, timer_sec, total, correct, finished_at
       FROM bas_sessions WHERE friend_id = ?
       ORDER BY finished_at DESC, id DESC LIMIT 10`,
    )
    .bind(friendId)
    .all<BasRecentSession>();

  const stats = await getBasTypeStats(db, friendId, lineAccountId);
  const weak = stats
    .filter((t) => t.tried >= MIN_TRIED_FOR_WEAK && t.rate < WEAK_RATE_THRESHOLD)
    .sort((a, b) => a.rate - b.rate || b.tried - a.tried)
    .slice(0, 5);

  const answered = sess?.total ?? 0;
  const correct = sess?.correct ?? 0;

  return {
    pool,
    tried: tried?.n ?? 0,
    sessions: sess?.n ?? 0,
    answered,
    correct,
    rate: answered ? Math.round((correct / answered) * 100) : 0,
    groups: groupBasTypeStats(stats),
    weak,
    recent: recent.results,
  };
}

// ── 保存 ────────────────────────────────────────────────────────────────────

export interface SaveBasSessionInput {
  clientSessionId: string;
  friendId: string;
  lineAccountId: string | null;
  kind: BasKind;
  focusType: string | null;
  timerSec: number;
  startedAt: string;
  finishedAt: string;
  answers: {
    question_id: number;
    submitted: string[] | null;
    timed_out: number;
    elapsed_ms: number | null;
  }[];
}

export interface SaveBasSessionResult {
  session_id: number;
  total: number;
  correct: number;
  duplicated: boolean;
  /** サーバーが付け直した正誤。クライアントの表示と食い違ったらこちらが正 */
  results: { question_id: number; ok: number }[];
}

/**
 * 結果画面から1回だけ呼ばれる。
 *
 * `client_session_id` が既にあれば**何も書かずに**既存の結果を返す。
 * 再送で二重登録されないようにするため、ここは必ず先に確認する。
 */
export async function saveBasSession(
  db: D1Database,
  input: SaveBasSessionInput,
): Promise<SaveBasSessionResult> {
  const existing = await db
    .prepare(`SELECT * FROM bas_sessions WHERE client_session_id = ?`)
    .bind(input.clientSessionId)
    .first<BasSession>();

  if (existing) {
    const prev = await db
      .prepare(`SELECT question_id, ok FROM bas_answers WHERE session_id = ?`)
      .bind(existing.id)
      .all<{ question_id: number; ok: number }>();
    return {
      session_id: existing.id,
      total: existing.total,
      correct: existing.correct,
      duplicated: true,
      results: prev.results,
    };
  }

  // 出題した問題の正解と型を引き直す。**クライアントの申告は採点にも集計にも使わない。**
  const ids = [...new Set(input.answers.map((a) => a.question_id))];
  const meta = new Map<number, { answer: string[]; accepted: string[][]; types: string[] }>();
  const ID_CHUNK = 80; // D1 のバインド上限（100）に余裕を持たせる
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const part = ids.slice(i, i + ID_CHUNK);
    const rows = await db
      .prepare(
        `SELECT id, answer, accepted, types FROM bas_questions
         WHERE id IN (${part.map(() => '?').join(',')})`,
      )
      .bind(...part)
      .all<{ id: number; answer: string; accepted: string | null; types: string }>();
    for (const r of rows.results) {
      meta.set(r.id, {
        answer: parseJsonArray(r.answer),
        accepted: parseAccepted(r.accepted),
        types: parseJsonArray(r.types),
      });
    }
  }

  const graded = input.answers.map((a) => {
    const m = meta.get(a.question_id);
    const timedOut = a.timed_out ? 1 : 0;
    // 時間切れは提出内容にかかわらず不正解。未提出も同じ。
    const ok = timedOut || !m ? 0 : gradeBas(a.submitted, m.answer, m.accepted) ? 1 : 0;
    return {
      question_id: a.question_id,
      ok,
      submitted: timedOut ? null : a.submitted,
      timed_out: timedOut,
      elapsed_ms: a.elapsed_ms,
      types: m?.types ?? [],
    };
  });

  const total = graded.length;
  const correct = graded.filter((g) => g.ok === 1).length;

  const inserted = await db
    .prepare(
      `INSERT INTO bas_sessions
         (client_session_id, friend_id, line_account_id, kind, focus_type,
          timer_sec, started_at, finished_at, total, correct)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       RETURNING id`,
    )
    .bind(
      input.clientSessionId,
      input.friendId,
      input.lineAccountId,
      input.kind,
      input.focusType,
      input.timerSec,
      input.startedAt,
      input.finishedAt,
      total,
      correct,
    )
    .first<{ id: number }>();

  const sessionId = inserted?.id;
  if (!sessionId) throw new Error('failed to insert bas session');

  // answered_at はサーバーが打つ。クライアントの時計を信用すると、
  // 未来日時の解答が「直近の解答」として居座り続ける。
  const answeredAt = jstNow();

  // 解答をまとめて入れる。
  //
  // 型ごとの行（bas_answer_types）を作るのに answer_id が要るが、
  // 1件ずつ RETURNING id で受けると最大50問 × 2往復 ＝ 100往復になり、
  // 結果画面がそのぶん待たされる。**入れてから id をまとめて引き直す。**
  //
  // 引き直しは **question_id ではなく並び順で対応づける**。同じセッションに
  // 同じ問題が2回入る作りではないが、そこに寄りかかると将来1問でも重複した
  // 瞬間に集計が静かに壊れる。id 昇順＝挿入順なので、そのまま順番で結べばよい。
  const ANS_CHUNK = 25;
  for (let i = 0; i < graded.length; i += ANS_CHUNK) {
    const chunk = graded.slice(i, i + ANS_CHUNK);
    await db.batch(
      chunk.map((g) =>
        db
          .prepare(
            `INSERT INTO bas_answers
               (session_id, friend_id, question_id, ok, submitted, timed_out, elapsed_ms, answered_at)
             VALUES (?,?,?,?,?,?,?,?)`,
          )
          .bind(
            sessionId,
            input.friendId,
            g.question_id,
            g.ok,
            g.submitted ? JSON.stringify(g.submitted) : null,
            g.timed_out,
            g.elapsed_ms,
            answeredAt,
          ),
      ),
    );
  }

  const idRows = await db
    .prepare(`SELECT id FROM bas_answers WHERE session_id = ? ORDER BY id ASC`)
    .bind(sessionId)
    .all<{ id: number }>();

  if (idRows.results.length !== graded.length) {
    // 数が合わないまま型の行を作ると、別の問題の正誤が別の型に付く。
    // 集計が静かに嘘をつくくらいなら、型の行を作らずに残す（解答自体は残っている）。
    console.error(
      `[saveBasSession] 解答${graded.length}件に対し id が${idRows.results.length}件しか取れなかった`,
    );
  } else {
    const typeRows: { answerId: number; g: (typeof graded)[number]; code: string }[] = [];
    graded.forEach((g, i) => {
      for (const code of g.types) typeRows.push({ answerId: idRows.results[i].id, g, code });
    });
    const TYPE_CHUNK = 40;
    for (let i = 0; i < typeRows.length; i += TYPE_CHUNK) {
      const chunk = typeRows.slice(i, i + TYPE_CHUNK);
      await db.batch(
        chunk.map((r) =>
          db
            .prepare(
              `INSERT INTO bas_answer_types
                 (answer_id, friend_id, question_id, type_code, ok, answered_at)
               VALUES (?,?,?,?,?,?)`,
            )
            .bind(r.answerId, input.friendId, r.g.question_id, r.code, r.g.ok, answeredAt),
        ),
      );
    }
  }

  return {
    session_id: sessionId,
    total,
    correct,
    duplicated: false,
    results: graded.map((g) => ({ question_id: g.question_id, ok: g.ok })),
  };
}

// ── 講師用（投入・確認） ────────────────────────────────────────────────────

export interface BasQuestionInput {
  no: number;
  lead: string;
  frame: string;
  answer: string[];
  accepted: string[][] | null;
  extra: string | null;
  types: string[];
  steps: string[];
  sentence: string;
  ja: string;
  level: string | null;
}

export async function upsertBasSet(
  db: D1Database,
  input: { slug: string; name: string; lineAccountId: string | null; sort?: number },
): Promise<BasSet> {
  await db
    .prepare(
      `INSERT INTO bas_sets (slug, name, line_account_id, sort)
       VALUES (?,?,?,?)
       ON CONFLICT (slug) DO UPDATE SET name = excluded.name,
                                        line_account_id = excluded.line_account_id,
                                        sort = excluded.sort`,
    )
    .bind(input.slug, input.name, input.lineAccountId, input.sort ?? 0)
    .run();
  const row = await db.prepare(`SELECT * FROM bas_sets WHERE slug = ?`).bind(input.slug).first<BasSet>();
  if (!row) throw new Error('failed to upsert bas set');
  return row;
}

/**
 * セットの問題を丸ごと入れ替える。
 *
 * **解答履歴は消さない。** 問題を消すと bas_answers が参照ごと迷子になるので、
 * 入れ替えではなく `no` をキーにした upsert にしてある。
 * 問題を減らしたいときは管理画面から個別に消すこと。
 */
export async function upsertBasQuestions(
  db: D1Database,
  setId: number,
  questions: BasQuestionInput[],
): Promise<number> {
  const CHUNK = 25;
  let n = 0;
  for (let i = 0; i < questions.length; i += CHUNK) {
    const chunk = questions.slice(i, i + CHUNK);
    await db.batch(
      chunk.map((q) =>
        db
          .prepare(
            `INSERT INTO bas_questions
               (set_id, no, lead, frame, answer, accepted, extra, types, steps, sentence, ja, level)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT (set_id, no) DO UPDATE SET
               lead = excluded.lead, frame = excluded.frame, answer = excluded.answer,
               accepted = excluded.accepted, extra = excluded.extra, types = excluded.types,
               steps = excluded.steps, sentence = excluded.sentence, ja = excluded.ja,
               level = excluded.level`,
          )
          .bind(
            setId,
            q.no,
            q.lead,
            q.frame,
            JSON.stringify(q.answer),
            q.accepted?.length ? JSON.stringify(q.accepted) : null,
            q.extra,
            JSON.stringify(q.types),
            JSON.stringify(q.steps),
            q.sentence,
            q.ja,
            q.level,
          ),
      ),
    );
    n += chunk.length;
  }
  return n;
}

export async function replaceBasTypes(db: D1Database, types: BasTypeRow[]): Promise<number> {
  const CHUNK = 25;
  for (let i = 0; i < types.length; i += CHUNK) {
    const chunk = types.slice(i, i + CHUNK);
    await db.batch(
      chunk.map((t) =>
        db
          .prepare(
            `INSERT INTO bas_types (code, group_code, group_name, name, hint, sort)
             VALUES (?,?,?,?,?,?)
             ON CONFLICT (code) DO UPDATE SET
               group_code = excluded.group_code, group_name = excluded.group_name,
               name = excluded.name, hint = excluded.hint, sort = excluded.sort`,
          )
          .bind(t.code, t.group_code, t.group_name, t.name, t.hint, t.sort),
      ),
    );
  }
  return types.length;
}

export async function getBasQuestions(
  db: D1Database,
  setId: number,
): Promise<BasQuestionRow[]> {
  const rows = await db
    .prepare(`SELECT * FROM bas_questions WHERE set_id = ? ORDER BY no ASC`)
    .bind(setId)
    .all<BasQuestionRow>();
  return rows.results;
}

export interface BasSessionAnswerDetail {
  question_id: number;
  no: number;
  lead: string;
  frame: string;
  answer: string[];
  accepted: string[][];
  submitted: string[] | null;
  types: string[];
  steps: string[];
  sentence: string;
  ja: string;
  ok: number;
  timed_out: number;
  elapsed_ms: number | null;
}

export async function getBasSessionAnswers(
  db: D1Database,
  sessionId: number,
): Promise<BasSessionAnswerDetail[]> {
  const rows = await db
    .prepare(
      `SELECT a.question_id, a.ok, a.timed_out, a.elapsed_ms, a.submitted,
              q.no, q.lead, q.frame, q.answer, q.accepted, q.types, q.steps, q.sentence, q.ja
       FROM bas_answers a JOIN bas_questions q ON q.id = a.question_id
       WHERE a.session_id = ? ORDER BY a.id ASC`,
    )
    .bind(sessionId)
    .all<{
      question_id: number;
      ok: number;
      timed_out: number;
      elapsed_ms: number | null;
      submitted: string | null;
      no: number;
      lead: string;
      frame: string;
      answer: string;
      accepted: string | null;
      types: string;
      steps: string;
      sentence: string;
      ja: string;
    }>();

  return rows.results.map((r) => ({
    question_id: r.question_id,
    no: r.no,
    lead: r.lead,
    frame: r.frame,
    answer: parseJsonArray(r.answer),
    accepted: parseAccepted(r.accepted),
    submitted: r.submitted ? parseJsonArray(r.submitted) : null,
    types: parseJsonArray(r.types),
    steps: parseJsonArray(r.steps),
    sentence: r.sentence,
    ja: r.ja,
    ok: r.ok,
    timed_out: r.timed_out,
    elapsed_ms: r.elapsed_ms,
  }));
}
