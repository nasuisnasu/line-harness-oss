/**
 * 文法テスト（受講生専用）— クエリと集計
 *
 * 単語テスト（`vocab.ts`）の兄弟。指標の考え方はそちらと揃えてある。
 *
 *   1. 問題ごとの習得判定は「直近の解答」。単語のような choice/recall の
 *      優先順位は無い（文法テストは常に4択なので）
 *   2. 習得率の分母は問題集の総問数。**未挑戦の問題も分母に入れる**
 *   3. 時間切れは不正解（ok=0）。timed_out は「時間切れ率」を出すためだけに持つ
 *   4. `retry`（結果画面の「もう一度」）は集計から全部外す
 *
 * 単語テストとの違いは主軸。あちらは100語ブロック、こちらは**分野（category）**。
 * 生徒は「No.301〜400をやる」ではなく「関係詞をやる」と考えるため。
 *
 * 時刻はすべて JST。
 */

import { jstNow } from './utils';

// ── 型 ──────────────────────────────────────────────────────────────────────

export interface GrammarBook {
  id: number;
  line_account_id: string | null;
  slug: string;
  name: string;
  sort: number;
  active: number;
  created_at: string;
}

/** DB の行。`choices` は JSON 文字列のまま。 */
export interface GrammarQuestionRow {
  id: number;
  book_id: number;
  no: number;
  category: string;
  sub_category: string | null;
  prompt: string;
  choices: string;
  answer: number;
  explanation: string | null;
  level: string | null;
  source: string | null;
  distractor_notes: string | null;
}

/** API が返す形。`choices` は配列に開いてある。`source` は生徒に出さない。 */
export interface GrammarQuestion {
  id: number;
  no: number;
  category: string;
  sub_category: string | null;
  prompt: string;
  choices: string[];
  answer: number;
  explanation: string | null;
  level: string | null;
}

export interface GrammarSession {
  id: number;
  client_session_id: string;
  friend_id: string;
  line_account_id: string | null;
  book_id: number;
  kind: string;
  category: string | null;
  sub_category: string | null;
  range_from: number | null;
  range_to: number | null;
  order_mode: string;
  timer_sec: number;
  started_at: string;
  finished_at: string;
  total: number;
  correct: number;
}

/** 分野。並び順は問題番号の若い順（専用の列を持たない）。 */
export interface GrammarCategory {
  name: string;
  count: number;
  from: number;
  to: number;
}

export interface GrammarBookSummary {
  id: number;
  slug: string;
  name: string;
  count: number;
  max_no: number;
  categories: GrammarCategory[];
}

export interface GrammarMastery {
  total: number;
  mastered: number;
  unmastered: number;
  untried: number;
  rate: number;
}

/** 分野ごとの状態。単語テストの BlockMastery にあたる。 */
export interface CategoryMastery extends GrammarMastery {
  name: string;
  from: number;
  to: number;
}

export interface WeakQuestion {
  question_id: number;
  no: number;
  category: string;
  prompt: string;
  choices: string[];
  answer: number;
  explanation: string | null;
  wrong: number;
  asked: number;
}

/**
 * 成績の集計から外すセッション種別。
 *
 * `retry`（結果画面の「間違えた問題だけ、もう一度」）は解説を読んだ直後の再挑戦。
 * ほぼ必ず正解するので実力の測定にならない。記録には残すが集計からは外す。
 * `review`（後日やる復習テスト）は別セッションの本番なので集計に入れる。
 */
const EXCLUDE_RETRY = `s2.kind <> 'retry'`;

/**
 * 「その問題の直近の解答」を1問1行で返す共通の CTE。
 *
 * 単語テストと違い形式が1つしかないので、並びは時刻の降順だけでよい。
 * 同一セッション内で answered_at が同値になるので、id の降順で解決する。
 *
 * バインドは ?1 = friend_id、?2 = book_id。
 */
const LATEST_ANSWER_CTE = `
  WITH ranked AS (
    SELECT a.question_id, a.ok, a.answered_at,
           ROW_NUMBER() OVER (
             PARTITION BY a.question_id
             ORDER BY a.answered_at DESC, a.id DESC
           ) AS rn
    FROM grammar_answers a
    JOIN grammar_questions q2 ON q2.id = a.question_id AND q2.book_id = ?2
    JOIN grammar_sessions s2 ON s2.id = a.session_id AND ${EXCLUDE_RETRY}
    WHERE a.friend_id = ?1
  ),
  latest AS (SELECT question_id, ok, answered_at FROM ranked WHERE rn = 1)
`;

// ── 問題集 ──────────────────────────────────────────────────────────────────

export async function getGrammarBooks(
  db: D1Database,
  lineAccountId?: string | null,
): Promise<GrammarBookSummary[]> {
  const books = await db
    .prepare(
      `SELECT * FROM grammar_books
       WHERE active = 1 AND (line_account_id IS NULL OR line_account_id = ?)
       ORDER BY sort ASC, id ASC`,
    )
    .bind(lineAccountId ?? null)
    .all<GrammarBook>();

  const out: GrammarBookSummary[] = [];
  for (const b of books.results) {
    const agg = await db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(MAX(no), 0) AS max_no
         FROM grammar_questions WHERE book_id = ?`,
      )
      .bind(b.id)
      .first<{ count: number; max_no: number }>();

    const cats = await db
      .prepare(
        `SELECT category AS name, COUNT(*) AS count, MIN(no) AS "from", MAX(no) AS "to"
         FROM grammar_questions
         WHERE book_id = ?
         GROUP BY category
         ORDER BY MIN(no) ASC`,
      )
      .bind(b.id)
      .all<GrammarCategory>();

    out.push({
      id: b.id,
      slug: b.slug,
      name: b.name,
      count: agg?.count ?? 0,
      max_no: agg?.max_no ?? 0,
      categories: cats.results,
    });
  }
  return out;
}

export async function getGrammarBookById(db: D1Database, bookId: number): Promise<GrammarBook | null> {
  return db.prepare(`SELECT * FROM grammar_books WHERE id = ?`).bind(bookId).first<GrammarBook>();
}

/**
 * 行を API の形に開く。
 *
 * `choices` が壊れた JSON でも落とさない。1問のデータ不備でテスト全体が
 * 500 になるほうが、その問題が出ないより悪い（呼び出し側で空配列を弾く）。
 */
export function toQuestion(row: GrammarQuestionRow): GrammarQuestion {
  let choices: string[] = [];
  try {
    const parsed = JSON.parse(row.choices);
    if (Array.isArray(parsed)) choices = parsed.map((x) => String(x));
  } catch {
    choices = [];
  }
  return {
    id: row.id,
    no: row.no,
    category: row.category,
    sub_category: row.sub_category,
    prompt: row.prompt,
    choices,
    // 添字が範囲外なら 0 に倒す。壊れたデータで「正解が存在しない問題」を出さない。
    answer: row.answer >= 0 && row.answer < choices.length ? row.answer : 0,
    explanation: row.explanation,
    level: row.level,
  };
}

/** 選択肢が2つ未満の問題は出題しない。4択にならないものを混ぜると事故る。 */
function usable(q: GrammarQuestion): boolean {
  return q.choices.length >= 2;
}

const Q_COLS = `id, book_id, no, category, sub_category, prompt, choices, answer, explanation, level, source, distractor_notes`;

/**
 * 誤答の勘違いラベル。キーは choices の添字。
 *
 * **生徒用のAPIでは返さない。** 「この選択肢を選ぶ人はこう勘違いしている」は
 * 講師向けの情報で、生徒に先に見せたら答えが割れる。
 */
export function parseDistractorNotes(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v)) {
      if (/^\d+$/.test(k) && typeof x === 'string' && x.trim()) out[k] = x.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 分野テストの出題を組み立てる。
 *
 * 毎回ランダムに引くと2回目以降が「もう一度くじを引く」だけになり、
 * 間違えた問題も未挑戦の問題も優先されない。状態ごとに優先度をつけて枠を配る。
 *
 *   1. 復習が必要（直近で間違えた）… **最大5問まで**
 *   2. 未挑戦（まだ出していない）  … 残り全部
 *   3. 習得済み（確認用）          … それでも埋まらない分だけ
 *
 * 復習に上限を置くのが肝。全部を間違えた問題で埋めると、いつまでもカバーが
 * 進まず同じ問題を延々やることになる。
 */
export const CATEGORY_REVIEW_QUOTA = 5;

export async function getCategoryTestQuestions(
  db: D1Database,
  friendId: string,
  bookId: number,
  opts: {
    category?: string | null;
    /** 単元。指定すると分野よりさらに絞る。生徒が選ぶのはふつうこちら。 */
    subCategory?: string | null;
    from?: number | null;
    to?: number | null;
  },
  limit: number,
): Promise<GrammarQuestion[]> {
  const binds: unknown[] = [friendId, bookId];
  let filter = '';
  if (opts.category) {
    filter += ` AND q.category = ?${binds.length + 1}`;
    binds.push(opts.category);
  }
  if (opts.subCategory) {
    filter += ` AND q.sub_category = ?${binds.length + 1}`;
    binds.push(opts.subCategory);
  }
  if (opts.from != null && opts.to != null) {
    const lo = Math.min(opts.from, opts.to);
    const hi = Math.max(opts.from, opts.to);
    filter += ` AND q.no BETWEEN ?${binds.length + 1} AND ?${binds.length + 2}`;
    binds.push(lo, hi);
  }

  const rows = await db
    .prepare(
      `${LATEST_ANSWER_CTE}
       SELECT ${Q_COLS.split(', ').map((c) => `q.${c}`).join(', ')},
              CASE WHEN l.ok IS NULL THEN 2 WHEN l.ok = 0 THEN 1 ELSE 3 END AS st,
              l.answered_at AS at
       FROM grammar_questions q
       LEFT JOIN latest l ON l.question_id = q.id
       WHERE q.book_id = ?2${filter}
       ORDER BY q.no ASC`,
    )
    .bind(...binds)
    .all<GrammarQuestionRow & { st: number; at: string | null }>();

  const all = rows.results
    .map((r) => ({ ...toQuestion(r), st: r.st, at: r.at }))
    .filter(usable);
  if (all.length <= limit) return all.map(strip);

  const byOldest = (a: { at: string | null }, b: { at: string | null }) =>
    (a.at ?? '').localeCompare(b.at ?? '');

  const wrong = all.filter((q) => q.st === 1).sort(byOldest);
  const untried = shuffle(all.filter((q) => q.st === 2));
  const done = all.filter((q) => q.st === 3).sort(byOldest);

  const picked: typeof all = [];
  const take = (src: typeof all, n: number) => {
    for (const q of src) {
      if (picked.length >= limit || n <= 0) break;
      if (picked.includes(q)) continue;
      picked.push(q);
      n--;
    }
  };

  take(wrong, Math.min(CATEGORY_REVIEW_QUOTA, limit));
  take(untried, limit - picked.length);
  take(done, limit - picked.length);
  take(wrong, limit - picked.length); // それでも足りなければ復習から追加

  return picked.sort((a, b) => a.no - b.no).map(strip);
}

function strip(q: GrammarQuestion & { st?: number; at?: string | null }): GrammarQuestion {
  const { st: _st, at: _at, ...rest } = q;
  return rest;
}

/**
 * 総復習テストの出題（`kind='checkup'`）。
 *
 * **このテストは実力を測らない。仕事は「忘れの検出」1点。**
 * 詳しい経緯は `.company/英弱ニキ/lms/grammar/01-categories.md`。要点だけ書くと、
 *
 *   - 母集団が「この問題集」なので、点数は実力ではなく**問題集の完成度**にしかならない
 *   - しかも習得率が同じものを測っていて二重
 *   - ただし習得率は「**最後に解いたときに正解だったか**」で、時間経過を見ない。
 *     3ヶ月前に正解したきり触れていない問題も「習得済み」のまま残る
 *
 * この最後の穴を埋めるのがこのテスト。だから**最後に正解してから古い順に引く。**
 * 分野ごとの均等抽出はしない（忘れの検出には効かないうえ、
 * 20問で21分野を均等に割ると1分野1問になって分野別には何も読めない）。
 *
 * 優先順位は3段。
 *   1. 習得済み（直近が正解）を、**最後に正解した日が古い順** … これが本体
 *   2. 足りなければ未挑戦からランダム
 *   3. それでも足りなければ復習が必要なものから古い順
 *
 * 2以降はテストの長さを揃えるための穴埋めであって、忘れの検出ではない。
 */
export async function getCheckupQuestions(
  db: D1Database,
  friendId: string,
  bookId: number,
  limit = 20,
): Promise<GrammarQuestion[]> {
  const rows = await db
    .prepare(
      `${LATEST_ANSWER_CTE}
       SELECT ${Q_COLS.split(', ').map((c) => `q.${c}`).join(', ')},
              CASE WHEN l.ok IS NULL THEN 2 WHEN l.ok = 0 THEN 1 ELSE 3 END AS st,
              l.answered_at AS at
       FROM grammar_questions q
       LEFT JOIN latest l ON l.question_id = q.id
       WHERE q.book_id = ?2
       ORDER BY q.no ASC`,
    )
    .bind(friendId, bookId)
    .all<GrammarQuestionRow & { st: number; at: string | null }>();

  const all = rows.results.map((r) => ({ ...toQuestion(r), st: r.st, at: r.at })).filter(usable);
  if (!all.length) return [];

  const byOldest = (a: { at: string | null }, b: { at: string | null }) =>
    (a.at ?? '').localeCompare(b.at ?? '');

  const stale = all.filter((q) => q.st === 3).sort(byOldest);
  const untried = shuffle(all.filter((q) => q.st === 2));
  const wrong = all.filter((q) => q.st === 1).sort(byOldest);

  const picked: typeof all = [];
  const take = (src: typeof all) => {
    for (const q of src) {
      if (picked.length >= limit) break;
      picked.push(q);
    }
  };
  take(stale);
  take(untried);
  take(wrong);

  return picked.sort((a, b) => a.no - b.no).map(strip);
}

/**
 * まだできていない問題（復習キュー）。習得率の裏返しで、別ロジックにはしない。
 *
 * 期間の窓は設けない。正解すれば直近の解答が変わって自動的に外れる。
 * **並びは「最後に間違えてから古い順」。** 番号順にすると、若い番号の苦手な問題が
 * 先頭に居座り続けて後ろが永遠に出てこない。
 */
export async function getReviewQuestions(
  db: D1Database,
  friendId: string,
  bookId: number,
  limit = 20,
): Promise<GrammarQuestion[]> {
  const rows = await db
    .prepare(
      `${LATEST_ANSWER_CTE}
       SELECT ${Q_COLS.split(', ').map((c) => `q.${c}`).join(', ')}
       FROM latest l
       JOIN grammar_questions q ON q.id = l.question_id
       WHERE l.ok = 0
       ORDER BY l.answered_at ASC, q.no ASC
       LIMIT ?3`,
    )
    .bind(friendId, bookId, limit)
    .all<GrammarQuestionRow>();
  return rows.results.map(toQuestion).filter(usable);
}

// ── 使う問題集の選択 ────────────────────────────────────────────────────────

/**
 * 生徒が使うと決めた問題集。`friends.metadata` の `grammar_book_id` に持つ。
 *
 * **書き込みは必ず `json_set` で行う。** metadata はフォームやシナリオ配信も
 * 使っているので、文字列ごと上書きすると他機能のデータを壊す。
 */
export async function getSelectedGrammarBookId(
  db: D1Database,
  friendId: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT json_extract(COALESCE(NULLIF(metadata, ''), '{}'), '$.grammar_book_id') AS book_id
       FROM friends WHERE id = ?`,
    )
    .bind(friendId)
    .first<{ book_id: number | string | null }>();
  const v = row?.book_id;
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function setSelectedGrammarBookId(
  db: D1Database,
  friendId: string,
  bookId: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE friends
       SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.grammar_book_id', ?)
       WHERE id = ?`,
    )
    .bind(bookId, friendId)
    .run();
}

// ── 習得率 ──────────────────────────────────────────────────────────────────

/** 習得率。分野を渡すとその分野だけで出す。未挑戦は**分母に入り、分子に入らない**。 */
export async function getGrammarMastery(
  db: D1Database,
  friendId: string,
  bookId: number,
  category?: string | null,
): Promise<GrammarMastery> {
  const catClause = category ? ` AND q.category = ?3` : '';
  const stmt = db.prepare(
    `${LATEST_ANSWER_CTE}
     SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN l.ok = 1 THEN 1 ELSE 0 END), 0) AS mastered,
            COALESCE(SUM(CASE WHEN l.ok = 0 THEN 1 ELSE 0 END), 0) AS unmastered
     FROM grammar_questions q
     LEFT JOIN latest l ON l.question_id = q.id
     WHERE q.book_id = ?2${catClause}`,
  );

  const row = category
    ? await stmt
        .bind(friendId, bookId, category)
        .first<{ total: number; mastered: number; unmastered: number }>()
    : await stmt
        .bind(friendId, bookId)
        .first<{ total: number; mastered: number; unmastered: number }>();

  const total = row?.total ?? 0;
  const mastered = row?.mastered ?? 0;
  const unmastered = row?.unmastered ?? 0;
  return {
    total,
    mastered,
    unmastered,
    untried: Math.max(0, total - mastered - unmastered),
    rate: total > 0 ? mastered / total : 0,
  };
}

/** 分野ごとの状態。ホームの一覧と管理画面の「分野別の定着率」に使う。 */
export async function getCategoryMastery(
  db: D1Database,
  friendId: string,
  bookId: number,
): Promise<CategoryMastery[]> {
  const rows = await db
    .prepare(
      `${LATEST_ANSWER_CTE}
       SELECT q.category AS name,
              MIN(q.no) AS "from", MAX(q.no) AS "to",
              COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN l.ok = 1 THEN 1 ELSE 0 END), 0) AS mastered,
              COALESCE(SUM(CASE WHEN l.ok = 0 THEN 1 ELSE 0 END), 0) AS unmastered
       FROM grammar_questions q
       LEFT JOIN latest l ON l.question_id = q.id
       WHERE q.book_id = ?2
       GROUP BY q.category
       ORDER BY MIN(q.no) ASC`,
    )
    .bind(friendId, bookId)
    .all<{ name: string; from: number; to: number; total: number; mastered: number; unmastered: number }>();

  return rows.results.map((r) => ({
    name: r.name,
    from: r.from,
    to: r.to,
    total: r.total,
    mastered: r.mastered,
    unmastered: r.unmastered,
    untried: Math.max(0, r.total - r.mastered - r.unmastered),
    rate: r.total > 0 ? r.mastered / r.total : 0,
  }));
}

// ── 単元 ────────────────────────────────────────────────────────────────────

/** 単元ごとの状態。分野一覧から掘ったときに出す。 */
export interface UnitMastery extends GrammarMastery {
  category: string;
  name: string;
}

export async function getUnitMastery(
  db: D1Database,
  friendId: string,
  bookId: number,
  category?: string | null,
): Promise<UnitMastery[]> {
  const catClause = category ? ` AND q.category = ?3` : '';
  const stmt = db.prepare(
    `${LATEST_ANSWER_CTE}
     SELECT q.category, COALESCE(q.sub_category, '') AS name,
            COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN l.ok = 1 THEN 1 ELSE 0 END), 0) AS mastered,
            COALESCE(SUM(CASE WHEN l.ok = 0 THEN 1 ELSE 0 END), 0) AS unmastered
     FROM grammar_questions q
     LEFT JOIN latest l ON l.question_id = q.id
     WHERE q.book_id = ?2${catClause}
     GROUP BY q.category, q.sub_category
     ORDER BY MIN(q.no) ASC`,
  );
  const rows = category
    ? await stmt.bind(friendId, bookId, category).all<{
        category: string; name: string; total: number; mastered: number; unmastered: number;
      }>()
    : await stmt.bind(friendId, bookId).all<{
        category: string; name: string; total: number; mastered: number; unmastered: number;
      }>();

  return rows.results.map((r) => ({
    category: r.category,
    name: r.name,
    total: r.total,
    mastered: r.mastered,
    unmastered: r.unmastered,
    untried: Math.max(0, r.total - r.mastered - r.unmastered),
    rate: r.total > 0 ? r.mastered / r.total : 0,
  }));
}

/**
 * よく間違えている単元のランキング。
 *
 * **苦手はサンプリングでは分からない。解答の蓄積から出す。**
 * 総復習テストは21分野を20問で回るので1分野1問しか当たらず、4択で25%当たる以上
 * 単発の観測に意味は無い。一方こちらは復習キューが間違えた問題を繰り返し出すので、
 * 苦手な単元ほど自然に回数が貯まる。
 *
 * `asked`（延べ）と `questions`（触れた問題数）を両方返すのは、
 * **その数字がどれくらい信用できるかを画面で見せるため。**
 * 「8問を延べ20回やって正答率40%」と「3問を1回ずつやって33%」を同じ顔で並べない。
 */
export interface UnitStat {
  category: string;
  name: string;
  /** 延べ解答数（retry を除く） */
  asked: number;
  wrong: number;
  rate: number;
  /** 実際に触れた問題数。asked との差が「繰り返し解いた度合い」 */
  questions: number;
  /** その単元の総問題数 */
  total: number;
  /** 直近の解答が正解の問題数 */
  mastered: number;
}

/** その単元を出すのに最低限必要な延べ解答数。これ未満はランキングに載せない。 */
export const MIN_ANSWERS_PER_UNIT = 5;

export async function getUnitStats(
  db: D1Database,
  friendId: string,
  bookId: number,
  minAnswers = MIN_ANSWERS_PER_UNIT,
): Promise<UnitStat[]> {
  const answered = await db
    .prepare(
      `SELECT q.category, COALESCE(q.sub_category, '') AS name,
              COUNT(*) AS asked,
              SUM(CASE WHEN a.ok = 0 THEN 1 ELSE 0 END) AS wrong,
              COUNT(DISTINCT a.question_id) AS questions
       FROM grammar_answers a
       JOIN grammar_questions q ON q.id = a.question_id
       JOIN grammar_sessions s2 ON s2.id = a.session_id AND ${EXCLUDE_RETRY}
       WHERE a.friend_id = ? AND q.book_id = ?
       GROUP BY q.category, q.sub_category
       HAVING asked >= ?`,
    )
    .bind(friendId, bookId, minAnswers)
    .all<{ category: string; name: string; asked: number; wrong: number; questions: number }>();

  if (!answered.results.length) return [];

  const mastery = await getUnitMastery(db, friendId, bookId);
  const key = (c: string, n: string) => `${c} ${n}`;
  const m = new Map(mastery.map((x) => [key(x.category, x.name), x]));

  return answered.results
    .map((r) => {
      const um = m.get(key(r.category, r.name));
      return {
        category: r.category,
        name: r.name,
        asked: r.asked,
        wrong: r.wrong,
        rate: r.asked > 0 ? (r.asked - r.wrong) / r.asked : 0,
        questions: r.questions,
        total: um?.total ?? 0,
        mastered: um?.mastered ?? 0,
      };
    })
    // 正答率の低い順。同率なら延べ解答数が多いほう（より確かなほう）を上に。
    .sort((a, b) => a.rate - b.rate || b.asked - a.asked);
}

// ── よく間違える問題 ────────────────────────────────────────────────────────

/**
 * 出題2回以上・誤答率50%以上のものだけ。
 *
 * **出題1回の問題を入れないこと。** 1回落としただけで最上位に来てしまい、
 * リスト全体が信用されなくなる。
 */
export async function getWeakQuestions(
  db: D1Database,
  friendId: string,
  bookId: number | null,
  limit = 5,
): Promise<WeakQuestion[]> {
  const binds: unknown[] = [friendId];
  let bookClause = '';
  if (bookId !== null) {
    bookClause = ' AND q.book_id = ?';
    binds.push(bookId);
  }
  binds.push(limit);

  const rows = await db
    .prepare(
      `SELECT q.id AS question_id, q.no, q.category, q.prompt, q.choices, q.answer, q.explanation,
              SUM(CASE WHEN a.ok = 0 THEN 1 ELSE 0 END) AS wrong,
              COUNT(*) AS asked
       FROM grammar_answers a
       JOIN grammar_questions q ON q.id = a.question_id
       JOIN grammar_sessions s2 ON s2.id = a.session_id AND ${EXCLUDE_RETRY}
       WHERE a.friend_id = ?${bookClause}
       GROUP BY q.id
       HAVING asked >= 2 AND CAST(wrong AS REAL) / asked >= 0.5
       ORDER BY wrong DESC, CAST(wrong AS REAL) / asked DESC, q.no ASC
       LIMIT ?`,
    )
    .bind(...binds)
    .all<{
      question_id: number;
      no: number;
      category: string;
      prompt: string;
      choices: string;
      answer: number;
      explanation: string | null;
      wrong: number;
      asked: number;
    }>();

  return rows.results.map((r) => {
    let choices: string[] = [];
    try {
      const p = JSON.parse(r.choices);
      if (Array.isArray(p)) choices = p.map((x) => String(x));
    } catch {
      choices = [];
    }
    return {
      question_id: r.question_id,
      no: r.no,
      category: r.category,
      prompt: r.prompt,
      choices,
      answer: r.answer >= 0 && r.answer < choices.length ? r.answer : 0,
      explanation: r.explanation,
      wrong: r.wrong,
      asked: r.asked,
    };
  });
}

// ── 実力テストのスコア ──────────────────────────────────────────────────────

export interface GrammarCheckupPoint {
  at: string;
  total: number;
  correct: number;
  score: number;
}

/**
 * 表示に使うスコア。**直近10回の加重平均（新しい回ほど重い）。**
 *
 * 単語テストと同じ式（`vocab.ts` の poolScore）。1回ぶんだと20問で標準偏差が
 * 9ポイント以上あり、伸びたのか運が良かったのか区別できない。decay 0.8 の加重に
 * すると、ばらつきを抑えつつ実力の変化にも追従する。
 *
 * 分母は問題数なので、20問・30問・50問が混ざっても正しく重み付けされる。
 */
export function grammarPoolScore(
  points: GrammarCheckupPoint[],
  n = 10,
  decay = 0.8,
): { score: number; correct: number; total: number; sessions: number } | null {
  const recent = points.slice(-n);
  if (!recent.length) return null;

  let num = 0;
  let den = 0;
  recent.forEach((p, i) => {
    const w = Math.pow(decay, recent.length - 1 - i);
    num += p.correct * w;
    den += p.total * w;
  });
  return {
    score: den ? num / den : 0,
    correct: recent.reduce((a, b) => a + b.correct, 0),
    total: recent.reduce((a, b) => a + b.total, 0),
    sessions: recent.length,
  };
}

/** 実力テストの履歴。古い→新しい。 */
export async function getGrammarCheckupHistory(
  db: D1Database,
  friendId: string,
  bookId: number,
  limit = 20,
): Promise<GrammarCheckupPoint[]> {
  const rows = await db
    .prepare(
      `SELECT finished_at AS at, total, correct FROM grammar_sessions
       WHERE friend_id = ? AND book_id = ? AND kind = 'checkup'
       ORDER BY finished_at DESC, id DESC LIMIT ?`,
    )
    .bind(friendId, bookId, limit)
    .all<{ at: string; total: number; correct: number }>();
  return rows.results
    .map((r) => ({ ...r, score: r.total > 0 ? r.correct / r.total : 0 }))
    .reverse();
}

// ── ダッシュボード ──────────────────────────────────────────────────────────

export interface GrammarRecentSession {
  at: string;
  rate: number;
  kind: string;
  total: number;
  correct: number;
}

export interface GrammarDashboardBook extends GrammarMastery {
  id: number;
  name: string;
  review_count: number;
  last_played_at: string | null;
  categories: CategoryMastery[];
  checkups: GrammarCheckupPoint[];
  checkup_score: { score: number; correct: number; total: number; sessions: number } | null;
}

export interface GrammarDashboard {
  /** 生徒が選んだ問題集。null なら初回なので、アプリは問題集の選択画面を出す。 */
  selected_book_id: number | null;
  books: GrammarDashboardBook[];
  recent: {
    enough: boolean;
    needed: number;
    latest_rate: number | null;
    sessions: GrammarRecentSession[];
  };
  weak_questions: WeakQuestion[];
  totals: { answers: number; sessions: number; days: number };
}

/** 直近の正答率を出すのに最低限必要なセッション数。これ未満は数字を出さない。 */
export const GRAMMAR_MIN_SESSIONS_FOR_TREND = 3;

export async function getGrammarDashboard(
  db: D1Database,
  friendId: string,
  lineAccountId?: string | null,
): Promise<GrammarDashboard> {
  const books = await getGrammarBooks(db, lineAccountId);

  const dashboardBooks: GrammarDashboardBook[] = [];
  for (const b of books) {
    const mastery = await getGrammarMastery(db, friendId, b.id);
    const review = await db
      .prepare(
        `${LATEST_ANSWER_CTE}
         SELECT COUNT(*) AS c FROM latest WHERE ok = 0`,
      )
      .bind(friendId, b.id)
      .first<{ c: number }>();
    const last = await db
      .prepare(
        `SELECT MAX(finished_at) AS at FROM grammar_sessions WHERE friend_id = ? AND book_id = ?`,
      )
      .bind(friendId, b.id)
      .first<{ at: string | null }>();
    const checkups = await getGrammarCheckupHistory(db, friendId, b.id, 20);

    dashboardBooks.push({
      id: b.id,
      name: b.name,
      ...mastery,
      review_count: review?.c ?? 0,
      last_played_at: last?.at ?? null,
      categories: await getCategoryMastery(db, friendId, b.id),
      checkups,
      checkup_score: grammarPoolScore(checkups),
    });
  }

  // 直近に解いた問題集を先頭に。未着手のものは後ろに回す。
  dashboardBooks.sort((a, b) => {
    if (a.last_played_at && b.last_played_at) return a.last_played_at < b.last_played_at ? 1 : -1;
    if (a.last_played_at) return -1;
    if (b.last_played_at) return 1;
    return 0;
  });

  const recentRows = await db
    .prepare(
      `SELECT finished_at AS at, total, correct, kind
       FROM grammar_sessions WHERE friend_id = ? AND kind NOT IN ('retry', 'checkup')
       ORDER BY finished_at DESC, id DESC LIMIT 10`,
    )
    .bind(friendId)
    .all<{ at: string; total: number; correct: number; kind: string }>();

  const sessions: GrammarRecentSession[] = recentRows.results
    .map((r) => ({
      at: r.at,
      kind: r.kind,
      total: r.total,
      correct: r.correct,
      rate: r.total > 0 ? r.correct / r.total : 0,
    }))
    .reverse(); // 古い→新しい（グラフの並び）

  const totals = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM grammar_answers WHERE friend_id = ?1) AS answers,
         (SELECT COUNT(*) FROM grammar_sessions WHERE friend_id = ?1) AS sessions,
         (SELECT COUNT(DISTINCT substr(finished_at, 1, 10)) FROM grammar_sessions WHERE friend_id = ?1) AS days`,
    )
    .bind(friendId)
    .first<{ answers: number; sessions: number; days: number }>();

  const enough = sessions.length >= GRAMMAR_MIN_SESSIONS_FOR_TREND;

  // 選択済みでも、その問題集が非表示になっていたら未選択に戻す
  const savedBookId = await getSelectedGrammarBookId(db, friendId);
  const selectedBookId =
    savedBookId !== null && dashboardBooks.some((b) => b.id === savedBookId) ? savedBookId : null;

  return {
    selected_book_id: selectedBookId,
    books: dashboardBooks,
    recent: {
      enough,
      needed: Math.max(0, GRAMMAR_MIN_SESSIONS_FOR_TREND - sessions.length),
      latest_rate: sessions.length ? sessions[sessions.length - 1].rate : null,
      sessions: enough ? sessions : [],
    },
    weak_questions: await getWeakQuestions(db, friendId, null, 5),
    totals: {
      answers: totals?.answers ?? 0,
      sessions: totals?.sessions ?? 0,
      days: totals?.days ?? 0,
    },
  };
}

// ── 記録画面 ────────────────────────────────────────────────────────────────

export interface CategoryStat {
  name: string;
  asked: number;
  correct: number;
  rate: number;
}

export interface GrammarPaceStat {
  timeout_rate: number | null;
  /** 正解した問題の解答時間の中央値（ミリ秒）。速さの目安。 */
  median_ms: number | null;
}

/** その分野を表示するのに最低限必要な解答数。これ未満は描かない。 */
const MIN_ANSWERS_PER_CATEGORY = 5;

export async function getGrammarRecords(
  db: D1Database,
  friendId: string,
  bookId: number,
): Promise<{
  sessions: GrammarSession[];
  weak_questions: WeakQuestion[];
  categories: CategoryStat[];
  /** よく間違えている単元。正答率の低い順。苦手はここで見る */
  units: UnitStat[];
  pace: GrammarPaceStat;
}> {
  const sessions = await db
    .prepare(
      `SELECT * FROM grammar_sessions WHERE friend_id = ? AND book_id = ?
       ORDER BY finished_at DESC, id DESC LIMIT 100`,
    )
    .bind(friendId, bookId)
    .all<GrammarSession>();

  // 分野ごとの正答率。基準未満は返さない（薄く描くと「やったのにできていない」と
  // 誤読されるので、そもそも描かせない）。
  const cats = await db
    .prepare(
      `SELECT q.category AS name,
              COUNT(*) AS asked,
              SUM(CASE WHEN a.ok = 1 THEN 1 ELSE 0 END) AS correct
       FROM grammar_answers a
       JOIN grammar_questions q ON q.id = a.question_id
       JOIN grammar_sessions s2 ON s2.id = a.session_id AND ${EXCLUDE_RETRY}
       WHERE a.friend_id = ? AND q.book_id = ?
       GROUP BY q.category
       HAVING asked >= ${MIN_ANSWERS_PER_CATEGORY}
       ORDER BY CAST(correct AS REAL) / asked ASC`,
    )
    .bind(friendId, bookId)
    .all<{ name: string; asked: number; correct: number }>();

  const categories: CategoryStat[] = cats.results.map((c) => ({
    name: c.name,
    asked: c.asked,
    correct: c.correct,
    rate: c.asked > 0 ? c.correct / c.asked : 0,
  }));

  const t = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN s.timer_sec > 0 THEN 1 ELSE 0 END) AS timed_n,
         SUM(CASE WHEN s.timer_sec > 0 AND a.timed_out = 1 THEN 1 ELSE 0 END) AS timed_out_n
       FROM grammar_answers a
       JOIN grammar_sessions s ON s.id = a.session_id
       JOIN grammar_questions q ON q.id = a.question_id
       WHERE a.friend_id = ? AND q.book_id = ? AND s.kind <> 'retry'`,
    )
    .bind(friendId, bookId)
    .first<{ timed_n: number | null; timed_out_n: number | null }>();

  // 中央値は SQLite に関数が無いので、OFFSET で真ん中の1行を取る。
  const msRow = await db
    .prepare(
      `SELECT a.elapsed_ms AS ms
       FROM grammar_answers a
       JOIN grammar_sessions s ON s.id = a.session_id
       JOIN grammar_questions q ON q.id = a.question_id
       WHERE a.friend_id = ?1 AND q.book_id = ?2 AND s.kind <> 'retry'
         AND a.ok = 1 AND a.elapsed_ms IS NOT NULL
       ORDER BY a.elapsed_ms ASC
       LIMIT 1 OFFSET (
         SELECT COUNT(*) / 2 FROM grammar_answers a2
         JOIN grammar_sessions s2 ON s2.id = a2.session_id
         JOIN grammar_questions q2 ON q2.id = a2.question_id
         WHERE a2.friend_id = ?1 AND q2.book_id = ?2 AND s2.kind <> 'retry'
           AND a2.ok = 1 AND a2.elapsed_ms IS NOT NULL
       )`,
    )
    .bind(friendId, bookId)
    .first<{ ms: number | null }>();

  return {
    sessions: sessions.results,
    weak_questions: await getWeakQuestions(db, friendId, bookId, 200),
    categories,
    units: await getUnitStats(db, friendId, bookId),
    pace: {
      timeout_rate:
        t?.timed_n && t.timed_n > 0 ? (t.timed_out_n ?? 0) / t.timed_n : null,
      median_ms: msRow?.ms ?? null,
    },
  };
}

// ── セッションの保存 ────────────────────────────────────────────────────────

export interface SaveGrammarSessionInput {
  clientSessionId: string;
  friendId: string;
  lineAccountId: string | null;
  bookId: number;
  kind: string;
  category: string | null;
  subCategory: string | null;
  rangeFrom: number | null;
  rangeTo: number | null;
  orderMode: string;
  timerSec: number;
  startedAt: string;
  finishedAt: string;
  answers: {
    question_id: number;
    ok: number;
    chosen: number | null;
    timed_out: number;
    elapsed_ms: number | null;
  }[];
}

export interface SaveGrammarSessionResult {
  session_id: number;
  total: number;
  correct: number;
  duplicated: boolean;
  mastery: { before: number; after: number; mastered: number; total: number };
  category_mastery: { before: number; after: number; mastered: number; total: number } | null;
}

/**
 * 結果画面から1回だけ呼ばれる。
 *
 * `client_session_id` が既にあれば**何も書かずに**既存の結果を返す。
 * 再送で二重登録されないようにするため、ここは必ず先に確認する。
 */
export async function saveGrammarSession(
  db: D1Database,
  input: SaveGrammarSessionInput,
): Promise<SaveGrammarSessionResult> {
  const existing = await db
    .prepare(`SELECT * FROM grammar_sessions WHERE client_session_id = ?`)
    .bind(input.clientSessionId)
    .first<GrammarSession>();

  if (existing) {
    const after = await getGrammarMastery(db, existing.friend_id, existing.book_id);
    const catAfter = existing.category
      ? await getGrammarMastery(db, existing.friend_id, existing.book_id, existing.category)
      : null;
    return {
      session_id: existing.id,
      total: existing.total,
      correct: existing.correct,
      duplicated: true,
      mastery: {
        before: after.rate,
        after: after.rate,
        mastered: after.mastered,
        total: after.total,
      },
      category_mastery: catAfter
        ? {
            before: catAfter.rate,
            after: catAfter.rate,
            mastered: catAfter.mastered,
            total: catAfter.total,
          }
        : null,
    };
  }

  // 時間切れは不正解に正規化する。クライアントのバグで矛盾した値が来ても倒す。
  const answers = input.answers.map((a) => ({
    ...a,
    ok: a.timed_out ? 0 : a.ok ? 1 : 0,
    timed_out: a.timed_out ? 1 : 0,
    chosen: a.timed_out ? null : a.chosen,
  }));

  const before = await getGrammarMastery(db, input.friendId, input.bookId);
  const catBefore = input.category
    ? await getGrammarMastery(db, input.friendId, input.bookId, input.category)
    : null;

  const total = answers.length;
  const correct = answers.filter((a) => a.ok === 1).length;

  const inserted = await db
    .prepare(
      `INSERT INTO grammar_sessions
         (client_session_id, friend_id, line_account_id, book_id, kind,
          category, sub_category, range_from, range_to, order_mode, timer_sec,
          started_at, finished_at, total, correct)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       RETURNING id`,
    )
    .bind(
      input.clientSessionId,
      input.friendId,
      input.lineAccountId,
      input.bookId,
      input.kind,
      input.category,
      input.subCategory,
      input.rangeFrom,
      input.rangeTo,
      input.orderMode,
      input.timerSec,
      input.startedAt,
      input.finishedAt,
      total,
      correct,
    )
    .first<{ id: number }>();

  const sessionId = inserted?.id;
  if (!sessionId) throw new Error('failed to insert grammar session');

  // 分野は問題から引き直す（クライアントの申告を信じない）。
  // ここを信じると、分野別の集計がクライアントのバグで壊れる。
  const catMap = new Map<number, string>();
  const ids = answers.map((a) => a.question_id);
  const ID_CHUNK = 80; // D1 のバインド上限（100）に余裕を持たせる
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const part = ids.slice(i, i + ID_CHUNK);
    const rows = await db
      .prepare(
        `SELECT id, category FROM grammar_questions WHERE id IN (${part.map(() => '?').join(',')})`,
      )
      .bind(...part)
      .all<{ id: number; category: string }>();
    for (const r of rows.results) catMap.set(r.id, r.category);
  }

  // answered_at はサーバーが打つ。クライアントの時計を信用すると、
  // 未来日時の解答が「直近の解答」として居座り続ける。
  const answeredAt = jstNow();
  const CHUNK = 50;
  for (let i = 0; i < answers.length; i += CHUNK) {
    const chunk = answers.slice(i, i + CHUNK);
    await db.batch(
      chunk.map((a) =>
        db
          .prepare(
            `INSERT INTO grammar_answers
               (session_id, friend_id, question_id, ok, chosen, timed_out, elapsed_ms, category, answered_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            sessionId,
            input.friendId,
            a.question_id,
            a.ok,
            a.chosen,
            a.timed_out,
            a.elapsed_ms,
            catMap.get(a.question_id) ?? input.category ?? '',
            answeredAt,
          ),
      ),
    );
  }

  const after = await getGrammarMastery(db, input.friendId, input.bookId);
  const catAfter = input.category
    ? await getGrammarMastery(db, input.friendId, input.bookId, input.category)
    : null;

  return {
    session_id: sessionId,
    total,
    correct,
    duplicated: false,
    mastery: {
      before: before.rate,
      after: after.rate,
      mastered: after.mastered,
      total: after.total,
    },
    category_mastery:
      catAfter && catBefore
        ? {
            before: catBefore.rate,
            after: catAfter.rate,
            mastered: catAfter.mastered,
            total: catAfter.total,
          }
        : null,
  };
}

export interface GrammarAnswerDetail {
  question_id: number;
  no: number;
  category: string;
  prompt: string;
  choices: string[];
  answer: number;
  chosen: number | null;
  ok: number;
  timed_out: number;
  elapsed_ms: number | null;
}

export async function getGrammarSessionAnswers(
  db: D1Database,
  sessionId: number,
): Promise<GrammarAnswerDetail[]> {
  const rows = await db
    .prepare(
      `SELECT a.question_id, q.no, q.category, q.prompt, q.choices, q.answer,
              a.chosen, a.ok, a.timed_out, a.elapsed_ms
       FROM grammar_answers a JOIN grammar_questions q ON q.id = a.question_id
       WHERE a.session_id = ? ORDER BY q.no ASC`,
    )
    .bind(sessionId)
    .all<{
      question_id: number;
      no: number;
      category: string;
      prompt: string;
      choices: string;
      answer: number;
      chosen: number | null;
      ok: number;
      timed_out: number;
      elapsed_ms: number | null;
    }>();

  return rows.results.map((r) => {
    let choices: string[] = [];
    try {
      const p = JSON.parse(r.choices);
      if (Array.isArray(p)) choices = p.map((x) => String(x));
    } catch {
      choices = [];
    }
    return { ...r, choices };
  });
}

// ── 講師用 ──────────────────────────────────────────────────────────────────

export interface GrammarStudentRow {
  friend_id: string;
  display_name: string | null;
  last_played_at: string | null;
  sessions: number;
  answers: number;
  latest_rate: number | null;
  checkup_score: number | null;
  checkup_sessions: number;
  book_name: string | null;
  total: number;
  mastered: number;
  unmastered: number;
  untried: number;
  rate: number | null;
  /**
   * いちばんできていない単元。声をかける入口になるので一覧に出す。
   * 分野（「関係詞」）より単元（「関係代名詞 what」）のほうが、そのまま授業で扱える。
   */
  weakest_unit: { category: string; name: string; rate: number; asked: number } | null;
}

/**
 * 生徒一覧。**未実施の生徒も末尾に出す。**
 * 誰が手をつけていないかが分かることのほうが、実施済みの並びより大事。
 */
export async function getGrammarStudents(
  db: D1Database,
  lineAccountId?: string | null,
  tagId?: string | null,
): Promise<GrammarStudentRow[]> {
  const conds: string[] = [];
  const binds: unknown[] = [];
  if (lineAccountId) {
    conds.push('f.line_account_id = ?');
    binds.push(lineAccountId);
  }
  if (tagId) {
    conds.push('EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)');
    binds.push(tagId);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const rows = await db
    .prepare(
      `SELECT f.id AS friend_id, f.display_name,
              MAX(s.finished_at) AS last_played_at,
              COUNT(DISTINCT s.id) AS sessions,
              COALESCE(SUM(s.total), 0) AS answers
       FROM friends f
       LEFT JOIN grammar_sessions s ON s.friend_id = f.id
       ${where}
       GROUP BY f.id
       ORDER BY (last_played_at IS NULL) ASC, last_played_at DESC, f.created_at DESC`,
    )
    .bind(...binds)
    .all<GrammarStudentRow>();

  const out: GrammarStudentRow[] = [];
  for (const r of rows.results) {
    const latest = await db
      .prepare(
        `SELECT total, correct FROM grammar_sessions
         WHERE friend_id = ? AND kind <> 'retry'
         ORDER BY finished_at DESC, id DESC LIMIT 1`,
      )
      .bind(r.friend_id)
      .first<{ total: number; correct: number }>();

    // 対象の問題集は、本人が選んだもの → 無ければ直近に解いたもの。
    const selected = await getSelectedGrammarBookId(db, r.friend_id);
    const played = await db
      .prepare(
        `SELECT book_id FROM grammar_sessions WHERE friend_id = ?
         ORDER BY finished_at DESC, id DESC LIMIT 1`,
      )
      .bind(r.friend_id)
      .first<{ book_id: number }>();
    const focusId = selected ?? played?.book_id ?? null;

    let bookName: string | null = null;
    let mastery: GrammarMastery = { total: 0, mastered: 0, unmastered: 0, untried: 0, rate: 0 };
    let weakest: GrammarStudentRow['weakest_unit'] = null;
    if (focusId) {
      const b = await getGrammarBookById(db, focusId);
      bookName = b?.name ?? null;
      mastery = await getGrammarMastery(db, r.friend_id, focusId);
      const rec = await getGrammarRecords(db, r.friend_id, focusId);
      // getUnitStats は正答率の低い順に返す。先頭がいちばん弱い単元。
      // 単元が無い問題集（sub_category 未設定）では分野に落とす。
      const u = rec.units[0];
      const c = rec.categories[0];
      if (u && u.name) weakest = { category: u.category, name: u.name, rate: u.rate, asked: u.asked };
      else if (c) weakest = { category: c.name, name: c.name, rate: c.rate, asked: c.asked };
    }

    const checkups = focusId ? await getGrammarCheckupHistory(db, r.friend_id, focusId, 10) : [];
    const pooled = grammarPoolScore(checkups);

    out.push({
      ...r,
      latest_rate: latest && latest.total > 0 ? latest.correct / latest.total : null,
      checkup_score: pooled ? pooled.score : null,
      checkup_sessions: checkups.length,
      book_name: bookName,
      total: mastery.total,
      mastered: mastery.mastered,
      unmastered: mastery.unmastered,
      untried: mastery.untried,
      rate: focusId ? mastery.rate : null,
      weakest_unit: weakest,
    });
  }
  return out;
}

/** どの誤答が選ばれたか。問題を直すか授業で扱うかの判断材料になる。 */
export interface DistractorStat {
  question_id: number;
  no: number;
  category: string;
  sub_category: string | null;
  prompt: string;
  choices: string[];
  answer: number;
  asked: number;
  /** 選択肢ごとの選ばれた回数（choices と同じ並び）。 */
  picks: number[];
  /** 誤答ごとの勘違い。キーは choices の添字。 */
  distractors: Record<string, string>;
  /**
   * 一度も選ばれていない誤答の添字＝**死んだ選択肢**。
   *
   * 実質3択になっているので、4択前提の25%が成り立たない。
   * これは生徒の問題ではなく**こちらの問題**で、打ち手は「問題を直す」。
   * 出題回数が少ないうちは当然0回なので、呼び出し側で回数を見てから読むこと。
   */
  dead: number[];
}

export async function getGrammarDistractors(
  db: D1Database,
  friendId: string | null,
  bookId: number,
  limit = 20,
): Promise<DistractorStat[]> {
  const binds: unknown[] = [bookId];
  let friendClause = '';
  if (friendId) {
    friendClause = ' AND a.friend_id = ?';
    binds.push(friendId);
  }
  binds.push(limit);

  const rows = await db
    .prepare(
      `SELECT q.id AS question_id, q.no, q.category, q.sub_category, q.prompt, q.choices, q.answer,
              q.distractor_notes,
              COUNT(*) AS asked,
              SUM(CASE WHEN a.ok = 0 THEN 1 ELSE 0 END) AS wrong,
              json_group_array(a.chosen) AS chosen_list
       FROM grammar_answers a
       JOIN grammar_questions q ON q.id = a.question_id
       JOIN grammar_sessions s2 ON s2.id = a.session_id AND ${EXCLUDE_RETRY}
       WHERE q.book_id = ?${friendClause}
       GROUP BY q.id
       HAVING wrong > 0
       ORDER BY wrong DESC, q.no ASC
       LIMIT ?`,
    )
    .bind(...binds)
    .all<{
      question_id: number;
      no: number;
      category: string;
      sub_category: string | null;
      prompt: string;
      choices: string;
      answer: number;
      distractor_notes: string | null;
      asked: number;
      chosen_list: string;
    }>();

  return rows.results.map((r) => {
    let choices: string[] = [];
    try {
      const p = JSON.parse(r.choices);
      if (Array.isArray(p)) choices = p.map((x) => String(x));
    } catch {
      choices = [];
    }
    const picks = new Array<number>(choices.length).fill(0);
    try {
      const list = JSON.parse(r.chosen_list) as (number | null)[];
      for (const c of list) {
        if (c !== null && c >= 0 && c < picks.length) picks[c]++;
      }
    } catch {
      /* 選ばれ方が出ないだけなので黙って諦める */
    }
    const answer = r.answer >= 0 && r.answer < choices.length ? r.answer : 0;
    return {
      question_id: r.question_id,
      no: r.no,
      category: r.category,
      sub_category: r.sub_category,
      prompt: r.prompt,
      choices,
      answer,
      asked: r.asked,
      picks,
      distractors: parseDistractorNotes(r.distractor_notes),
      dead: picks.map((n, i) => (i !== answer && n === 0 ? i : -1)).filter((i) => i >= 0),
    };
  });
}

export async function getGrammarStudentDetail(
  db: D1Database,
  friendId: string,
  bookId?: number | null,
): Promise<{
  sessions: (GrammarSession & { book_name: string })[];
  books: GrammarDashboardBook[];
  weak_questions: WeakQuestion[];
  totals: { answers: number; sessions: number; days: number };
  focus_book: { id: number; name: string } | null;
  categories: CategoryStat[];
  /** よく間違えている単元。講師がいちばん見る数字 */
  units: UnitStat[];
  pace: GrammarPaceStat | null;
  review_questions: GrammarQuestion[];
  distractors: DistractorStat[];
  trend: { at: string; rate: number; kind: string; total: number; correct: number }[];
}> {
  const sessions = await db
    .prepare(
      `SELECT s.*, b.name AS book_name
       FROM grammar_sessions s JOIN grammar_books b ON b.id = s.book_id
       WHERE s.friend_id = ? ORDER BY s.finished_at DESC, s.id DESC LIMIT 200`,
    )
    .bind(friendId)
    .all<GrammarSession & { book_name: string }>();

  const friend = await db
    .prepare(`SELECT line_account_id FROM friends WHERE id = ?`)
    .bind(friendId)
    .first<{ line_account_id: string | null }>();

  const dash = await getGrammarDashboard(db, friendId, friend?.line_account_id ?? null);

  const focusId =
    bookId && dash.books.some((b) => b.id === bookId)
      ? bookId
      : (dash.books.find((b) => b.last_played_at) ?? dash.books[0])?.id ?? null;
  const focus = focusId ? dash.books.find((b) => b.id === focusId) ?? null : null;

  const records = focusId ? await getGrammarRecords(db, friendId, focusId) : null;

  const trend = sessions.results
    .slice(0, 20)
    .map((x) => ({
      at: x.finished_at,
      kind: x.kind,
      total: x.total,
      correct: x.correct,
      rate: x.total > 0 ? x.correct / x.total : 0,
    }))
    .reverse();

  return {
    sessions: sessions.results,
    books: dash.books,
    weak_questions: await getWeakQuestions(db, friendId, focusId ?? null, 200),
    totals: dash.totals,
    focus_book: focus ? { id: focus.id, name: focus.name } : null,
    categories: records ? records.categories : [],
    units: records ? records.units : [],
    pace: records ? records.pace : null,
    review_questions: focusId ? await getReviewQuestions(db, friendId, focusId, 500) : [],
    distractors: focusId ? await getGrammarDistractors(db, friendId, focusId, 20) : [],
    trend,
  };
}

// ── 問題集の投入（講師用） ──────────────────────────────────────────────────

export async function upsertGrammarBook(
  db: D1Database,
  input: { slug: string; name: string; lineAccountId?: string | null; sort?: number },
): Promise<GrammarBook> {
  await db
    .prepare(
      `INSERT INTO grammar_books (slug, name, line_account_id, sort)
       VALUES (?,?,?,?)
       ON CONFLICT(slug) DO UPDATE SET name = excluded.name,
                                       line_account_id = excluded.line_account_id,
                                       sort = excluded.sort`,
    )
    .bind(input.slug, input.name, input.lineAccountId ?? null, input.sort ?? 0)
    .run();
  return (await db
    .prepare(`SELECT * FROM grammar_books WHERE slug = ?`)
    .bind(input.slug)
    .first<GrammarBook>()) as GrammarBook;
}

export interface GrammarQuestionInput {
  no: number;
  category: string;
  sub_category?: string | null;
  prompt: string;
  choices: string[];
  answer: number;
  explanation?: string | null;
  level?: string | null;
  source?: string | null;
  /** 誤答ごとの勘違い。キーは choices の添字（正解の添字は含めない）。 */
  distractors?: Record<string, string> | null;
}

export async function replaceGrammarQuestions(
  db: D1Database,
  bookId: number,
  questions: GrammarQuestionInput[],
): Promise<number> {
  // 既存の問題を消すと grammar_answers の参照が壊れるので、消さずに上書きする。
  const CHUNK = 50;
  let n = 0;
  for (let i = 0; i < questions.length; i += CHUNK) {
    const chunk = questions.slice(i, i + CHUNK);
    await db.batch(
      chunk.map((q) =>
        db
          .prepare(
            `INSERT INTO grammar_questions
               (book_id, no, category, sub_category, prompt, choices, answer, explanation, level, source,
              distractor_notes)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(book_id, no) DO UPDATE SET category         = excluded.category,
                                                    sub_category     = excluded.sub_category,
                                                    prompt           = excluded.prompt,
                                                    choices          = excluded.choices,
                                                    answer           = excluded.answer,
                                                    explanation      = excluded.explanation,
                                                    level            = excluded.level,
                                                    source           = excluded.source,
                                                    distractor_notes = excluded.distractor_notes`,
          )
          .bind(
            bookId,
            q.no,
            q.category,
            q.sub_category ?? null,
            q.prompt,
            JSON.stringify(q.choices),
            q.answer,
            q.explanation ?? null,
            q.level ?? null,
            q.source ?? null,
            q.distractors && Object.keys(q.distractors).length
              ? JSON.stringify(q.distractors)
              : null,
          ),
      ),
    );
    n += chunk.length;
  }
  return n;
}

/** 管理画面の問題一覧。番号順に返す。 */
export async function getGrammarQuestions(
  db: D1Database,
  bookId: number,
  opts: { category?: string | null; limit?: number; offset?: number } = {},
): Promise<{
  questions: (GrammarQuestion & { source: string | null; distractors: Record<string, string> })[];
  total: number;
}> {
  const binds: unknown[] = [bookId];
  let filter = '';
  if (opts.category) {
    filter = ' AND category = ?2';
    binds.push(opts.category);
  }

  const count = await db
    .prepare(`SELECT COUNT(*) AS c FROM grammar_questions WHERE book_id = ?1${filter}`)
    .bind(...binds)
    .first<{ c: number }>();

  const rows = await db
    .prepare(
      `SELECT ${Q_COLS} FROM grammar_questions
       WHERE book_id = ?1${filter}
       ORDER BY no ASC LIMIT ${Math.min(opts.limit ?? 200, 500)} OFFSET ${Math.max(opts.offset ?? 0, 0)}`,
    )
    .bind(...binds)
    .all<GrammarQuestionRow>();

  return {
    questions: rows.results.map((r) => ({
      ...toQuestion(r),
      source: r.source,
      distractors: parseDistractorNotes(r.distractor_notes),
    })),
    total: count?.c ?? 0,
  };
}

// ── 小物 ────────────────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
