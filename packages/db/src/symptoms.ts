/**
 * 症状の観測と仮説 — カルテの中身
 *
 * 設計の正本は `.company/英弱ニキ/lms/karte/01-症状コード_v1.md`、
 * テーブルの意図は `migrations/072_symptoms.sql` のコメント。
 *
 * ★ このモジュールは**判定しない。**
 *   「2つ以上のデータ源が同じ症状を指したときだけ仮説に上げる」は、
 *   観測の DISTINCT source を数えて**読むたびに出す**。列に持つと必ず実体とずれる。
 *
 * ★ 観測は追記だけ。消さない。
 *   棄却した症状の観測も残す。同じ誤りをまた拾ったとき「前に棄却した」が見えるのが大事。
 *
 * 時刻はすべて JST。
 */

import { jstNow } from './utils.js';

/** 設計書の4状態。ここに5つ目を足さないこと（承認ステップを作らないため） */
export type SymptomStatus = 'candidate' | 'testing' | 'confirmed' | 'rejected';

export function isSymptomStatus(v: unknown): v is SymptomStatus {
  return v === 'candidate' || v === 'testing' || v === 'confirmed' || v === 'rejected';
}

/**
 * データ源。**種類の数**が仮説に上げてよいかを決めるので、
 * 同じ性質のものを別名で増やさないこと（grammar と grammar2 を作らない）。
 *   drill = 症状ドリルの結果。設計書の「演習の結果が2つ目の源になる」がこれ
 */
export type SymptomSource = 'grammar' | 'bas' | 'vocab' | 'transcript' | 'submission' | 'drill';

const SOURCES: SymptomSource[] = ['grammar', 'bas', 'vocab', 'transcript', 'submission', 'drill'];

export function isSymptomSource(v: unknown): v is SymptomSource {
  return SOURCES.includes(v as SymptomSource);
}

export interface SymptomCode {
  code: string;
  layer: string;
  name: string;
  sign: string | null;
  sort_order: number;
}

export interface SymptomObservation {
  id: number;
  friend_id: string;
  code: string;
  source: string;
  source_ref: string | null;
  evidence: string;
  observed_at: string;
  created_at: string;
}

export interface FriendSymptom {
  code: string;
  layer: string;
  name: string;
  sign: string | null;
  status: SymptomStatus;
  note: string | null;
  first_seen_at: string;
  last_seen_at: string;
  /** 観測の総数 */
  observations: number;
  /** **種類**の数。2以上で仮説（設計書のルール） */
  sources: number;
  source_list: string[];
  /** 直近の根拠。生徒が実際に何と答えたか（丸めない） */
  recent: { source: string; source_ref: string | null; evidence: string; observed_at: string }[];
}

export async function getSymptomCodes(db: D1Database): Promise<SymptomCode[]> {
  const r = await db
    .prepare(`SELECT code, layer, name, sign, sort_order FROM symptom_codes ORDER BY sort_order`)
    .all<SymptomCode>();
  return r.results || [];
}

/**
 * 観測を1件積む。
 *
 * 同じ源・同じ参照先・同じ根拠は二度積まない（UNIQUE で弾く）。抽出は launchd で
 * 何度も回るので、**呼ぶ側が重複を気にしなくていい**ようにしておく。
 *
 * 観測を積むと、症状の行が無ければ「候補」で作る。既にあれば last_seen_at だけ進める。
 * **状態は勝手に動かさない。**棄却した症状が、次の観測で候補に戻ると棄却の意味が消える。
 */
export async function addSymptomObservation(
  db: D1Database,
  input: {
    friendId: string;
    code: string;
    source: SymptomSource;
    sourceRef?: string | null;
    evidence: string;
    observedAt?: string | null;
  },
): Promise<{ added: boolean }> {
  const observedAt = input.observedAt || jstNow();
  const now = jstNow();

  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO friend_symptom_observations
         (friend_id, code, source, source_ref, evidence, observed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.friendId,
      input.code,
      input.source,
      input.sourceRef ?? null,
      input.evidence,
      observedAt,
      now,
    )
    .run();

  const added = (res.meta?.changes ?? 0) > 0;

  await db
    .prepare(
      `INSERT INTO friend_symptoms (friend_id, code, status, first_seen_at, last_seen_at, updated_at)
       VALUES (?, ?, 'candidate', ?, ?, ?)
       ON CONFLICT (friend_id, code) DO UPDATE SET
         last_seen_at = CASE WHEN excluded.last_seen_at > last_seen_at
                             THEN excluded.last_seen_at ELSE last_seen_at END,
         updated_at   = excluded.updated_at`,
    )
    .bind(input.friendId, input.code, observedAt, observedAt, now)
    .run();

  return { added };
}

/**
 * 生徒の症状一覧。
 *
 * 並びは「いま授業で扱うべき順」＝ 確定 → 検証中 → 仮説（2源以上）→ 候補、
 * 同じ状態なら新しく見えたものが先。棄却は最後に回す（消さないが、先頭には出さない）。
 */
export async function getFriendSymptoms(
  db: D1Database,
  friendId: string,
): Promise<FriendSymptom[]> {
  const rows = await db
    .prepare(
      `SELECT s.code, c.layer, c.name, c.sign, s.status, s.note,
              s.first_seen_at, s.last_seen_at,
              COUNT(o.id)                  AS observations,
              COUNT(DISTINCT o.source)     AS sources
         FROM friend_symptoms s
         JOIN symptom_codes c ON c.code = s.code
         LEFT JOIN friend_symptom_observations o
                ON o.friend_id = s.friend_id AND o.code = s.code
        WHERE s.friend_id = ?
        GROUP BY s.id
        ORDER BY c.sort_order`,
    )
    .bind(friendId)
    .all<Omit<FriendSymptom, 'source_list' | 'recent'>>();

  const list = rows.results || [];
  if (!list.length) return [];

  // 根拠は症状ごとに直近3件だけ返す。全部返すと画面が読めなくなる
  const obs = await db
    .prepare(
      `SELECT code, source, source_ref, evidence, observed_at
         FROM friend_symptom_observations
        WHERE friend_id = ?
        ORDER BY observed_at DESC, id DESC`,
    )
    .bind(friendId)
    .all<{
      code: string;
      source: string;
      source_ref: string | null;
      evidence: string;
      observed_at: string;
    }>();

  const byCode = new Map<string, typeof obs.results>();
  for (const o of obs.results || []) {
    const arr = byCode.get(o.code) || [];
    arr.push(o);
    byCode.set(o.code, arr);
  }

  const RANK: Record<string, number> = { confirmed: 0, testing: 1, candidate: 2, rejected: 4 };
  return list
    .map((s) => {
      const mine = byCode.get(s.code) || [];
      return {
        ...s,
        source_list: [...new Set(mine.map((o) => o.source))],
        recent: mine.slice(0, 3).map((o) => ({
          source: o.source,
          source_ref: o.source_ref,
          evidence: o.evidence,
          observed_at: o.observed_at,
        })),
      };
    })
    .sort((a, b) => {
      // 候補のうち2源以上（＝仮説）は候補より前に出す
      const rank = (x: FriendSymptom) =>
        x.status === 'candidate' && x.sources >= 2 ? 1.5 : (RANK[x.status] ?? 3);
      const d = rank(a) - rank(b);
      if (d !== 0) return d;
      return a.last_seen_at < b.last_seen_at ? 1 : -1;
    });
}

/** 状態と打ち手のメモを更新する。観測は触らない。 */
export async function updateFriendSymptom(
  db: D1Database,
  friendId: string,
  code: string,
  patch: { status?: SymptomStatus; note?: string | null },
): Promise<boolean> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    binds.push(patch.status);
  }
  if (patch.note !== undefined) {
    sets.push('note = ?');
    binds.push(patch.note);
  }
  if (!sets.length) return false;
  sets.push('updated_at = ?');
  binds.push(jstNow());

  const r = await db
    .prepare(`UPDATE friend_symptoms SET ${sets.join(', ')} WHERE friend_id = ? AND code = ?`)
    .bind(...binds, friendId, code)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

/**
 * 抽出パイプラインが「どこまで見たか」を知るための印。
 * 同じ VTT や提出物を毎回読み直して課金しないための、いちばん安い見張り。
 */
export async function getSeenSourceRefs(
  db: D1Database,
  friendId: string,
  source: SymptomSource,
): Promise<string[]> {
  const r = await db
    .prepare(
      `SELECT DISTINCT source_ref FROM friend_symptom_observations
        WHERE friend_id = ? AND source = ? AND source_ref IS NOT NULL`,
    )
    .bind(friendId, source)
    .all<{ source_ref: string }>();
  return (r.results || []).map((x) => x.source_ref);
}

// ── テストログからの抽出（機械だけ・LLMを使わない） ────────────────────────
//
// 授業の文字起こしと提出物は Claude が読む（/drill）。こちらは**当てずっぽうが効かない
// 決め打ちの対応表**で、毎時ただで回せる分だけを拾う。安い見張りを先に置く。
//
// ★ 対応表は「その形の問題を落とした」→「その症状かもしれない」までしか言わない。
//   同じ文を別の理由で落とすことは普通にあるので、**1件では仮説にしない**。
//   2つ以上のデータ源が一致したときだけ仮説に上がる仕組みが、この粗さを吸収する。
//
// ★ 対応表の正本は `.company/英弱ニキ/lms/karte/02-資産マッピング.md`。
//   ここを増やすときは、必ずその文書の在庫と突き合わせること
//   （演習が作れないコードに寄せても、次の一手が出せない）。

/** 並び替えテストの型（A1〜G4）→ 症状コード。載っていない型は観測を作らない。 */
export const BAS_TYPE_TO_SYMPTOM: Record<string, string> = {
  A5: 'X2', // 否定の倒置
  B1: 'S1', // SV … 述語の特定
  B2: 'S5', // SVC … C が消える
  B3: 'S4', // SVO … O と M
  B4: 'S4', // SVOO
  B5: 'S5', // SVOC … C が消える
  B6: 'S5', // 知覚・使役
  C1: 'N2', // 関係代名詞 … 関係詞の格
  C2: 'N2', // 関係副詞
  C3: 'N2', // 前置詞＋関係代名詞
  // 分詞は -ing と -ed に割れるが、読解で詰まるのは圧倒的に -ing の場所なので寄せる。
  // 外れても2源ルールで落ちる
  C4: 'K2',
  C5: 'N4', // 同格の that
  C6: 'K6', // 不定詞の形容詞用法 … 名詞の直後の to do
  D1: 'S4', // 副詞をどこに置くか … M の位置
  D2: 'S4', // 前置詞句がどこにかかるか
  D3: 'K4', // 目的の不定詞 … 意味の方向
  D6: 'N6', // 接続詞が作る副詞節
  E1: 'N1', // 間接疑問 … 節の範囲
  E2: 'N5', // 名詞節の that（省略可）
  E3: 'N1', // 複合関係詞
  E4: 'S2', // 疑問詞節・動名詞が主語 … 主語のカタマリ
  E5: 'K1', // 疑問詞 ＋ to do
  F1: 'X5', // as … as
  F2: 'X5', // so … that
  F3: 'X5', // too … to
  F4: 'X4', // 形式主語 it
  F5: 'X4', // 強調構文
  G3: 'K3', // 受動態 … -ed の場所
};

/**
 * 文法講座テスト（grammar-course）の講 → 症状コード。
 * 講の題は `サイト/grammar/lessonN/index.html`、在庫は 02-資産マッピング.md。
 * **熟語・4択の問題集は入れない。**あちらは語彙で、症状コードの層が違う。
 */
export const GRAMMAR_LESSON_TO_SYMPTOM: Record<string, string> = {
  第3講: 'S4', // 基本文型 … O と M の取り違え
  第4講: 'S3', // 語・句・節 … 品詞で要素を決める
  第6講: 'K1', // 準動詞（S・O） … to do の場所
  第7講: 'S5', // 準動詞（C） … C が消える
  第8講: 'K6', // 準動詞（名詞の前後） … 名詞の直後の to do
  第9講: 'K4', // 準動詞（それ以外） … 意味の方向
  第10講: 'K2', // 紛らわしいパターン … -ing の場所（動名詞と分詞構文の別）
  第13講: 'N1', // 節（S・O・C） … 節の範囲
  第14講: 'N2', // 節（名詞の直後） … 関係詞の格
  第15講: 'N1', // 節（それ以外）
  第16講: 'N4', // 紛らわしいパターン … 同格の that
  第17講: 'N6', // 多義の接続詞
  // 第11講（慣用表現）・第18講（動詞の熟語）は症状コードに寄せない。語彙の層
};

export interface ScanResult {
  scanned: { bas: number; grammar: number };
  added: number;
}

/**
 * 直近の誤答を見て観測を積む。**何度呼んでも同じ結果になる**（DB側の UNIQUE で弾く）。
 *
 * 根拠には**生徒が実際に組んだ語順・選んだ選択肢**をそのまま入れる。
 * 「S4 を落とした」ではなく「〜 を 〜 の順に組んだ」まで残す。
 */
export async function scanTestLogs(
  db: D1Database,
  friendId: string,
  sinceDays = 30,
): Promise<ScanResult> {
  const since = new Date(Date.now() + 9 * 3600_000 - sinceDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  let added = 0;

  // ── 並び替え。型は1問に複数付くので、落とした問題の型を全部見る ──
  const bas = await db
    .prepare(
      `SELECT t.answer_id, t.type_code, t.answered_at, q.sentence, a.submitted
         FROM bas_answer_types t
         JOIN bas_answers a ON a.id = t.answer_id
         JOIN bas_questions q ON q.id = t.question_id
        WHERE t.friend_id = ? AND t.ok = 0 AND substr(t.answered_at, 1, 10) >= ?
        ORDER BY t.answered_at DESC
        LIMIT 300`,
    )
    .bind(friendId, since)
    .all<{
      answer_id: number;
      type_code: string;
      answered_at: string;
      sentence: string;
      submitted: string | null;
    }>();

  for (const r of bas.results || []) {
    const code = BAS_TYPE_TO_SYMPTOM[r.type_code];
    if (!code) continue;
    let built = '（時間切れ・未提出）';
    if (r.submitted) {
      try {
        const arr = JSON.parse(r.submitted);
        if (Array.isArray(arr)) built = arr.join(' ');
      } catch {
        built = r.submitted;
      }
    }
    const res = await addSymptomObservation(db, {
      friendId,
      code,
      source: 'bas',
      sourceRef: `bas:${r.answer_id}`,
      evidence: `［${r.type_code}］組んだ順: ${built} ／ 正: ${r.sentence}`,
      observedAt: r.answered_at,
    });
    if (res.added) added++;
  }

  // ── 文法講座テスト。**選んだ選択肢の中身**まで残す ──
  const gr = await db
    .prepare(
      `SELECT a.id AS answer_id, a.category, a.chosen, a.answered_at,
              q.prompt, q.choices, q.answer
         FROM grammar_answers a
         JOIN grammar_questions q ON q.id = a.question_id
         JOIN grammar_books b ON b.id = q.book_id
        WHERE a.friend_id = ? AND a.ok = 0 AND b.slug = 'grammar-course'
          AND substr(a.answered_at, 1, 10) >= ?
        ORDER BY a.answered_at DESC
        LIMIT 300`,
    )
    .bind(friendId, since)
    .all<{
      answer_id: number;
      category: string;
      chosen: number | null;
      answered_at: string;
      prompt: string;
      choices: string;
      answer: number;
    }>();

  for (const r of gr.results || []) {
    const code = GRAMMAR_LESSON_TO_SYMPTOM[r.category];
    if (!code) continue;
    let picked = '（時間切れ・未選択）';
    let correct = '';
    try {
      const cs = JSON.parse(r.choices);
      if (Array.isArray(cs)) {
        if (r.chosen !== null && cs[r.chosen] !== undefined) picked = String(cs[r.chosen]);
        if (cs[r.answer] !== undefined) correct = String(cs[r.answer]);
      }
    } catch {
      /* choices が壊れていても観測は積む。根拠が薄くなるだけ */
    }
    const res = await addSymptomObservation(db, {
      friendId,
      code,
      source: 'grammar',
      sourceRef: `grammar:${r.answer_id}`,
      evidence: `［${r.category}］${r.prompt} → 選んだ: ${picked}${correct ? ` ／ 正: ${correct}` : ''}`,
      observedAt: r.answered_at,
    });
    if (res.added) added++;
  }

  return { scanned: { bas: bas.results?.length ?? 0, grammar: gr.results?.length ?? 0 }, added };
}
