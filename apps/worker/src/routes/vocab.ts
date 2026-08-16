/**
 * 単語テスト（受講生専用）
 *
 * 生徒用は LIFF の idToken、講師用は API_KEY。認証経路を混ぜないこと。
 * アクセス制御の設計は `.company/英弱ニキ/lms/vocab/10-access-control.md` が正本。
 *
 * 生徒用エンドポイントは authMiddleware をスキップさせている（Authorization ヘッダを
 * API_KEY ではなく idToken に使うため）。したがって**ゲートが唯一の壁**。
 * 各ハンドラの先頭で必ず requireStudent() を通す。
 * ゲート本体は文法テストと共有している（`lib/student-gate.ts`）。
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
  jstNow,
} from '@line-crm/db';
import type { VocabWordInput } from '@line-crm/db';
import { requireStudent as gateRequireStudent, denied } from '../lib/student-gate.js';
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

// ── 生徒用 ──────────────────────────────────────────────────────────────────

vocab.get('/api/vocab/books', async (c) => {
  const gate = await gateRequireStudent(c, 'vocab');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const books = await getVocabBooks(c.env.DB, gate.friend.line_account_id);
  return c.json({ success: true, books });
});

vocab.get('/api/vocab/words', async (c) => {
  const gate = await gateRequireStudent(c, 'vocab');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }

  const bookId = Number(c.req.query('book_id'));
  const from = Number(c.req.query('from'));
  const to = Number(c.req.query('to'));
  const order = c.req.query('order') === 'rnd' ? 'rnd' : 'seq';
  // 例文穴埋め。例文のある語だけを出し、ダミーも同じ品詞から選べるだけ多めに渡す。
  const cloze = c.req.query('format') === 'cloze';
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

  try {
    // 状態（未挑戦／復習が必要／習得済み）を見て枠を配る。毎回ランダムに引くと
    // 2回目以降がただの引き直しになり、セクションが埋まらない。
    const words = await getSectionTestWords(
      c.env.DB, gate.friend.id, bookId, from, to, limit, cloze,
    );
    if (!words.length) {
      return c.json({ success: true, words: [], decoys: [] });
    }

    // 4択のダミー。出題語だけで作ると選択肢が足りない場面があるので、必ず補充分を渡す。
    const decoys = await getVocabDecoys(
      c.env.DB,
      bookId,
      words.map((w) => w.id),
      // **多めに引くこと。** 20問なら選択肢のダミー枠は延べ60。
      // ここが8だと出題語20語と合わせても28種類しか作れず、同じ語が何度も並ぶ。
      // 穴埋めはさらに正解と同じ品詞に絞るので、その分だけ余計に要る。
      cloze ? 150 : 90,
    );

    return c.json({ success: true, words, decoys });
  } catch (e) {
    // 画面には「通信に失敗しました」としか出ないので、原因はここに残す
    console.error(
      `[vocab/words] friend=${gate.friend.id} book=${bookId} range=${from}-${to} limit=${limit}`,
      e,
    );
    return c.json({ success: false, error: '問題の準備に失敗しました。時間をおいて試してください' }, 500);
  }
});

/** 使う単語帳を決める／あとから切り替える。 */
vocab.put('/api/vocab/book', async (c) => {
  const gate = await gateRequireStudent(c, 'vocab');
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
  const gate = await gateRequireStudent(c, 'vocab');
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
  const gate = await gateRequireStudent(c, 'vocab');
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
  const gate = await gateRequireStudent(c, 'vocab');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const dashboard = await getVocabDashboard(c.env.DB, gate.friend.id, gate.friend.line_account_id);
  return c.json({ success: true, ...dashboard });
});

vocab.get('/api/vocab/records', async (c) => {
  const gate = await gateRequireStudent(c, 'vocab');
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
  const gate = await gateRequireStudent(c, 'vocab');
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
  // 'cloze'（例文穴埋め）も客観式として保存する。未知の値は choice に丸める。
  const format =
    body.format === 'recall' ? 'recall' : body.format === 'cloze' ? 'cloze' : 'choice';
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
    words?: VocabWordInput[];
    tsv?: string;
  }>();

  if (!body.slug || !body.name) {
    return c.json({ success: false, error: 'slug / name は必須です' }, 400);
  }

  let words = body.words ?? [];
  if (!words.length && body.tsv) {
    words = parseTsv(body.tsv);
  }

  // 中身の検査。文法テストの取り込みと同じ考え方（`inspect()` in routes/grammar.ts）。
  const checked = inspectWords(words);

  // 1行でも壊れていたら**何も入れない。** 半分だけ入った状態がいちばん厄介。
  if (checked.errors.length) {
    return c.json({ success: false, error: '取り込めない行があります', errors: checked.errors }, 400);
  }

  const book = await upsertVocabBook(c.env.DB, {
    slug: body.slug,
    name: body.name,
    lineAccountId: body.lineAccountId ?? null,
    sort: body.sort ?? 0,
  });

  const count = words.length ? await replaceVocabWords(c.env.DB, book.id, words) : 0;
  return c.json({ success: true, book, imported: count, warnings: checked.warnings });
});

/**
 * `No<TAB>単語<TAB>意味<TAB>章<TAB>例文<TAB>例文の訳<TAB>品詞` を想定。
 *
 * 5列目以降（例文・訳・品詞）は省略可。**省略した列は既存の値を消さない**
 * （`replaceVocabWords` の COALESCE）。4列だけの貼り付けで例文が全部飛ぶのを防ぐため。
 *
 * カンマ区切りも受けるが、例文にはカンマが入るので**例文を含む行はタブ必須**。
 * カンマで割ってしまうと列がずれ、例文の途中が品詞として入る。
 */
function parseTsv(raw: string): VocabWordInput[] {
  const out: VocabWordInput[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = (line.includes('\t') ? line.split('\t') : line.split(',')).map((x) => x.trim());
    if (cells.length < 2) continue;
    if (/^\d+$/.test(cells[0]) && cells.length >= 3) {
      out.push({
        no: Number(cells[0]),
        en: cells[1],
        ja: cells[2],
        section: cells[3] || null,
        example: cells[4] || null,
        exampleJa: cells[5] || null,
        pos: cells[6] || null,
      });
    } else {
      out.push({ no: out.length + 1, en: cells[0], ja: cells[1], section: cells[2] || null });
    }
  }
  return out;
}

/** 品詞。穴埋めのダミーを同じ品詞から選ぶので、揃っていないと消去法で当たる。 */
const VOCAB_POS = new Set(['v', 'n', 'adj', 'adv', 'prep', 'conj']);

/**
 * 取り込む語の検査。
 *
 * 規則の正本は `.company/英弱ニキ/lms/vocab/12-cloze.md`。
 * 生成した手元で先に回せるよう、同じ規則が
 * `.claude/skills/kyozai-doublecheck/scripts/check.mjs` にもある。
 * **片方だけ直すとずれる。**
 *
 * エラーと警告の分け方は文法テストに揃える。
 *   エラー … 投入自体が失敗する／答えが読めてしまう。弾く
 *   警告   … 入るが「消去法で解けるかもしれない」。人が見て判断する
 *
 * 語義の重複率や品詞ごとの語数は**単語帳ぜんぶ**でしか意味を持たない。
 * ダミーは単語帳全体から引くので、少量ずつ入れると判定できない。
 */
function inspectWords(words: VocabWordInput[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!words.length) return { errors, warnings };

  const norm = (s: string | null | undefined) =>
    String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

  const seenNo = new Set<number>();
  const seenEn = new Map<string, number>();
  const jaGroups = new Map<string, number[]>();
  const posCount = new Map<string, number>();

  const dupEn: number[] = [];
  const noBlank: number[] = [];
  const aAnLeak: number[] = [];
  const inflected: number[] = [];
  const suffixLeak: number[] = [];
  const noExampleJa: number[] = [];
  const badPos: number[] = [];
  let withExample = 0;

  const summarize = (nos: number[], message: string) => {
    if (!nos.length) return;
    const head = nos.slice(0, 10).join(', ');
    warnings.push(`${message}（${nos.length}語：No.${head}${nos.length > 10 ? ' ほか' : ''}）`);
  };

  for (const w of words) {
    const at = `No.${w.no}`;

    // ── エラー ──
    if (!Number.isInteger(w.no) || w.no < 1) {
      errors.push(`${at}: 語番号は1以上の整数にしてください`);
      continue;
    }
    if (seenNo.has(w.no)) {
      errors.push(`${at}: 語番号が重複しています。UNIQUE(book_id, no) に当たります`);
      continue;
    }
    seenNo.add(w.no);
    if (!w.en?.trim() || !w.ja?.trim()) {
      errors.push(`${at}: 単語と意味は空にできません`);
      continue;
    }

    // 同じ語が2回。多義語を別番号で持つ単語帳は実在するのでエラーにはしない
    const ek = norm(w.en);
    if (seenEn.has(ek)) dupEn.push(w.no);
    else seenEn.set(ek, w.no);

    const jk = norm(w.ja);
    if (!jaGroups.has(jk)) jaGroups.set(jk, []);
    jaGroups.get(jk)!.push(w.no);

    // ── 例文（cloze）──
    if (!w.example?.trim()) continue;
    withExample++;
    const ex = w.example;

    if (!/_{2,}/.test(ex)) {
      noBlank.push(w.no);
      continue;
    }
    // 答えが文中にそのまま書いてある。この語の穴埋めは成立しない
    const escaped = ek.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(ex)) {
      errors.push(`${at}: 例文に「${w.en}」がそのまま出ています。答えが読めてしまいます`);
      continue;
    }
    // 空所の直前の a / an。母音か子音かで答えが絞れる
    if (/\b(a|an)\s+_{2,}/i.test(ex)) aAnLeak.push(w.no);
    // 空所には必ず原形（名詞は単数）が入る文脈にする。活用形が答えを教えるため
    if (w.pos === 'v' && /\b(has|have|had|was|were|is|are|been|being)\s+_{2,}/i.test(ex)) {
      inflected.push(w.no);
    }
    if (w.pos === 'n' && /\b(many|several|few|two|three|both|various)\s+_{2,}/i.test(ex)) {
      inflected.push(w.no);
    }
    // 空所の直後に語尾が残っている（___ing / ___ed / ___s）。形が答えを教える
    if (/_{2,}(ing|ed|es|s)\b/i.test(ex)) suffixLeak.push(w.no);

    if (!w.exampleJa?.trim()) noExampleJa.push(w.no);
    if (!w.pos || !VOCAB_POS.has(w.pos)) badPos.push(w.no);
    else posCount.set(w.pos, (posCount.get(w.pos) ?? 0) + 1);
  }

  // 同じ語義を持つ語。4択で「正解と同文言のダミー」が出る母数になる
  const dupJa = [...jaGroups.values()].filter((v) => v.length > 1);
  if (dupJa.length) {
    const affected = dupJa.reduce((a, v) => a + v.length, 0);
    const worst = dupJa.sort((a, b) => b.length - a.length)[0];
    warnings.push(
      `同じ語義を持つ語が ${affected}語（${Math.round((affected / words.length) * 100)}%）あります。` +
        `最多は${worst.length}語が同一（No.${worst.slice(0, 6).join(', ')}）`,
    );
  }

  summarize(dupEn, '同じ単語が2回出てきます。多義語を分けているのでなければ番号を確認してください');
  summarize(noBlank, '例文に空所 ___ がありません');
  summarize(aAnLeak, '空所の直前に a / an があります。母音か子音かで答えが絞れます');
  summarize(inflected, '空所に原形（名詞は単数）が入らない文脈です。活用形が答えを教えます');
  summarize(suffixLeak, '空所の直後に語尾（ing / ed / s）が残っています');
  summarize(noExampleJa, '例文の訳がありません。結果画面で復習に使えません');
  summarize(badPos, `品詞が未設定か想定外の値です（${[...VOCAB_POS].join(' / ')}）。同品詞のダミーを選べません`);

  // 同品詞のダミーが3つ揃わない品詞。**単語帳ぶん揃っていないと判定できない**
  if (withExample >= 10) {
    for (const [pos, count] of posCount) {
      if (count < 4) {
        warnings.push(
          `品詞「${pos}」の例文つき語が ${count}語しかありません。同品詞のダミーを3つ揃えられず、品詞混在の選択肢になります`,
        );
      }
    }
  } else if (withExample > 0) {
    warnings.push(
      `例文つきの語が ${withExample}語しかないので、品詞ごとのダミー不足を判定していません。単語帳ぶんまとめて投入してください`,
    );
  }

  return { errors, warnings };
}
