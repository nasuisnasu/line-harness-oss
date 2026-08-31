/**
 * 生徒カルテ — 指導状況の一元管理
 *
 * 単語・古文単語・熟語・4択・文法講座・並び替え・古文の品詞分解・授業記録・目標日・
 * 提出素材は、それぞれ自分の画面を持っている。**1人の生徒を見るために画面を7枚開く**
 * のが今の状態で、ここはそれを1枚にまとめるためのモジュール。
 *
 * ★ 各機能の詳細をここに写さない。
 *   ここが返すのは「最終実施日・回数・直近の正答率」までの**サマリだけ**。
 *   弱点の中身や1問ごとの解答は既存の画面（/vocab, /grammar, /bas …）が正本で、
 *   カルテからはリンクで飛ぶ。写すと必ず片方だけ古くなる。
 *
 * ★ 一覧は N+1 にしない。
 *   兄弟の getVocabStudents は生徒ごとにループでクエリを投げている（習得率を
 *   1冊ずつ数える必要があるため）。こちらは数字がサマリだけなので、
 *   **1本のクエリに集約サブクエリを LEFT JOIN する**形で足りる。
 *
 * 時刻はすべて JST。ただし session の finished_at はクライアントが送った値なので、
 * 日付での絞り込みは `substr(x,1,10)` （日付の10文字）で行う。
 * 文字列の大小比較に頼ると、書式が1つでも混ざった瞬間に静かに壊れる。
 */

import { jstNow } from './utils.js';

// ── 一覧 ────────────────────────────────────────────────────────────────────

export interface StudentRow {
  friend_id: string;
  display_name: string | null;
  picture_url: string | null;
  is_following: number;
  is_blocked: number;
  /** 授業。remaining = 契約回数 −（実施 ＋ キャンセル）。契約が無ければ null */
  contracted: number;
  conducted: number;
  cancelled: number;
  remaining: number | null;
  last_lesson_date: string | null;
  /** 目標日（lms_goals）。単語・文法のカウントダウンと同じもの */
  goal_label: string | null;
  goal_date: string | null;
  /** 学習（単語・文法・並び替えの3つ合計。retry は数えない） */
  last_study_at: string | null;
  study_7d: number;
  /** 手つかずの提出素材（pending / building） */
  pending_submissions: number;
  /** 講師メモ。latest_note は pinned を優先した1本 */
  note_count: number;
  last_note_at: string | null;
  latest_note: string | null;
  latest_note_pinned: number;
}

/** 学習セッション3種を1つに畳む。retry（解き直し）は「やった」に数えない。 */
const STUDY_UNION = `
  SELECT friend_id, finished_at FROM vocab_sessions   WHERE kind <> 'retry'
  UNION ALL
  SELECT friend_id, finished_at FROM grammar_sessions WHERE kind <> 'retry'
  UNION ALL
  SELECT friend_id, finished_at FROM bas_sessions     WHERE kind <> 'retry'
`;

/** 授業記録の集計。数え方は /api/friends/:id/lessons と同じ（キャンセルも1回消化）。 */
const LESSON_AGG = `
  SELECT friend_id,
         SUM(CASE WHEN type = 'contract' THEN count ELSE 0 END) AS contracted,
         SUM(CASE WHEN type = 'lesson'   THEN 1 ELSE 0 END)     AS conducted,
         SUM(CASE WHEN type = 'cancel'   THEN 1 ELSE 0 END)     AS cancelled,
         MAX(CASE WHEN type = 'lesson' THEN record_date END)    AS last_lesson_date
    FROM friend_lesson_records
   GROUP BY friend_id
`;

/**
 * 生徒一覧。
 *
 * **ブロックした生徒・友だちを外した生徒も消さない。**
 * 指導中の生徒が離れたことは、一覧から静かに消えるのではなく行に出したい。
 *
 * 既定の並びは「動きの無い順」＝ 授業と学習の新しいほうを見て、古い人が上。
 * 誰が止まっているかが分かることが、実施済みの並びより大事（getVocabStudents と同じ考え）。
 */
export async function getStudents(
  db: D1Database,
  lineAccountId?: string | null,
  tagId?: string | null,
): Promise<StudentRow[]> {
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

  // 直近7日。境界は日付で切る（時刻まで見ない）
  const from7 = new Date(Date.now() + 9 * 3600_000 - 6 * 86_400_000).toISOString().slice(0, 10);

  const rows = await db
    .prepare(
      `SELECT f.id AS friend_id, f.display_name, f.picture_url, f.is_following, f.is_blocked,
              COALESCE(l.contracted, 0) AS contracted,
              COALESCE(l.conducted, 0)  AS conducted,
              COALESCE(l.cancelled, 0)  AS cancelled,
              l.last_lesson_date,
              g.label AS goal_label, g.target_date AS goal_date,
              s.last_study_at, COALESCE(s.study_7d, 0) AS study_7d,
              COALESCE(m.pending_submissions, 0) AS pending_submissions,
              COALESCE(n.note_count, 0) AS note_count, n.last_note_at,
              (SELECT body   FROM friend_notes x WHERE x.friend_id = f.id
                ORDER BY x.pinned DESC, x.created_at DESC LIMIT 1) AS latest_note,
              (SELECT pinned FROM friend_notes x WHERE x.friend_id = f.id
                ORDER BY x.pinned DESC, x.created_at DESC LIMIT 1) AS latest_note_pinned
         FROM friends f
         LEFT JOIN (${LESSON_AGG}) l ON l.friend_id = f.id
         LEFT JOIN lms_goals g ON g.friend_id = f.id
         LEFT JOIN (
              SELECT friend_id,
                     MAX(finished_at) AS last_study_at,
                     SUM(CASE WHEN substr(finished_at, 1, 10) >= ? THEN 1 ELSE 0 END) AS study_7d
                FROM (${STUDY_UNION})
               GROUP BY friend_id
         ) s ON s.friend_id = f.id
         LEFT JOIN (
              SELECT friend_id, COUNT(*) AS pending_submissions
                FROM material_submissions
               WHERE status IN ('pending', 'building')
               GROUP BY friend_id
         ) m ON m.friend_id = f.id
         LEFT JOIN (
              SELECT friend_id, COUNT(*) AS note_count, MAX(created_at) AS last_note_at
                FROM friend_notes GROUP BY friend_id
         ) n ON n.friend_id = f.id
         ${where}`,
    )
    .bind(from7, ...binds)
    .all<Omit<StudentRow, 'remaining'>>();

  const out: StudentRow[] = (rows.results || []).map((r) => ({
    ...r,
    // 契約を1度も入れていない生徒に「残り -3回」と出すと嘘になる
    remaining: r.contracted > 0 ? r.contracted - (r.conducted + r.cancelled) : null,
  }));

  // 動きの無い順。授業日（日付だけ）と学習（日時）を突き合わせるので epoch に揃える
  const moved = (r: StudentRow): number => {
    const a = r.last_study_at ? new Date(r.last_study_at).getTime() : 0;
    const b = r.last_lesson_date ? new Date(r.last_lesson_date + 'T00:00:00+09:00').getTime() : 0;
    return Math.max(Number.isNaN(a) ? 0 : a, Number.isNaN(b) ? 0 : b);
  };
  return out.sort((a, b) => moved(a) - moved(b));
}

// ── 1人ぶん ─────────────────────────────────────────────────────────────────

export interface StudentTag {
  id: string;
  name: string;
  color: string | null;
}

export interface StudentLessonRecord {
  id: string;
  type: string;
  count: number;
  record_date: string;
  note: string | null;
}

/** テストのサマリ1行。どのテストでも同じ形にする（画面が1つの表で扱えるように）。 */
export interface StudentTestSummary {
  /** 'vocab' | 'grammar' | 'bas' | 'bunkai'。管理画面のリンク先を決めるのに使う */
  kind: string;
  /** 単語帳・問題集の slug。熟語・4択・文法講座テストはこれでしか見分けられない */
  slug: string | null;
  /** 単語帳・問題集の名前。並び替えと品詞分解は1本なのでその名前 */
  name: string;
  /** 'en' | 'kobun' など。単語帳のみ */
  subject: string | null;
  sessions: number;
  answers: number;
  correct: number;
  /** 0〜100。answers が 0 なら null */
  rate: number | null;
  last_at: string | null;
}

export interface StudentSubmission {
  id: string;
  status: string;
  source: string;
  note: string | null;
  file_count: number;
  result_note: string | null;
  created_at: string;
}

export interface FriendNote {
  id: string;
  friend_id: string;
  body: string;
  pinned: number;
  created_at: string;
  updated_at: string;
}

export interface StudentOverview {
  friend: {
    id: string;
    line_user_id: string;
    line_account_id: string | null;
    display_name: string | null;
    picture_url: string | null;
    is_following: number;
    is_blocked: number;
    created_at: string;
  } | null;
  tags: StudentTag[];
  goal: { label: string; target_date: string } | null;
  lessons: {
    summary: {
      contracted: number;
      conducted: number;
      cancelled: number;
      consumed: number;
      remaining: number | null;
    };
    records: StudentLessonRecord[];
  };
  tests: StudentTestSummary[];
  submissions: StudentSubmission[];
  notes: FriendNote[];
  /** 最後にLINEでやり取りした日時（送受信どちらも含む） */
  last_message_at: string | null;
}

export async function getStudentOverview(
  db: D1Database,
  friendId: string,
): Promise<StudentOverview> {
  const friend = await db
    .prepare(
      `SELECT id, line_user_id, line_account_id, display_name, picture_url,
              is_following, is_blocked, created_at
         FROM friends WHERE id = ?`,
    )
    .bind(friendId)
    .first<StudentOverview['friend']>();

  const tags = await db
    .prepare(
      `SELECT t.id, t.name, t.color
         FROM friend_tags ft JOIN tags t ON t.id = ft.tag_id
        WHERE ft.friend_id = ?
        ORDER BY t.sort_order, t.name`,
    )
    .bind(friendId)
    .all<StudentTag>();

  const goal = await db
    .prepare(`SELECT label, target_date FROM lms_goals WHERE friend_id = ?`)
    .bind(friendId)
    .first<{ label: string; target_date: string }>();

  const lessonRows = await db
    .prepare(
      `SELECT id, type, count, record_date, note
         FROM friend_lesson_records WHERE friend_id = ?
        ORDER BY record_date DESC, created_at DESC LIMIT 50`,
    )
    .bind(friendId)
    .all<StudentLessonRecord>();

  // 集計は表示ぶん（50件）ではなく全件で取る。切り詰めた分だけ残回数がずれる
  const lessonAgg = await db
    .prepare(
      `SELECT SUM(CASE WHEN type = 'contract' THEN count ELSE 0 END) AS contracted,
              SUM(CASE WHEN type = 'lesson'   THEN 1 ELSE 0 END)     AS conducted,
              SUM(CASE WHEN type = 'cancel'   THEN 1 ELSE 0 END)     AS cancelled
         FROM friend_lesson_records WHERE friend_id = ?`,
    )
    .bind(friendId)
    .first<{ contracted: number | null; conducted: number | null; cancelled: number | null }>();

  const contracted = lessonAgg?.contracted ?? 0;
  const conducted = lessonAgg?.conducted ?? 0;
  const cancelled = lessonAgg?.cancelled ?? 0;

  // 単語帳ごと（英単語・古文単語が1つの表に混ざらないよう subject も返す）
  const vocab = await db
    .prepare(
      `SELECT b.slug, b.name, b.subject,
              COUNT(*) AS sessions, SUM(s.total) AS answers, SUM(s.correct) AS correct,
              MAX(s.finished_at) AS last_at
         FROM vocab_sessions s JOIN vocab_books b ON b.id = s.book_id
        WHERE s.friend_id = ? AND s.kind <> 'retry'
        GROUP BY b.id ORDER BY last_at DESC`,
    )
    .bind(friendId)
    .all<{
      slug: string;
      name: string;
      subject: string | null;
      sessions: number;
      answers: number | null;
      correct: number | null;
      last_at: string | null;
    }>();

  // 問題集ごと（熟語・4択・文法講座テストは slug で分かれているだけなので名前で並べる）
  const grammar = await db
    .prepare(
      `SELECT b.slug, b.name,
              COUNT(*) AS sessions, SUM(s.total) AS answers, SUM(s.correct) AS correct,
              MAX(s.finished_at) AS last_at
         FROM grammar_sessions s JOIN grammar_books b ON b.id = s.book_id
        WHERE s.friend_id = ? AND s.kind <> 'retry'
        GROUP BY b.id ORDER BY last_at DESC`,
    )
    .bind(friendId)
    .all<{
      slug: string;
      name: string;
      sessions: number;
      answers: number | null;
      correct: number | null;
      last_at: string | null;
    }>();

  const bas = await db
    .prepare(
      `SELECT COUNT(*) AS sessions, SUM(total) AS answers, SUM(correct) AS correct,
              MAX(finished_at) AS last_at
         FROM bas_sessions WHERE friend_id = ? AND kind <> 'retry'`,
    )
    .bind(friendId)
    .first<{ sessions: number; answers: number | null; correct: number | null; last_at: string | null }>();

  // 品詞分解は正誤が無い。「何回・いつ投げたか」だけを持つ（つまずきの材料）。
  //
  // ★ 070_bunkai.sql が未適用の環境では bunkai_requests が無い。
  //   そこで例外を投げると**カルテ全体が開かなくなる**ので、この1行だけ落とす。
  //   カルテは「散らばっているものを集める」画面なので、集める先が1つ欠けたときの
  //   正しい振る舞いは、全部を出さないことではなく、その行を出さないこと。
  const bunkai = await db
    .prepare(
      `SELECT COUNT(*) AS sessions, MAX(created_at) AS last_at
         FROM bunkai_requests WHERE friend_id = ?`,
    )
    .bind(friendId)
    .first<{ sessions: number; last_at: string | null }>()
    .catch(() => null);

  const rate = (correct: number | null, answers: number | null): number | null =>
    answers && answers > 0 ? Math.round(((correct ?? 0) / answers) * 100) : null;

  const tests: StudentTestSummary[] = [
    ...(vocab.results || []).map((r) => ({
      kind: 'vocab',
      slug: r.slug,
      name: r.name,
      subject: r.subject,
      sessions: r.sessions,
      answers: r.answers ?? 0,
      correct: r.correct ?? 0,
      rate: rate(r.correct, r.answers),
      last_at: r.last_at,
    })),
    ...(grammar.results || []).map((r) => ({
      kind: 'grammar',
      slug: r.slug,
      name: r.name,
      subject: null,
      sessions: r.sessions,
      answers: r.answers ?? 0,
      correct: r.correct ?? 0,
      rate: rate(r.correct, r.answers),
      last_at: r.last_at,
    })),
  ];
  if (bas && bas.sessions > 0) {
    tests.push({
      kind: 'bas',
      slug: null,
      name: '並び替えテスト',
      subject: null,
      sessions: bas.sessions,
      answers: bas.answers ?? 0,
      correct: bas.correct ?? 0,
      rate: rate(bas.correct, bas.answers),
      last_at: bas.last_at,
    });
  }
  if (bunkai && bunkai.sessions > 0) {
    tests.push({
      kind: 'bunkai',
      slug: null,
      name: '品詞分解チェッカー',
      subject: null,
      sessions: bunkai.sessions,
      answers: 0,
      correct: 0,
      rate: null,
      last_at: bunkai.last_at,
    });
  }

  const submissions = await db
    .prepare(
      `SELECT id, status, source, note, file_count, result_note, created_at
         FROM material_submissions WHERE friend_id = ?
        ORDER BY created_at DESC LIMIT 20`,
    )
    .bind(friendId)
    .all<StudentSubmission>();

  const lastMessage = await db
    .prepare(`SELECT MAX(created_at) AS at FROM messages_log WHERE friend_id = ?`)
    .bind(friendId)
    .first<{ at: string | null }>();

  return {
    friend: friend ?? null,
    tags: tags.results || [],
    goal: goal ?? null,
    lessons: {
      summary: {
        contracted,
        conducted,
        cancelled,
        consumed: conducted + cancelled,
        remaining: contracted > 0 ? contracted - (conducted + cancelled) : null,
      },
      records: lessonRows.results || [],
    },
    tests,
    submissions: submissions.results || [],
    notes: await getFriendNotes(db, friendId),
    last_message_at: lastMessage?.at ?? null,
  };
}

// ── 講師メモ ────────────────────────────────────────────────────────────────

/** 並びは pinned（いまの方針）を先頭に、あとは新しい順。 */
export async function getFriendNotes(db: D1Database, friendId: string): Promise<FriendNote[]> {
  const rows = await db
    .prepare(
      `SELECT id, friend_id, body, pinned, created_at, updated_at
         FROM friend_notes WHERE friend_id = ?
        ORDER BY pinned DESC, created_at DESC`,
    )
    .bind(friendId)
    .all<FriendNote>();
  return rows.results || [];
}

export async function createFriendNote(
  db: D1Database,
  friendId: string,
  body: string,
  pinned = false,
): Promise<FriendNote> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO friend_notes (id, friend_id, body, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, friendId, body, pinned ? 1 : 0, now, now)
    .run();
  return { id, friend_id: friendId, body, pinned: pinned ? 1 : 0, created_at: now, updated_at: now };
}

/**
 * 本文と pinned の更新。渡されたものだけ書き換える。
 * created_at は動かさない（いつ書いたメモかが並びの根拠なので、編集で上に来ると困る）。
 */
export async function updateFriendNote(
  db: D1Database,
  friendId: string,
  noteId: string,
  patch: { body?: string; pinned?: boolean },
): Promise<FriendNote | null> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.body !== undefined) {
    sets.push('body = ?');
    binds.push(patch.body);
  }
  if (patch.pinned !== undefined) {
    sets.push('pinned = ?');
    binds.push(patch.pinned ? 1 : 0);
  }
  if (!sets.length) return null;
  sets.push('updated_at = ?');
  binds.push(jstNow());
  await db
    .prepare(`UPDATE friend_notes SET ${sets.join(', ')} WHERE id = ? AND friend_id = ?`)
    .bind(...binds, noteId, friendId)
    .run();
  return db
    .prepare(
      `SELECT id, friend_id, body, pinned, created_at, updated_at
         FROM friend_notes WHERE id = ? AND friend_id = ?`,
    )
    .bind(noteId, friendId)
    .first<FriendNote>();
}

export async function deleteFriendNote(
  db: D1Database,
  friendId: string,
  noteId: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM friend_notes WHERE id = ? AND friend_id = ?`)
    .bind(noteId, friendId)
    .run();
}
