/**
 * 文法テスト（受講生専用）
 *
 * 単語テスト（`routes/vocab.ts`）の兄弟。アクセス制御の考え方は完全に同じなので、
 * ゲートは `lib/student-gate.ts` に切り出して共有している。
 *
 * 生徒用は LIFF の idToken、講師用は API_KEY。認証経路を混ぜないこと。
 * 生徒用エンドポイントは authMiddleware をスキップさせている（Authorization ヘッダを
 * API_KEY ではなく idToken に使うため）。したがって**ゲートが唯一の壁**。
 * 各ハンドラの先頭で必ず requireStudent() を通す。
 */

import { Hono } from 'hono';
import {
  getGrammarBooks,
  getGrammarBookById,
  getCategoryTestQuestions,
  getMixedQuestions,
  getReviewQuestions,
  getGrammarDashboard,
  getGrammarRecords,
  saveGrammarSession,
  getGrammarSessionAnswers,
  getSelectedGrammarBookId,
  setSelectedGrammarBookId,
  getGrammarStudents,
  getGrammarStudentDetail,
  getGrammarQuestions,
  getUnitMastery,
  getGrammarDistractors,
  upsertGrammarBook,
  replaceGrammarQuestions,
  jstNow,
  type GrammarQuestionInput,
} from '@line-crm/db';
import { requireStudent, denied } from '../lib/student-gate.js';
import type { Env } from '../index.js';

export const grammar = new Hono<Env>();

/**
 * 1リクエストで返す問題数の上限。
 *
 * 「範囲を指定せずに問題集を丸ごと取る」経路を作らないための線引き。
 * 文法問題は1問が長いので、単語（500語）より小さく取る。
 */
const MAX_QUESTIONS_PER_REQUEST = 100;
const MAX_REVIEW_QUESTIONS = 20;
/** 総合演習で選べる問題数。多いほどスコアが安定する。 */
const MIXED_SIZES = [20, 30, 50];

// ── 生徒用 ──────────────────────────────────────────────────────────────────

grammar.get('/api/grammar/books', async (c) => {
  const gate = await requireStudent(c, 'grammar');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const books = await getGrammarBooks(c.env.DB, gate.friend.line_account_id);
  return c.json({ success: true, books });
});

/**
 * 出題。
 *
 * **分野か番号範囲のどちらかは必須。** 絞らずに全件を返す経路を作らない。
 * 選択肢は問題そのものに書いてあるので、単語テストのようなダミー生成は無い。
 */
grammar.get('/api/grammar/questions', async (c) => {
  const gate = await requireStudent(c, 'grammar');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }

  const bookId = Number(c.req.query('book_id'));
  const category = c.req.query('category') || null;
  const subCategory = c.req.query('sub_category') || null;
  const fromRaw = c.req.query('from');
  const toRaw = c.req.query('to');
  const from = fromRaw !== undefined ? Number(fromRaw) : null;
  const to = toRaw !== undefined ? Number(toRaw) : null;
  const limit = Number(c.req.query('limit') || 20);

  if (!bookId) return c.json({ success: false, error: 'book_id は必須です' }, 400);
  const hasRange = from !== null && to !== null && Number.isFinite(from) && Number.isFinite(to);
  if (!category && !subCategory && !hasRange) {
    return c.json(
      { success: false, error: 'category / sub_category / from・to のいずれかは必須です' },
      400,
    );
  }
  if (!Number.isFinite(limit) || limit < 1 || limit > MAX_QUESTIONS_PER_REQUEST) {
    return c.json(
      { success: false, error: `1回に取得できるのは${MAX_QUESTIONS_PER_REQUEST}問までです` },
      400,
    );
  }

  try {
    const questions = await getCategoryTestQuestions(
      c.env.DB,
      gate.friend.id,
      bookId,
      { category, subCategory, from: hasRange ? from : null, to: hasRange ? to : null },
      limit,
    );
    return c.json({ success: true, questions });
  } catch (e) {
    // 画面には「通信に失敗しました」としか出ないので、原因はここに残す
    console.error(
      `[grammar/questions] friend=${gate.friend.id} book=${bookId} cat=${category} sub=${subCategory} limit=${limit}`,
      e,
    );
    return c.json(
      { success: false, error: '問題の準備に失敗しました。時間をおいて試してください' },
      500,
    );
  }
});

/** 使う問題集を決める／あとから切り替える。 */
grammar.put('/api/grammar/book', async (c) => {
  const gate = await requireStudent(c, 'grammar');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const body = await c.req.json<{ book_id?: number }>();
  const bookId = Number(body.book_id);
  if (!bookId) return c.json({ success: false, error: 'book_id は必須です' }, 400);

  const book = await getGrammarBookById(c.env.DB, bookId);
  if (!book || !book.active) return c.json({ success: false, error: '問題集が見つかりません' }, 404);

  await setSelectedGrammarBookId(c.env.DB, gate.friend.id, bookId);
  return c.json({
    success: true,
    selected_book_id: await getSelectedGrammarBookId(c.env.DB, gate.friend.id),
  });
});

grammar.get('/api/grammar/review', async (c) => {
  const gate = await requireStudent(c, 'grammar');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const bookId = Number(c.req.query('book_id'));
  if (!bookId) return c.json({ success: false, error: 'book_id は必須です' }, 400);

  const limit = Math.min(Number(c.req.query('limit') || MAX_REVIEW_QUESTIONS), MAX_REVIEW_QUESTIONS);
  const questions = await getReviewQuestions(c.env.DB, gate.friend.id, bookId, limit);
  return c.json({ success: true, count: questions.length, questions });
});

/**
 * ある分野の単元一覧（定着率つき）。
 *
 * ダッシュボードに全単元（140）を積むとホームの応答が重くなるだけなので、
 * 分野を掘ったときにここだけ取りに来る。
 */
/**
 * 総合演習。分野をまたいでランダムに引く。**スコアを測るのはこれ。**
 *
 * 2026-08-15 に総復習テスト（`/checkup`・stale-first）を廃止してここに一本化した。
 * ランダムに引く以上、忘れた問題も未挑戦の問題も同じ確率で当たるので、
 * このスコアだけで「問題集の完成度」と「できているつもり」の両方が見える。
 * こちらは全分野からただランダムに引く。
 */
grammar.get('/api/grammar/mixed', async (c) => {
  const gate = await requireStudent(c, 'grammar');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const bookId = Number(c.req.query('book_id'));
  if (!bookId) return c.json({ success: false, error: 'book_id は必須です' }, 400);

  const size = MIXED_SIZES.includes(Number(c.req.query('size')))
    ? Number(c.req.query('size'))
    : MIXED_SIZES[0];
  const questions = await getMixedQuestions(c.env.DB, bookId, size);
  return c.json({ success: true, questions });
});

grammar.get('/api/grammar/units', async (c) => {
  const gate = await requireStudent(c, 'grammar');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const bookId = Number(c.req.query('book_id'));
  if (!bookId) return c.json({ success: false, error: 'book_id は必須です' }, 400);

  const units = await getUnitMastery(
    c.env.DB,
    gate.friend.id,
    bookId,
    c.req.query('category') || null,
  );
  return c.json({ success: true, units });
});

grammar.get('/api/grammar/dashboard', async (c) => {
  const gate = await requireStudent(c, 'grammar');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const dashboard = await getGrammarDashboard(
    c.env.DB,
    gate.friend.id,
    gate.friend.line_account_id,
  );
  return c.json({ success: true, ...dashboard });
});

grammar.get('/api/grammar/records', async (c) => {
  const gate = await requireStudent(c, 'grammar');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const bookId = Number(c.req.query('book_id'));
  if (!bookId) return c.json({ success: false, error: 'book_id は必須です' }, 400);

  const records = await getGrammarRecords(c.env.DB, gate.friend.id, bookId);
  return c.json({ success: true, ...records });
});

grammar.post('/api/grammar/sessions', async (c) => {
  const gate = await requireStudent(c, 'grammar');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }

  const body = await c.req.json<{
    client_session_id?: string;
    book_id?: number;
    kind?: string;
    category?: string | null;
    sub_category?: string | null;
    range_from?: number | null;
    range_to?: number | null;
    order_mode?: string;
    timer_sec?: number;
    started_at?: string;
    finished_at?: string;
    answers?: {
      question_id: number;
      ok: number;
      chosen?: number | null;
      timed_out?: number;
      elapsed_ms?: number | null;
    }[];
  }>();

  if (!body.client_session_id || !body.book_id || !Array.isArray(body.answers)) {
    return c.json(
      { success: false, error: 'client_session_id / book_id / answers は必須です' },
      400,
    );
  }
  if (body.answers.length > MAX_QUESTIONS_PER_REQUEST) {
    return c.json({ success: false, error: '1セッションの解答が多すぎます' }, 400);
  }

  const book = await getGrammarBookById(c.env.DB, body.book_id);
  if (!book) return c.json({ success: false, error: '問題集が見つかりません' }, 404);

  // 'checkup' は 2026-08-15 廃止。古いLIFFがキャッシュから送ってくる可能性があるので
  // 受け口だけ残す（弾くと記録が消えるだけで、生徒には何も伝わらない）。
  const kind = ['normal', 'review', 'retry', 'checkup', 'mixed'].includes(body.kind || '')
    ? (body.kind as string)
    : 'normal';
  const orderMode = body.order_mode === 'seq' ? 'seq' : 'rnd';

  // クライアントの時計は信用しきらない。壊れていたらサーバー時刻に倒す。
  const now = jstNow();
  const safeTime = (v: string | undefined): string =>
    v && !Number.isNaN(new Date(v).getTime()) ? v : now;

  const result = await saveGrammarSession(c.env.DB, {
    clientSessionId: body.client_session_id,
    friendId: gate.friend.id,
    lineAccountId: gate.friend.line_account_id,
    bookId: body.book_id,
    kind,
    category: body.category ?? null,
    subCategory: body.sub_category ?? null,
    rangeFrom: body.range_from ?? null,
    rangeTo: body.range_to ?? null,
    orderMode,
    timerSec: Number(body.timer_sec) || 0,
    startedAt: safeTime(body.started_at),
    finishedAt: safeTime(body.finished_at),
    answers: body.answers.map((a) => ({
      question_id: Number(a.question_id),
      ok: a.ok ? 1 : 0,
      chosen: a.chosen === null || a.chosen === undefined ? null : Number(a.chosen),
      timed_out: a.timed_out ? 1 : 0,
      elapsed_ms: a.elapsed_ms ?? null,
    })),
  });

  return c.json({ success: true, ...result });
});

// ── 講師用（API_KEY。authMiddleware が先に弾く） ────────────────────────────

grammar.get('/api/grammar/admin/students', async (c) => {
  const lineAccountId = c.req.query('lineAccountId') || c.env.VOCAB_LINE_ACCOUNT_ID || null;
  // 既定で受講生タグに絞る。文法テストを開けるのはタグ持ちだけなので、
  // 一覧に保護者やタグ無しの友だちが混ざると「未実施」の数が意味を失う。
  const tagId = c.req.query('tagId') || c.env.VOCAB_ALLOW_TAG_ID || null;
  const students = await getGrammarStudents(c.env.DB, lineAccountId, tagId);
  return c.json({ success: true, students });
});

grammar.get('/api/grammar/admin/students/:friendId', async (c) => {
  const friendId = c.req.param('friendId');
  const bookId = Number(c.req.query('book_id')) || null;
  const detail = await getGrammarStudentDetail(c.env.DB, friendId, bookId);
  return c.json({ success: true, ...detail });
});

grammar.get('/api/grammar/admin/sessions/:sessionId/answers', async (c) => {
  const sessionId = Number(c.req.param('sessionId'));
  if (!sessionId) return c.json({ success: false, error: 'sessionId が不正です' }, 400);
  const answers = await getGrammarSessionAnswers(c.env.DB, sessionId);
  return c.json({ success: true, answers });
});

grammar.get('/api/grammar/admin/books', async (c) => {
  const books = await getGrammarBooks(c.env.DB, c.req.query('lineAccountId') || null);
  return c.json({ success: true, books });
});

/** 問題の一覧。管理画面の「問題集」タブで中身を確かめるのに使う。 */
grammar.get('/api/grammar/admin/questions', async (c) => {
  const bookId = Number(c.req.query('book_id'));
  if (!bookId) return c.json({ success: false, error: 'book_id は必須です' }, 400);
  const res = await getGrammarQuestions(c.env.DB, bookId, {
    category: c.req.query('category') || null,
    limit: Number(c.req.query('limit')) || 200,
    offset: Number(c.req.query('offset')) || 0,
  });
  return c.json({ success: true, ...res });
});

/**
 * 全生徒ぶんの誤答の傾向。
 *
 * 「みんなが同じ誤答を選んでいる」なら、その勘違いを授業で扱う価値がある。
 * 「正解以外がばらけている」なら、単に知らないだけ。区別できるのがこの数字の意味。
 */
grammar.get('/api/grammar/admin/distractors', async (c) => {
  const bookId = Number(c.req.query('book_id'));
  if (!bookId) return c.json({ success: false, error: 'book_id は必須です' }, 400);
  const friendId = c.req.query('friendId') || null;
  const distractors = await getGrammarDistractors(
    c.env.DB,
    friendId,
    bookId,
    Number(c.req.query('limit')) || 30,
  );
  return c.json({ success: true, distractors });
});

/**
 * 問題集の登録・更新（JSON or 貼り付け）。
 *
 * 問題データはリポジトリに置かない方針なので、投入はこのエンドポイントか
 * ローカルからの d1 execute で行う。
 */
grammar.post('/api/grammar/admin/books', async (c) => {
  const body = await c.req.json<{
    slug?: string;
    name?: string;
    lineAccountId?: string | null;
    sort?: number;
    questions?: GrammarQuestionInput[];
    tsv?: string;
  }>();

  if (!body.slug || !body.name) {
    return c.json({ success: false, error: 'slug / name は必須です' }, 400);
  }

  let questions = body.questions ?? [];
  let errors: string[] = [];
  if (!questions.length && body.tsv) {
    const parsed = parseQuestionTsv(body.tsv);
    questions = parsed.questions;
    errors = parsed.errors;
  }

  // 中身の検査。エラーは弾き、警告は通したうえで画面に出す（`02-generation.md`）
  const checked = inspect(questions);
  errors = errors.concat(checked.errors);

  // 1行でも壊れていたら**何も入れない。** 半分だけ入った状態がいちばん厄介で、
  // どこまで入ったか分からないまま再投入すると番号がずれる。
  if (errors.length) {
    return c.json({ success: false, error: '取り込めない行があります', errors }, 400);
  }

  const book = await upsertGrammarBook(c.env.DB, {
    slug: body.slug,
    name: body.name,
    lineAccountId: body.lineAccountId ?? null,
    sort: body.sort ?? 0,
  });

  const count = questions.length ? await replaceGrammarQuestions(c.env.DB, book.id, questions) : 0;
  return c.json({ success: true, book, imported: count, warnings: checked.warnings });
});

/**
 * 取り込む問題の検査。
 *
 * 仕様は `.company/英弱ニキ/lms/grammar/02-generation.md`。
 *
 * **エラーと警告を分ける。**
 *   エラー … 問題として成立しないもの。弾く
 *   警告   … 入るが「消去法で解けるかもしれない」もの。人が見て判断する
 *
 * 警告の大半は**バッチ全体の統計**でしか出ない（正解の位置の偏り、長さのリーク）。
 * 少量ずつ入れると検出できないので、1単元ぶんまとめて取り込むこと。
 */
function inspect(questions: GrammarQuestionInput[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!questions.length) return { errors, warnings };

  const noExplanation: number[] = [];
  const noLabels: number[] = [];
  const oddLength: number[] = [];
  let longestIsAnswer = 0;
  const answerPos = new Map<number, number>();

  /**
   * 同じ指摘を問題ごとに1行ずつ出すと、数十問のバッチで警告が数十行になって読まれない。
   * 件数と番号だけをまとめて1行にする。
   */
  const summarize = (nos: number[], message: string) => {
    if (!nos.length) return;
    const head = nos.slice(0, 10).join(', ');
    warnings.push(`${message}（${nos.length}問：No.${head}${nos.length > 10 ? ' ほか' : ''}）`);
  };

  for (const q of questions) {
    const at = `No.${q.no}`;
    // ── エラー ──
    if (q.answer < 0 || q.answer >= q.choices.length) {
      errors.push(`${at}: 正解の添字が選択肢の範囲外です`);
      continue;
    }
    // 空白と大小文字を無視して比べる。「to  do」と「To do」は同じ選択肢
    const norm = q.choices.map((c) => c.trim().toLowerCase().replace(/\s+/g, ' '));
    const dup = norm.filter((c, i) => norm.indexOf(c) !== i);
    if (dup.length) {
      errors.push(`${at}: 選択肢が重複しています（「${dup[0]}」）`);
      continue;
    }
    if (q.choices.some((c) => !c.trim())) {
      errors.push(`${at}: 空の選択肢があります`);
      continue;
    }

    // ── 警告 ──
    if (!q.explanation?.trim()) noExplanation.push(q.no);

    const labels = q.distractors ?? {};
    const labelled = Object.keys(labels).filter(
      (k) => Number(k) !== q.answer && Number(k) >= 0 && Number(k) < q.choices.length,
    ).length;
    if (labelled < q.choices.length - 1) noLabels.push(q.no);

    answerPos.set(q.answer, (answerPos.get(q.answer) ?? 0) + 1);

    // 長さのリーク。正解を丁寧に書いてしまうと、いちばん長いのが正解になる
    const lens = q.choices.map((c) => c.trim().length);
    const maxLen = Math.max(...lens);
    if (lens[q.answer] === maxLen && lens.filter((l) => l === maxLen).length === 1) {
      longestIsAnswer++;
    }

    // 語数の浮き。
    //
    // **問題ごとには警告しない。バッチ全体の割合で見る。**
    // 文法問題は正解の形が構造的に長くなることがある（would have done は3語だが、
    // 誤答の did / had done は1〜2語にしかならない）。1問ずつ指摘すると
    // 直しようのないものに警告が出続けて、警告そのものが読まれなくなる。
    // 問題なのは「いつも正解が浮いている」という systematic なパターンのほう。
    const words = q.choices.map((c) => c.trim().split(/\s+/).length);
    const others = words.filter((_, i) => i !== q.answer);
    const avg = others.reduce((a, b) => a + b, 0) / (others.length || 1);
    if (avg > 0 && (words[q.answer] > avg * 1.6 || words[q.answer] < avg * 0.6)) {
      oddLength.push(q.no);
    }
  }

  const n = questions.length;
  const pct = (x: number) => Math.round((x / n) * 100);

  if (n >= 10 && longestIsAnswer / n > 0.4) {
    warnings.push(
      `正解がいちばん長い選択肢になっている問題が ${pct(longestIsAnswer)}%（${longestIsAnswer}/${n}）あります。` +
        `長さで正解が分かってしまうので、誤答も同じくらいの長さにしてください`,
    );
  }
  for (const [pos, count] of [...answerPos].sort((a, b) => b[1] - a[1])) {
    if (n >= 10 && count / n > 0.4) {
      warnings.push(
        `正解が${pos + 1}番の問題が ${pct(count)}%（${count}/${n}）あります。位置をばらけさせてください`,
      );
      break;
    }
  }
  if (n >= 10 && oddLength.length / n > 0.4) {
    warnings.push(
      `正解だけ語数が浮いている問題が ${pct(oddLength.length)}%（${oddLength.length}/${n}）あります。` +
        `語数で正解が分かってしまうので、誤答も同じくらいの長さにしてください` +
        `（No.${oddLength.slice(0, 10).join(', ')}${oddLength.length > 10 ? ' ほか' : ''}）`,
    );
  }
  summarize(noExplanation, '解説がありません。文法テストは解説が本体です');
  summarize(
    noLabels,
    '誤答の勘違いラベルが揃っていません。ラベルを書けない誤答は誰も選ばない可能性が高いので作り直してください',
  );

  return { errors, warnings };
}

/**
 * 貼り付け用のTSV。1行1問。
 *
 *   No <TAB> 分野 <TAB> 問題文 <TAB> 選択肢1 <TAB> 選択肢2 <TAB> 選択肢3 <TAB> 選択肢4 <TAB> 正解番号 <TAB> 解説
 *
 * 正解番号は**1始まり**（画面で見える番号と揃える。0始まりは必ず事故る）。
 * 解説は省略可。選択肢は2〜5個まで受ける（末尾の空セルは無視する）。
 *
 * カンマ区切りは受けない。文法問題の問題文と解説にはカンマが入るため。
 */
function parseQuestionTsv(raw: string): { questions: GrammarQuestionInput[]; errors: string[] } {
  const questions: GrammarQuestionInput[] = [];
  const errors: string[] = [];
  const lines = raw.split(/\r?\n/);

  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const cells = line.split('\t').map((x) => x.trim());
    const lineNo = i + 1;

    // 最小は6列（No・分野・問題文・選択肢2つ・正解番号）。解説は7列目以降。
    // ここを7にすると、選択肢2つで解説なしの正当な行を弾いてしまう。
    if (cells.length < 6) {
      errors.push(`${lineNo}行目: 列が足りません（No/分野/問題文/選択肢×2以上/正解番号 が必要）`);
      return;
    }

    const no = Number(cells[0]);
    if (!Number.isInteger(no) || no < 1) {
      errors.push(`${lineNo}行目: 1列目は問題番号（1以上の整数）にしてください`);
      return;
    }
    const category = cells[1];
    const prompt = cells[2];
    if (!category || !prompt) {
      errors.push(`${lineNo}行目: 分野と問題文は空にできません`);
      return;
    }

    // 選択肢は3列目以降。最後の2列（正解番号・解説）を差し引く。
    // 解説が無い行もあるので、末尾から正解番号らしい数字を探す。
    let answerIdx = -1;
    for (let k = cells.length - 1; k >= 5; k--) {
      const v = Number(cells[k]);
      if (Number.isInteger(v) && v >= 1 && v <= 5 && cells[k] !== '') {
        answerIdx = k;
        break;
      }
    }
    if (answerIdx < 0) {
      errors.push(`${lineNo}行目: 正解番号（1〜5）が見つかりません`);
      return;
    }

    const choices = cells.slice(3, answerIdx).filter((x) => x !== '');
    if (choices.length < 2) {
      errors.push(`${lineNo}行目: 選択肢が2つ未満です`);
      return;
    }
    const answer = Number(cells[answerIdx]) - 1; // 1始まり → 0始まり
    if (answer < 0 || answer >= choices.length) {
      errors.push(`${lineNo}行目: 正解番号が選択肢の数（${choices.length}）を超えています`);
      return;
    }

    questions.push({
      no,
      category,
      prompt,
      choices,
      answer,
      explanation: cells.slice(answerIdx + 1).join(' ').trim() || null,
    });
  });

  // 同じ番号が2回出てくると、あとの行が前の行を上書きして静かに消える。
  const seen = new Map<number, number>();
  questions.forEach((q, i) => {
    const prev = seen.get(q.no);
    if (prev !== undefined) errors.push(`No.${q.no} が重複しています（${prev + 1}件目と${i + 1}件目）`);
    seen.set(q.no, i);
  });

  return { questions, errors };
}
