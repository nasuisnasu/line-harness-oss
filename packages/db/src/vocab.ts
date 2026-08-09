/**
 * 単語テスト（受講生専用）— クエリと集計
 *
 * 指標の定義は `.company/英弱ニキ/lms/vocab/06-metrics.md` が正本。
 * ここで素朴な平均を出さないこと。とくに次の3点を守る。
 *
 *   1. 語ごとの習得判定は「直近の choice の解答」。choice が無い語だけ recall で判定する
 *   2. 習得率の分母は単語帳の総語数。**未挑戦の語も分母に入れる**
 *      （解いた語だけで割ると、10語やって全問正解した生徒が 1900 語の単語帳で 100% になる）
 *   3. 時間切れは不正解（ok=0）。timed_out は「時間切れ率」を出すためだけに持つ
 *
 * 時刻はすべて JST。
 */

import { jstNow } from './utils';

// ── 型 ──────────────────────────────────────────────────────────────────────

export interface VocabBook {
  id: number;
  line_account_id: string | null;
  slug: string;
  name: string;
  sort: number;
  active: number;
  created_at: string;
}

export interface VocabWord {
  id: number;
  book_id: number;
  no: number;
  en: string;
  ja: string;
  section: string | null;
}

export interface VocabSession {
  id: number;
  client_session_id: string;
  friend_id: string;
  line_account_id: string | null;
  book_id: number;
  kind: string;
  range_from: number | null;
  range_to: number | null;
  format: string;
  direction: string;
  order_mode: string;
  timer_sec: number;
  started_at: string;
  finished_at: string;
  total: number;
  correct: number;
}

export interface BookSection {
  name: string;
  from: number;
  to: number;
}

export interface BookSummary {
  id: number;
  slug: string;
  name: string;
  count: number;
  max_no: number;
  sections: BookSection[];
}

export interface Mastery {
  total: number;
  mastered: number;
  unmastered: number;
  untried: number;
  rate: number;
}

export interface WeakWord {
  word_id: number;
  no: number;
  en: string;
  ja: string;
  wrong: number;
  asked: number;
}

/**
 * 「その語の直近の解答」を1語1行で返す共通の CTE。
 *
 * choice を recall より優先する。ORDER BY の第1キー `(format = 'choice') DESC` が
 * それを担っている（SQLite では真偽が 1/0 になるので DESC で choice が先頭に来る）。
 * answered_at が同値になる同一セッション内は id の降順で解決する。
 */
const LATEST_ANSWER_CTE = `
  WITH ranked AS (
    SELECT a.word_id, a.ok,
           ROW_NUMBER() OVER (
             PARTITION BY a.word_id
             ORDER BY (a.format = 'choice') DESC, a.answered_at DESC, a.id DESC
           ) AS rn
    FROM vocab_answers a
    JOIN vocab_words w2 ON w2.id = a.word_id AND w2.book_id = ?2
    WHERE a.friend_id = ?1
  ),
  latest AS (SELECT word_id, ok FROM ranked WHERE rn = 1)
`;

// ── 単語帳 ──────────────────────────────────────────────────────────────────

export async function getVocabBooks(
  db: D1Database,
  lineAccountId?: string | null,
): Promise<BookSummary[]> {
  const books = await db
    .prepare(
      `SELECT * FROM vocab_books
       WHERE active = 1 AND (line_account_id IS NULL OR line_account_id = ?)
       ORDER BY sort ASC, id ASC`,
    )
    .bind(lineAccountId ?? null)
    .all<VocabBook>();

  const out: BookSummary[] = [];
  for (const b of books.results) {
    const agg = await db
      .prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(no), 0) AS max_no FROM vocab_words WHERE book_id = ?`)
      .bind(b.id)
      .first<{ count: number; max_no: number }>();

    const sections = await db
      .prepare(
        `SELECT section AS name, MIN(no) AS "from", MAX(no) AS "to"
         FROM vocab_words
         WHERE book_id = ? AND section IS NOT NULL AND section <> ''
         GROUP BY section
         ORDER BY MIN(no) ASC`,
      )
      .bind(b.id)
      .all<BookSection>();

    out.push({
      id: b.id,
      slug: b.slug,
      name: b.name,
      count: agg?.count ?? 0,
      max_no: agg?.max_no ?? 0,
      sections: sections.results,
    });
  }
  return out;
}

export async function getVocabBookById(db: D1Database, bookId: number): Promise<VocabBook | null> {
  return db.prepare(`SELECT * FROM vocab_books WHERE id = ?`).bind(bookId).first<VocabBook>();
}

/**
 * 出題する語を返す。
 *
 * **範囲指定は必須**（呼び出し側で from/to を検証する）。単語帳の全件を返す経路を
 * 作らないこと。詳細は `10-access-control.md`。
 */
export async function getVocabWords(
  db: D1Database,
  bookId: number,
  from: number,
  to: number,
  limit: number,
  order: 'seq' | 'rnd',
): Promise<VocabWord[]> {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);

  const rows = await db
    .prepare(
      `SELECT id, book_id, no, en, ja, section
       FROM vocab_words
       WHERE book_id = ? AND no BETWEEN ? AND ?
       ORDER BY no ASC`,
    )
    .bind(bookId, lo, hi)
    .all<VocabWord>();

  let pool = rows.results;

  // 範囲より出題数が少ないときは**必ずランダムに抜き出す**。
  // 先頭から切ると「1〜100の範囲で20問」がいつも 1〜20 になり、
  // 範囲の後ろ半分が永遠に出題されない。order は並べ方の指定であって、
  // どの語を選ぶかの指定ではない（元の vocab-test.html と同じ挙動）。
  if (pool.length > limit) {
    pool = shuffle(pool).slice(0, limit);
  }
  // 並びは呼び出し側（LIFF）が order に従って決めるので、ここでは番号順に戻しておく。
  pool.sort((a, b) => a.no - b.no);
  return pool;
}

/** 4択のダミー選択肢。出題語と重複しない範囲外の語から拾う。 */
export async function getVocabDecoys(
  db: D1Database,
  bookId: number,
  excludeIds: number[],
  count: number,
): Promise<Pick<VocabWord, 'id' | 'en' | 'ja'>[]> {
  if (count <= 0) return [];
  const placeholders = excludeIds.length ? excludeIds.map(() => '?').join(',') : 'NULL';
  const rows = await db
    .prepare(
      `SELECT id, en, ja FROM vocab_words
       WHERE book_id = ? AND id NOT IN (${placeholders})
       ORDER BY RANDOM() LIMIT ?`,
    )
    .bind(bookId, ...excludeIds, count)
    .all<Pick<VocabWord, 'id' | 'en' | 'ja'>>();
  return rows.results;
}

// ── 使う単語帳の選択 ────────────────────────────────────────────────────────

/**
 * 生徒が使うと決めた単語帳。`friends.metadata` の `vocab_book_id` に持つ。
 *
 * 専用の列やテーブルを足さないのは、この1個のためにmigrationを増やしたくないため。
 * **書き込みは必ず `json_set` で行う。** metadata はフォームやシナリオ配信も
 * 使っているので、文字列ごと上書きすると他機能のデータを壊す。
 */
export async function getSelectedBookId(db: D1Database, friendId: string): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT json_extract(COALESCE(NULLIF(metadata, ''), '{}'), '$.vocab_book_id') AS book_id
       FROM friends WHERE id = ?`,
    )
    .bind(friendId)
    .first<{ book_id: number | string | null }>();
  const v = row?.book_id;
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function setSelectedBookId(
  db: D1Database,
  friendId: string,
  bookId: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE friends
       SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.vocab_book_id', ?)
       WHERE id = ?`,
    )
    .bind(bookId, friendId)
    .run();
}

// ── 習得率 ──────────────────────────────────────────────────────────────────

/**
 * 習得率。範囲を渡すとその範囲だけで出す。
 *
 * 未挑戦の語は**分母に入り、分子に入らない**。
 */
export async function getMastery(
  db: D1Database,
  friendId: string,
  bookId: number,
  range?: { from: number; to: number },
): Promise<Mastery> {
  const rangeClause = range ? ` AND w.no BETWEEN ?3 AND ?4` : '';
  const stmt = db.prepare(
    `${LATEST_ANSWER_CTE}
     SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN l.ok = 1 THEN 1 ELSE 0 END), 0) AS mastered,
            COALESCE(SUM(CASE WHEN l.ok = 0 THEN 1 ELSE 0 END), 0) AS unmastered
     FROM vocab_words w
     LEFT JOIN latest l ON l.word_id = w.id
     WHERE w.book_id = ?2${rangeClause}`,
  );

  const row = range
    ? await stmt
        .bind(friendId, bookId, Math.min(range.from, range.to), Math.max(range.from, range.to))
        .first<{ total: number; mastered: number; unmastered: number }>()
    : await stmt.bind(friendId, bookId).first<{ total: number; mastered: number; unmastered: number }>();

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

/**
 * まだ覚えてない語（復習キュー）。習得率の裏返しで、別ロジックにはしない。
 *
 * 期間の窓は設けない。正解すれば直近の解答が変わって自動的に外れるので、
 * 古い記録が溜まり続ける問題は起きない。
 */
export async function getReviewWords(
  db: D1Database,
  friendId: string,
  bookId: number,
  limit = 20,
): Promise<VocabWord[]> {
  const rows = await db
    .prepare(
      `${LATEST_ANSWER_CTE}
       SELECT w.id, w.book_id, w.no, w.en, w.ja, w.section
       FROM latest l
       JOIN vocab_words w ON w.id = l.word_id
       WHERE l.ok = 0
       ORDER BY w.no ASC
       LIMIT ?3`,
    )
    .bind(friendId, bookId, limit)
    .all<VocabWord>();
  return rows.results;
}

// ── よく間違える語 ──────────────────────────────────────────────────────────

/**
 * 出題2回以上・誤答率50%以上のものだけ。
 *
 * **出題1回の語を入れないこと。** 1回落としただけで最上位に来てしまい、
 * リスト全体が信用されなくなる。
 */
export async function getWeakWords(
  db: D1Database,
  friendId: string,
  bookId: number | null,
  limit = 5,
): Promise<WeakWord[]> {
  const binds: unknown[] = [friendId];
  let bookClause = '';
  if (bookId !== null) {
    bookClause = ' AND w.book_id = ?';
    binds.push(bookId);
  }
  binds.push(limit);

  const rows = await db
    .prepare(
      `SELECT w.id AS word_id, w.no, w.en, w.ja,
              SUM(CASE WHEN a.ok = 0 THEN 1 ELSE 0 END) AS wrong,
              COUNT(*) AS asked
       FROM vocab_answers a
       JOIN vocab_words w ON w.id = a.word_id
       WHERE a.friend_id = ?${bookClause}
       GROUP BY w.id
       HAVING asked >= 2 AND CAST(wrong AS REAL) / asked >= 0.5
       ORDER BY wrong DESC, CAST(wrong AS REAL) / asked DESC, w.no ASC
       LIMIT ?`,
    )
    .bind(...binds)
    .all<WeakWord>();
  return rows.results;
}

// ── ダッシュボード ──────────────────────────────────────────────────────────

export interface RecentSession {
  at: string;
  rate: number;
  kind: string;
  total: number;
  correct: number;
}

export interface DashboardBook extends Mastery {
  id: number;
  name: string;
  review_count: number;
  last_played_at: string | null;
}

export interface VocabDashboard {
  /** 生徒が選んだ単語帳。null なら初回なので、アプリは単語帳の選択画面を出す。 */
  selected_book_id: number | null;
  books: DashboardBook[];
  recent: { enough: boolean; needed: number; latest_rate: number | null; sessions: RecentSession[] };
  weak_words: WeakWord[];
  totals: { answers: number; sessions: number; days: number };
}

/** 直近の正答率を出すのに最低限必要なセッション数。これ未満は数字を出さない。 */
export const MIN_SESSIONS_FOR_TREND = 3;

export async function getVocabDashboard(
  db: D1Database,
  friendId: string,
  lineAccountId?: string | null,
): Promise<VocabDashboard> {
  const books = await getVocabBooks(db, lineAccountId);

  const dashboardBooks: DashboardBook[] = [];
  for (const b of books) {
    const mastery = await getMastery(db, friendId, b.id);
    const review = await db
      .prepare(
        `${LATEST_ANSWER_CTE}
         SELECT COUNT(*) AS c FROM latest WHERE ok = 0`,
      )
      .bind(friendId, b.id)
      .first<{ c: number }>();
    const last = await db
      .prepare(
        `SELECT MAX(finished_at) AS at FROM vocab_sessions WHERE friend_id = ? AND book_id = ?`,
      )
      .bind(friendId, b.id)
      .first<{ at: string | null }>();

    dashboardBooks.push({
      id: b.id,
      name: b.name,
      ...mastery,
      review_count: review?.c ?? 0,
      last_played_at: last?.at ?? null,
    });
  }

  // 直近に解いた単語帳を先頭に。未着手のものは後ろに回す。
  dashboardBooks.sort((a, b) => {
    if (a.last_played_at && b.last_played_at) return a.last_played_at < b.last_played_at ? 1 : -1;
    if (a.last_played_at) return -1;
    if (b.last_played_at) return 1;
    return 0;
  });

  const recentRows = await db
    .prepare(
      `SELECT finished_at AS at, total, correct, kind
       FROM vocab_sessions WHERE friend_id = ?
       ORDER BY finished_at DESC, id DESC LIMIT 10`,
    )
    .bind(friendId)
    .all<{ at: string; total: number; correct: number; kind: string }>();

  const sessions: RecentSession[] = recentRows.results
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
         (SELECT COUNT(*) FROM vocab_answers WHERE friend_id = ?1) AS answers,
         (SELECT COUNT(*) FROM vocab_sessions WHERE friend_id = ?1) AS sessions,
         (SELECT COUNT(DISTINCT substr(finished_at, 1, 10)) FROM vocab_sessions WHERE friend_id = ?1) AS days`,
    )
    .bind(friendId)
    .first<{ answers: number; sessions: number; days: number }>();

  const enough = sessions.length >= MIN_SESSIONS_FOR_TREND;

  // 選択済みでも、その単語帳が非表示になっていたら未選択に戻す
  // （ダミー単語帳を active=0 にしたときに、選んだままの生徒が固まらないように）
  const savedBookId = await getSelectedBookId(db, friendId);
  const selectedBookId =
    savedBookId !== null && dashboardBooks.some((b) => b.id === savedBookId) ? savedBookId : null;

  return {
    selected_book_id: selectedBookId,
    books: dashboardBooks,
    recent: {
      enough,
      needed: Math.max(0, MIN_SESSIONS_FOR_TREND - sessions.length),
      latest_rate: sessions.length ? sessions[sessions.length - 1].rate : null,
      sessions: enough ? sessions : [],
    },
    weak_words: await getWeakWords(db, friendId, null, 5),
    totals: {
      answers: totals?.answers ?? 0,
      sessions: totals?.sessions ?? 0,
      days: totals?.days ?? 0,
    },
  };
}

// ── 記録画面 ────────────────────────────────────────────────────────────────

export interface SectionStat {
  block: number;
  from: number;
  to: number;
  asked: number;
  correct: number;
  rate: number;
}

export interface FormatStat {
  ej: number | null;
  je: number | null;
  choice: number | null;
  recall: number | null;
  timeout_rate: number | null;
}

/** そのブロックを表示するのに最低限必要な解答数。これ未満は描かない。 */
const MIN_ANSWERS_PER_BLOCK = 5;

export async function getVocabRecords(
  db: D1Database,
  friendId: string,
  bookId: number,
): Promise<{
  sessions: VocabSession[];
  weak_words: WeakWord[];
  sections: SectionStat[];
  formats: FormatStat;
}> {
  const sessions = await db
    .prepare(
      `SELECT * FROM vocab_sessions WHERE friend_id = ? AND book_id = ?
       ORDER BY finished_at DESC, id DESC LIMIT 100`,
    )
    .bind(friendId, bookId)
    .all<VocabSession>();

  // 10語ブロックごとの正答率。基準未満のブロックは返さない
  // （薄く描くと「やったのにできていない」と誤読されるため、そもそも描かせない）。
  const blocks = await db
    .prepare(
      `SELECT ((w.no - 1) / 10) AS block,
              COUNT(*) AS asked,
              SUM(CASE WHEN a.ok = 1 THEN 1 ELSE 0 END) AS correct
       FROM vocab_answers a
       JOIN vocab_words w ON w.id = a.word_id
       WHERE a.friend_id = ? AND w.book_id = ?
       GROUP BY block
       HAVING asked >= ${MIN_ANSWERS_PER_BLOCK}
       ORDER BY block ASC`,
    )
    .bind(friendId, bookId)
    .all<{ block: number; asked: number; correct: number }>();

  const sections: SectionStat[] = blocks.results.map((b) => ({
    block: b.block,
    from: b.block * 10 + 1,
    to: b.block * 10 + 10,
    asked: b.asked,
    correct: b.correct,
    rate: b.asked > 0 ? b.correct / b.asked : 0,
  }));

  const f = await db
    .prepare(
      // direction / format は vocab_sessions にも同名の列があるので、必ず a. で修飾する。
      // 修飾を落とすと SQLite が ambiguous column name で落ちる。
      `SELECT
         SUM(CASE WHEN a.direction = 'ej' THEN 1 ELSE 0 END) AS ej_n,
         SUM(CASE WHEN a.direction = 'ej' AND a.ok = 1 THEN 1 ELSE 0 END) AS ej_ok,
         SUM(CASE WHEN a.direction = 'je' THEN 1 ELSE 0 END) AS je_n,
         SUM(CASE WHEN a.direction = 'je' AND a.ok = 1 THEN 1 ELSE 0 END) AS je_ok,
         SUM(CASE WHEN a.format = 'choice' THEN 1 ELSE 0 END) AS ch_n,
         SUM(CASE WHEN a.format = 'choice' AND a.ok = 1 THEN 1 ELSE 0 END) AS ch_ok,
         SUM(CASE WHEN a.format = 'recall' THEN 1 ELSE 0 END) AS rc_n,
         SUM(CASE WHEN a.format = 'recall' AND a.ok = 1 THEN 1 ELSE 0 END) AS rc_ok,
         SUM(CASE WHEN s.timer_sec > 0 THEN 1 ELSE 0 END) AS timed_n,
         SUM(CASE WHEN s.timer_sec > 0 AND a.timed_out = 1 THEN 1 ELSE 0 END) AS timed_out_n
       FROM vocab_answers a
       JOIN vocab_sessions s ON s.id = a.session_id
       JOIN vocab_words w ON w.id = a.word_id
       WHERE a.friend_id = ? AND w.book_id = ?`,
    )
    .bind(friendId, bookId)
    .first<Record<string, number | null>>();

  const ratio = (ok: number | null | undefined, n: number | null | undefined): number | null =>
    n && n > 0 ? (ok ?? 0) / n : null;

  return {
    sessions: sessions.results,
    weak_words: await getWeakWords(db, friendId, bookId, 200),
    sections,
    formats: {
      ej: ratio(f?.ej_ok, f?.ej_n),
      je: ratio(f?.je_ok, f?.je_n),
      choice: ratio(f?.ch_ok, f?.ch_n),
      recall: ratio(f?.rc_ok, f?.rc_n),
      timeout_rate: ratio(f?.timed_out_n, f?.timed_n),
    },
  };
}

// ── セッションの保存 ────────────────────────────────────────────────────────

export interface SaveSessionInput {
  clientSessionId: string;
  friendId: string;
  lineAccountId: string | null;
  bookId: number;
  kind: string;
  rangeFrom: number | null;
  rangeTo: number | null;
  format: string;
  direction: string;
  orderMode: string;
  timerSec: number;
  startedAt: string;
  finishedAt: string;
  answers: { word_id: number; ok: number; timed_out: number; elapsed_ms: number | null }[];
}

export interface SaveSessionResult {
  session_id: number;
  total: number;
  correct: number;
  duplicated: boolean;
  mastery: { before: number; after: number; mastered: number; total: number };
  range_mastery: { before: number; after: number; mastered: number; total: number } | null;
}

/**
 * 結果画面から1回だけ呼ばれる。
 *
 * `client_session_id` が既にあれば**何も書かずに**既存の結果を返す。
 * 再送で二重登録されないようにするため、ここは必ず先に確認する。
 */
export async function saveVocabSession(
  db: D1Database,
  input: SaveSessionInput,
): Promise<SaveSessionResult> {
  const existing = await db
    .prepare(`SELECT * FROM vocab_sessions WHERE client_session_id = ?`)
    .bind(input.clientSessionId)
    .first<VocabSession>();

  if (existing) {
    const after = await getMastery(db, existing.friend_id, existing.book_id);
    const rangeAfter =
      existing.range_from !== null && existing.range_to !== null
        ? await getMastery(db, existing.friend_id, existing.book_id, {
            from: existing.range_from,
            to: existing.range_to,
          })
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
      range_mastery: rangeAfter
        ? {
            before: rangeAfter.rate,
            after: rangeAfter.rate,
            mastered: rangeAfter.mastered,
            total: rangeAfter.total,
          }
        : null,
    };
  }

  // 時間切れは不正解に正規化する。クライアントのバグで矛盾した値が来ても、
  // ここで必ず ok=0 に倒す。
  const answers = input.answers.map((a) => ({
    ...a,
    ok: a.timed_out ? 0 : a.ok ? 1 : 0,
    timed_out: a.timed_out ? 1 : 0,
  }));

  const hasRange = input.rangeFrom !== null && input.rangeTo !== null;
  const before = await getMastery(db, input.friendId, input.bookId);
  const rangeBefore = hasRange
    ? await getMastery(db, input.friendId, input.bookId, {
        from: input.rangeFrom as number,
        to: input.rangeTo as number,
      })
    : null;

  const total = answers.length;
  const correct = answers.filter((a) => a.ok === 1).length;

  const inserted = await db
    .prepare(
      `INSERT INTO vocab_sessions
         (client_session_id, friend_id, line_account_id, book_id, kind,
          range_from, range_to, format, direction, order_mode, timer_sec,
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
      input.rangeFrom,
      input.rangeTo,
      input.format,
      input.direction,
      input.orderMode,
      input.timerSec,
      input.startedAt,
      input.finishedAt,
      total,
      correct,
    )
    .first<{ id: number }>();

  const sessionId = inserted?.id;
  if (!sessionId) throw new Error('failed to insert vocab session');

  // answered_at はサーバーが打つ。クライアントの時計を信用すると、
  // 未来日時の解答が「直近の解答」として居座り続ける。
  const answeredAt = jstNow();
  // 「全部」で数百問になることがあるので、1回の batch に詰め込みすぎない。
  const CHUNK = 50;
  for (let i = 0; i < answers.length; i += CHUNK) {
    const chunk = answers.slice(i, i + CHUNK);
    await db.batch(
      chunk.map((a) =>
        db
          .prepare(
            `INSERT INTO vocab_answers
               (session_id, friend_id, word_id, ok, timed_out, elapsed_ms, format, direction, answered_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            sessionId,
            input.friendId,
            a.word_id,
            a.ok,
            a.timed_out,
            a.elapsed_ms,
            input.format,
            input.direction,
            answeredAt,
          ),
      ),
    );
  }

  const after = await getMastery(db, input.friendId, input.bookId);
  const rangeAfter = hasRange
    ? await getMastery(db, input.friendId, input.bookId, {
        from: input.rangeFrom as number,
        to: input.rangeTo as number,
      })
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
    range_mastery:
      rangeAfter && rangeBefore
        ? {
            before: rangeBefore.rate,
            after: rangeAfter.rate,
            mastered: rangeAfter.mastered,
            total: rangeAfter.total,
          }
        : null,
  };
}

export async function getVocabSessionAnswers(
  db: D1Database,
  sessionId: number,
): Promise<
  { word_id: number; no: number; en: string; ja: string; ok: number; timed_out: number; elapsed_ms: number | null }[]
> {
  const rows = await db
    .prepare(
      `SELECT a.word_id, w.no, w.en, w.ja, a.ok, a.timed_out, a.elapsed_ms
       FROM vocab_answers a JOIN vocab_words w ON w.id = a.word_id
       WHERE a.session_id = ? ORDER BY w.no ASC`,
    )
    .bind(sessionId)
    .all<{
      word_id: number;
      no: number;
      en: string;
      ja: string;
      ok: number;
      timed_out: number;
      elapsed_ms: number | null;
    }>();
  return rows.results;
}

// ── 講師用 ──────────────────────────────────────────────────────────────────

export interface VocabStudentRow {
  friend_id: string;
  display_name: string | null;
  last_played_at: string | null;
  sessions: number;
  answers: number;
  latest_rate: number | null;
}

/**
 * 生徒一覧。**未実施の生徒も末尾に出す。**
 * 誰が手をつけていないかが分かることのほうが、実施済みの並びより大事。
 */
export async function getVocabStudents(
  db: D1Database,
  lineAccountId?: string | null,
  tagId?: string | null,
): Promise<VocabStudentRow[]> {
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
       LEFT JOIN vocab_sessions s ON s.friend_id = f.id
       ${where}
       GROUP BY f.id
       ORDER BY (last_played_at IS NULL) ASC, last_played_at DESC, f.created_at DESC`,
    )
    .bind(...binds)
    .all<VocabStudentRow>();

  const out: VocabStudentRow[] = [];
  for (const r of rows.results) {
    const latest = await db
      .prepare(
        `SELECT total, correct FROM vocab_sessions
         WHERE friend_id = ? ORDER BY finished_at DESC, id DESC LIMIT 1`,
      )
      .bind(r.friend_id)
      .first<{ total: number; correct: number }>();
    out.push({
      ...r,
      latest_rate: latest && latest.total > 0 ? latest.correct / latest.total : null,
    });
  }
  return out;
}

export async function getVocabStudentDetail(
  db: D1Database,
  friendId: string,
  bookId?: number | null,
): Promise<{
  sessions: (VocabSession & { book_name: string })[];
  books: DashboardBook[];
  weak_words: WeakWord[];
  totals: { answers: number; sessions: number; days: number };
  /** 傾向の分析対象にした単語帳。生徒が複数使っていても、混ぜずに1冊ずつ見る。 */
  focus_book: { id: number; name: string } | null;
  /** 「何で間違えているか」。方向・形式・速度で切る。語の意味では切らない。 */
  formats: FormatStat | null;
  /** 単語帳内の10語ブロックごとの正答率。解答が少ないブロックは返らない。 */
  sections: SectionStat[];
  /** いま復習が必要な単語（直近の解答が不正解のもの）。番号順・全件。 */
  review_words: VocabWord[];
  /** 直近セッションの正答率の推移（古い→新しい）。 */
  trend: { at: string; rate: number; kind: string; total: number; correct: number }[];
}> {
  const sessions = await db
    .prepare(
      `SELECT s.*, b.name AS book_name
       FROM vocab_sessions s JOIN vocab_books b ON b.id = s.book_id
       WHERE s.friend_id = ? ORDER BY s.finished_at DESC, s.id DESC LIMIT 200`,
    )
    .bind(friendId)
    .all<VocabSession & { book_name: string }>();

  const friend = await db
    .prepare(`SELECT line_account_id FROM friends WHERE id = ?`)
    .bind(friendId)
    .first<{ line_account_id: string | null }>();

  const dash = await getVocabDashboard(db, friendId, friend?.line_account_id ?? null);

  // 傾向を見る単語帳は、指定が無ければ「直近に解いたもの」。
  // 複数の単語帳の解答を混ぜると、セクション別も形式別も意味を失う。
  const focusId =
    bookId && dash.books.some((b) => b.id === bookId)
      ? bookId
      : (dash.books.find((b) => b.last_played_at) ?? dash.books[0])?.id ?? null;
  const focus = focusId ? dash.books.find((b) => b.id === focusId) ?? null : null;

  const records = focusId ? await getVocabRecords(db, friendId, focusId) : null;

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
    weak_words: await getWeakWords(db, friendId, focusId ?? null, 200),
    totals: dash.totals,
    focus_book: focus ? { id: focus.id, name: focus.name } : null,
    formats: records ? records.formats : null,
    sections: records ? records.sections : [],
    review_words: focusId ? await getReviewWords(db, friendId, focusId, 500) : [],
    trend,
  };
}

// ── 単語帳の投入（講師用） ──────────────────────────────────────────────────

export async function upsertVocabBook(
  db: D1Database,
  input: { slug: string; name: string; lineAccountId?: string | null; sort?: number },
): Promise<VocabBook> {
  await db
    .prepare(
      `INSERT INTO vocab_books (slug, name, line_account_id, sort)
       VALUES (?,?,?,?)
       ON CONFLICT(slug) DO UPDATE SET name = excluded.name,
                                       line_account_id = excluded.line_account_id,
                                       sort = excluded.sort`,
    )
    .bind(input.slug, input.name, input.lineAccountId ?? null, input.sort ?? 0)
    .run();
  return (await db
    .prepare(`SELECT * FROM vocab_books WHERE slug = ?`)
    .bind(input.slug)
    .first<VocabBook>()) as VocabBook;
}

export async function replaceVocabWords(
  db: D1Database,
  bookId: number,
  words: { no: number; en: string; ja: string; section?: string | null }[],
): Promise<number> {
  // 既存の語を消すと vocab_answers の参照が壊れるので、消さずに上書きする。
  const CHUNK = 50;
  let n = 0;
  for (let i = 0; i < words.length; i += CHUNK) {
    const chunk = words.slice(i, i + CHUNK);
    await db.batch(
      chunk.map((w) =>
        db
          .prepare(
            `INSERT INTO vocab_words (book_id, no, en, ja, section)
             VALUES (?,?,?,?,?)
             ON CONFLICT(book_id, no) DO UPDATE SET en = excluded.en,
                                                    ja = excluded.ja,
                                                    section = excluded.section`,
          )
          .bind(bookId, w.no, w.en, w.ja, w.section ?? null),
      ),
    );
    n += chunk.length;
  }
  return n;
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
