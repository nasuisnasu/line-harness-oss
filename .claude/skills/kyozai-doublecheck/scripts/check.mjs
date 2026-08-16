#!/usr/bin/env node
/**
 * 教材の機械検査（L1）。生成した直後、投入する前に手元で走らせる。
 *
 *   node check.mjs --type grammar questions.tsv
 *   node check.mjs --type vocab   words.tsv --json
 *
 * ★ ここは apps/worker/src/routes/grammar.ts の inspect() と同じ規則を、
 *   **生成した側の手元で**回すためのもの。サーバー側にしか検査が無いと
 *   「作る → 貼る → 怒られる → 直す」が必ず1往復入る。それを消すのが目的。
 *
 * ★ TSV の読み方もサーバーに合わせてある（正解番号を末尾から探す等）。
 *   ここで独自に読むと、手元では通るのに投入時に列がずれる、が起きる。
 *
 * エラーと警告を分ける方針もサーバーに揃える。
 *   エラー … 問題として成立しない。直すまで投入しない
 *   警告   … 入るが「消去法で解けるかもしれない」。人が見て判断する
 *
 * 警告の大半は**バッチ全体の統計**でしか出ない。少量ずつ検査しても意味が無いので、
 * 1単元ぶん（最低10問／10語）まとめて食わせること。
 */

import { readFileSync } from 'node:fs';

// ── 共通 ──────────────────────────────────────────────────────

/** 空白と大小文字を無視して比べる。「to  do」と「To do」は同じ選択肢。 */
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** 統計警告を出してよい最小件数。これを下回ると偏りは偶然と区別できない。 */
const STAT_MIN = 10;

/** バッチ全体の何割を超えたら偏りと見なすか。inspect() と同じ 0.4。 */
const STAT_RATIO = 0.4;

class Report {
  constructor(kind, file, count) {
    this.kind = kind;
    this.file = file;
    this.count = count;
    this.errors = [];
    this.warnings = [];
    /** L2（セルフ受験）で優先的に見るべき問題番号 */
    this.suspects = new Set();
  }
  err(msg) { this.errors.push(msg); }
  warn(msg) { this.warnings.push(msg); }
  suspect(no) { if (no != null) this.suspects.add(no); }

  /**
   * 同じ指摘を1問ずつ並べると、数十問のバッチで警告が数十行になって読まれない。
   * 件数と番号だけをまとめて1行にする。
   */
  summarize(nos, message) {
    if (!nos.length) return;
    const head = nos.slice(0, 10).join(', ');
    this.warn(`${message}（${nos.length}件：No.${head}${nos.length > 10 ? ' ほか' : ''}）`);
    nos.forEach((n) => this.suspect(n));
  }
}

// ── 文法4択 ───────────────────────────────────────────────────

/**
 * 文法問題の TSV。列の並びと正解番号の探し方は
 * apps/worker/src/routes/grammar.ts の parseQuestionTsv と同じにしてある。
 *
 *   No <TAB> 分野 <TAB> 問題文 <TAB> 選択肢1..5 <TAB> 正解番号 <TAB> 解説
 *
 * 正解番号は**1始まり**（画面で見える番号と揃える）。JSON で渡す場合の
 * answer は**0始まり**なので、変換の向きを間違えないこと。ここが最頻の事故。
 */
function parseGrammarTsv(raw, report) {
  const questions = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const cells = line.split('\t').map((x) => x.trim());
    const lineNo = i + 1;

    if (cells.length < 6) {
      report.err(`${lineNo}行目: 列が足りません（No/分野/問題文/選択肢×2以上/正解番号 が必要）。カンマ区切りになっていないか確認`);
      return;
    }
    const no = Number(cells[0]);
    if (!Number.isInteger(no) || no < 1) {
      report.err(`${lineNo}行目: 1列目は問題番号（1以上の整数）にしてください`);
      return;
    }
    if (!cells[1] || !cells[2]) {
      report.err(`${lineNo}行目: 分野と問題文は空にできません`);
      return;
    }

    // 解説が無い行もあるので、末尾から正解番号らしい数字を探す（サーバーと同じ）
    let answerIdx = -1;
    for (let k = cells.length - 1; k >= 5; k--) {
      const v = Number(cells[k]);
      if (Number.isInteger(v) && v >= 1 && v <= 5 && cells[k] !== '') { answerIdx = k; break; }
    }
    if (answerIdx < 0) {
      report.err(`${lineNo}行目: 正解番号（1〜5）が見つかりません`);
      return;
    }
    const choices = cells.slice(3, answerIdx).filter((x) => x !== '');
    questions.push({
      no,
      category: cells[1],
      prompt: cells[2],
      choices,
      answer: Number(cells[answerIdx]) - 1,
      explanation: cells.slice(answerIdx + 1).join(' ').trim() || null,
      distractors: null,   // TSV では運べない。JSON で渡すこと
      subCategory: null,
    });
  });
  return questions;
}

/**
 * `fromTsv` は「勘違いラベルと単元をそもそも表現できない入力か」。
 * TSV には両方の列が無いので、1問ずつ「付いていません」と出すと全問に警告が並び、
 * 読むべき警告が埋まる。入力形式の問題として1行にまとめる。
 */
function checkGrammar(questions, report, fromTsv) {
  const noExplanation = [];
  const noLabels = [];
  const noSubCategory = [];
  const oddLength = [];
  const answerInPrompt = [];
  const noBlank = [];
  let longestIsAnswer = 0;
  const answerPos = new Map();
  const seenNo = new Map();
  const seenPrompt = new Map();

  for (const q of questions) {
    const at = `No.${q.no}`;

    // ── エラー ──
    if (seenNo.has(q.no)) {
      report.err(`${at}: 問題番号が重複しています。UNIQUE(book_id, no) に当たって投入が落ちます`);
      report.suspect(q.no);
      continue;
    }
    seenNo.set(q.no, true);

    if (q.answer < 0 || q.answer >= q.choices.length) {
      report.err(`${at}: 正解の添字が選択肢の範囲外です（TSVは1始まり／JSONは0始まり。取り違えていないか）`);
      report.suspect(q.no);
      continue;
    }
    const nc = q.choices.map(norm);
    const dup = nc.filter((c, i) => nc.indexOf(c) !== i);
    if (dup.length) {
      report.err(`${at}: 選択肢が重複しています（「${dup[0]}」）`);
      report.suspect(q.no);
      continue;
    }
    if (q.choices.some((c) => !String(c).trim())) {
      report.err(`${at}: 空の選択肢があります`);
      report.suspect(q.no);
      continue;
    }
    // 問題文の使い回し。まとめて生成させると同じ形の問題が混ざる
    const pk = norm(q.prompt);
    if (seenPrompt.has(pk)) {
      report.err(`${at}: 問題文が No.${seenPrompt.get(pk)} と同一です`);
      report.suspect(q.no);
      continue;
    }
    seenPrompt.set(pk, q.no);

    // ── 警告 ──
    if (!q.explanation?.trim()) noExplanation.push(q.no);
    if (!q.subCategory?.trim()) noSubCategory.push(q.no);

    // 空所 ( ) も下線 [ ] も無い問題文。どこを答えるのか分からない可能性がある
    if (!/[（(].*?[)）]/.test(q.prompt) && !/[［[].*?[\]］]/.test(q.prompt)) noBlank.push(q.no);

    // 正解の文言が問題文にそのまま出ている＝空所がすでに埋まっている
    const bare = norm(q.prompt.replace(/[（(].*?[)）]/g, ' '));
    const ans = norm(q.choices[q.answer]);
    if (ans.length >= 4 && bare.includes(ans)) answerInPrompt.push(q.no);

    // 誤答の「勘違いラベル」。書けない誤答は誰も選ばないので実質3択になる
    const labels = q.distractors ?? null;
    if (labels) {
      const labelled = Object.keys(labels).filter(
        (k) => Number(k) !== q.answer && Number(k) >= 0 && Number(k) < q.choices.length && String(labels[k]).trim(),
      ).length;
      if (labelled < q.choices.length - 1) noLabels.push(q.no);
    }

    answerPos.set(q.answer, (answerPos.get(q.answer) ?? 0) + 1);

    // 長さのリーク。正解だけ丁寧に書くと、いちばん長いのが正解になる
    const lens = q.choices.map((c) => String(c).trim().length);
    const maxLen = Math.max(...lens);
    if (lens[q.answer] === maxLen && lens.filter((l) => l === maxLen).length === 1) longestIsAnswer++;

    // 語数の浮き。**1問ずつは警告しない。**文法問題は正解の形が構造的に長くなる
    // ことがある（would have done は3語だが、誤答の did / had done は1〜2語）。
    // 問題なのは「いつも正解が浮いている」という systematic なパターンのほう。
    const words = q.choices.map((c) => String(c).trim().split(/\s+/).length);
    const others = words.filter((_, i) => i !== q.answer);
    const avg = others.reduce((a, b) => a + b, 0) / (others.length || 1);
    if (avg > 0 && (words[q.answer] > avg * 1.6 || words[q.answer] < avg * 0.6)) oddLength.push(q.no);
  }

  const n = questions.length;
  const pct = (x) => Math.round((x / n) * 100);

  if (n < STAT_MIN) {
    report.warn(`${n}問しかないので、位置の偏り・長さのリークといった統計の検査ができていません。1単元ぶんまとめて検査してください`);
  } else {
    if (longestIsAnswer / n > STAT_RATIO) {
      report.warn(`正解がいちばん長い選択肢になっている問題が ${pct(longestIsAnswer)}%（${longestIsAnswer}/${n}）あります。長さで正解が分かるので、誤答も同じくらいの長さにしてください`);
    }
    for (const [pos, count] of [...answerPos].sort((a, b) => b[1] - a[1])) {
      if (count / n > STAT_RATIO) {
        report.warn(`正解が${pos + 1}番の問題が ${pct(count)}%（${count}/${n}）あります。位置をばらけさせてください`);
        break;
      }
    }
    if (oddLength.length / n > STAT_RATIO) {
      report.summarize(oddLength, `正解だけ語数が浮いている問題が ${pct(oddLength.length)}%あります。語数で正解が分かってしまいます`);
    }
  }

  report.summarize(answerInPrompt, '正解の文言が問題文にそのまま出ています');
  report.summarize(noBlank, '問題文に空所 ( ) も下線 [ ] もありません。何を答えるのか不明な可能性');
  report.summarize(noExplanation, '解説がありません。文法テストは解説が本体です');
  if (fromTsv) {
    report.warn('TSV には誤答の勘違いラベル（distractor_notes）と単元（sub_category）の列がありません。両方とも投入するなら JSON にして検査し直してください（ラベルの有無はここでは見られていません）');
  } else {
    report.summarize(noLabels, '誤答の勘違いラベル（distractor_notes）が揃っていません。ラベルを書けない誤答は誰も選ばないので作り直してください');
    report.summarize(noSubCategory, '単元（sub_category）がありません。単元単位の出題・苦手判定に乗りません');
  }
}

// ── 単語・例文穴埋め ──────────────────────────────────────────

/** v / n / adj / adv / prep / conj。穴埋めのダミーを同じ品詞から選ぶために持つ。 */
const POS = new Set(['v', 'n', 'adj', 'adv', 'prep', 'conj']);

/**
 * 単語の TSV。
 *
 *   No <TAB> 単語 <TAB> 意味 <TAB> 章 <TAB> 例文 <TAB> 例文の訳 <TAB> 品詞
 *
 * ★ 5列目以降（例文・訳・品詞）は管理画面の投入エンドポイントが受け取らない。
 *   cloze データを入れるときは d1 execute を使うこと。だからこそ、
 *   ここで検査しておかないと**どの自動検査も通らないまま本番に入る。**
 */
function parseVocabTsv(raw, report) {
  const words = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const cells = line.split('\t').map((x) => x.trim());
    const lineNo = i + 1;
    if (cells.length < 3) {
      report.err(`${lineNo}行目: 列が足りません（No/単語/意味 が必要）。カンマ区切りになっていないか確認`);
      return;
    }
    const no = Number(cells[0]);
    if (!Number.isInteger(no) || no < 1) {
      report.err(`${lineNo}行目: 1列目は語番号（1以上の整数）にしてください`);
      return;
    }
    words.push({
      no,
      en: cells[1],
      ja: cells[2],
      section: cells[3] || null,
      example: cells[4] || null,
      exampleJa: cells[5] || null,
      pos: cells[6] || null,
    });
  });
  return words;
}

function checkVocab(words, report) {
  const seenNo = new Map();
  const seenEn = new Map();
  const jaGroups = new Map();

  const noExample = [];
  const noBlank = [];
  const dupEn = [];
  const aAnLeak = [];
  const inflected = [];
  const suffixLeak = [];
  const noExampleJa = [];
  const badPos = [];
  const posCount = new Map();

  for (const w of words) {
    const at = `No.${w.no}`;

    // ── エラー ──
    if (!Number.isInteger(w.no) || w.no < 1) { report.err(`${at}: 語番号は1以上の整数にしてください`); continue; }
    if (seenNo.has(w.no)) { report.err(`${at}: 語番号が重複しています。UNIQUE(book_id, no) に当たります`); report.suspect(w.no); continue; }
    seenNo.set(w.no, true);
    if (!w.en || !w.ja) { report.err(`${at}: 単語と意味は空にできません`); report.suspect(w.no); continue; }

    // 同じ語が2回。多義語を別番号で持つ単語帳は実在するのでエラーにはしない
    // （サーバー側の inspectWords と同じ扱い。片方だけ厳しくするとずれる）
    const ek = norm(w.en);
    if (seenEn.has(ek)) dupEn.push(w.no);
    else seenEn.set(ek, w.no);

    // 語義の重複は4択のダミーに効いてくる。エラーではないが母数を出す
    const jk = norm(w.ja);
    if (!jaGroups.has(jk)) jaGroups.set(jk, []);
    jaGroups.get(jk).push(w.no);

    // ── 例文（cloze）──
    if (!w.example) { noExample.push(w.no); continue; }
    const ex = w.example;

    if (!/_{2,}/.test(ex)) { noBlank.push(w.no); report.suspect(w.no); continue; }

    // 答えが文中にそのまま書いてある
    if (new RegExp(`\\b${ek.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(ex)) {
      report.err(`${at}: 例文に「${w.en}」がそのまま出ています。答えが読めてしまいます`);
      report.suspect(w.no);
      continue;
    }

    // 空所の直前の a / an。母音か子音かで答えが絞れる
    if (/\b(a|an)\s+_{2,}/i.test(ex)) aAnLeak.push(w.no);

    // 空所に原形が入らない文脈。空所は必ず原形（名詞は単数）が入る前提で作ってある
    if (w.pos === 'v' && /\b(has|have|had|was|were|is|are|been|being)\s+_{2,}/i.test(ex)) inflected.push(w.no);
    if (w.pos === 'n' && /\b(many|several|few|two|three|both|various)\s+_{2,}/i.test(ex)) inflected.push(w.no);

    // 空所の直後に語尾が残っている（___ing / ___ed / ___s）。形が答えを教える
    if (/_{2,}(ing|ed|es|s)\b/i.test(ex)) suffixLeak.push(w.no);

    if (!w.exampleJa) noExampleJa.push(w.no);

    // 品詞。ダミーを同じ品詞から選ぶので、無いと消去法で当たる問題になる
    if (!w.pos || !POS.has(w.pos)) badPos.push(w.no);
    else posCount.set(w.pos, (posCount.get(w.pos) ?? 0) + 1);
  }

  const withExample = words.length - noExample.length;

  // 同じ語義を持つ語。4択で「正解と同じ文言のダミー」が出る母数になる
  const dupJa = [...jaGroups.values()].filter((v) => v.length > 1);
  if (dupJa.length) {
    const affected = dupJa.reduce((a, v) => a + v.length, 0);
    const worst = dupJa.sort((a, b) => b.length - a.length)[0];
    report.warn(
      `同じ語義を持つ語が ${affected}語（${Math.round((affected / words.length) * 100)}%）あります。` +
      `最多は${worst.length}語が同一（No.${worst.slice(0, 6).join(', ')}）。` +
      `出題時に正解と同文言のダミーを外す実装が要ります（既に入っているかを確認）`,
    );
  }

  report.summarize(dupEn, '同じ単語が2回出てきます。多義語を分けているのでなければ番号を確認してください');

  if (withExample === 0) {
    report.warn('例文が1件もありません。例文穴埋め（cloze）を作らないバッチならこれで正常です');
  } else {
    report.summarize(noBlank, '例文に空所 ___ がありません');
    report.summarize(aAnLeak, '空所の直前に a / an があります。母音か子音かで答えが絞れます');
    report.summarize(inflected, '空所に原形（名詞は単数）が入らない文脈です。活用形が答えを教えます');
    report.summarize(suffixLeak, '空所の直後に語尾（ing / ed / s）が残っています');
    report.summarize(noExampleJa, '例文の訳がありません。結果画面で復習に使えません');
    report.summarize(badPos, `品詞が未設定か想定外の値です（${[...POS].join(' / ')}）。同品詞のダミーを選べません`);

    // 同品詞のダミーが3つ揃わない品詞。揃わない語は条件を外して埋めることになる。
    //
    // **単元ぶん揃っていないと意味が無い検査。** 手元の数語だけを食わせると
    // 全品詞が「足りません」になって、本当に足りない品詞（実測では副詞・前置詞・接続詞）が
    // 埋もれる。ダミーは単語帳ぜんぶから引くので、判定も単語帳ぜんぶで行う。
    if (withExample < STAT_MIN) {
      report.warn(`例文つきの語が ${withExample}語しかないので、品詞ごとのダミー不足を判定していません。単語帳ぶんまとめて検査してください`);
    } else {
      for (const [pos, count] of posCount) {
        if (count < 4) {
          report.warn(`品詞「${pos}」の例文つき語が ${count}語しかありません。同品詞のダミーを3つ揃えられず、品詞混在の選択肢になります`);
        }
      }
    }
    if (noExample.length) {
      report.warn(`例文の無い語が ${noExample.length}語あります（例文穴埋めの出題対象から外れます）`);
    }
  }
}

// ── 出力 ──────────────────────────────────────────────────────

function print(report, asJson) {
  if (asJson) {
    console.log(JSON.stringify({
      file: report.file,
      kind: report.kind,
      count: report.count,
      errors: report.errors,
      warnings: report.warnings,
      suspects: [...report.suspects].sort((a, b) => a - b),
    }, null, 2));
    return;
  }

  const unit = report.kind === 'grammar' ? '問' : '語';
  console.log(`\n## 検査結果: ${report.file}（${report.kind} / ${report.count}${unit}）\n`);

  if (report.errors.length) {
    console.log(`### エラー ${report.errors.length}件 — 直すまで投入しない\n`);
    console.log('1行でも壊れていると、投入は何も入れずに落ちます（半分だけ入った状態がいちばん厄介なので、そう作ってある）。\n');
    for (const e of report.errors) console.log(`- ${e}`);
    console.log('');
  } else {
    console.log('### エラー なし\n');
  }

  if (report.warnings.length) {
    console.log(`### 警告 ${report.warnings.length}件 — 人が見て判断\n`);
    for (const w of report.warnings) console.log(`- ${w}`);
    console.log('');
  } else {
    console.log('### 警告 なし\n');
  }

  const s = [...report.suspects].sort((a, b) => a - b);
  if (s.length) {
    console.log(`### L2（セルフ受験）で優先して見る: No.${s.slice(0, 30).join(', ')}${s.length > 30 ? ' ほか' : ''}\n`);
  }
  console.log('機械で見えるのはここまで。「誤答が本当に選ばれるか」「正解が唯一か」は');
  console.log('references/solve-back.md の手順で解かせて確かめること。\n');
}

// ── エントリポイント ─────────────────────────────────────────

function main(argv) {
  const args = argv.slice(2);
  const asJson = args.includes('--json');
  const ti = args.indexOf('--type');
  const kind = ti >= 0 ? args[ti + 1] : null;
  const file = args.filter((a, i) => !a.startsWith('--') && i !== ti + 1)[0];

  if (!file || !['grammar', 'vocab'].includes(kind)) {
    console.error('usage: node check.mjs --type grammar|vocab <file.tsv|file.json> [--json]');
    process.exit(2);
  }

  const raw = readFileSync(file, 'utf8');
  const isJson = file.endsWith('.json') || raw.trimStart().startsWith('[') || raw.trimStart().startsWith('{');

  const report = new Report(kind, file, 0);
  let items;
  if (isJson) {
    const parsed = JSON.parse(raw);
    items = Array.isArray(parsed) ? parsed : (parsed.questions ?? parsed.words ?? []);
  } else {
    items = kind === 'grammar' ? parseGrammarTsv(raw, report) : parseVocabTsv(raw, report);
  }
  report.count = items.length;

  if (!items.length) {
    report.err('1件も読めませんでした。列区切りがタブか、ヘッダ行が混ざっていないかを確認してください');
    print(report, asJson);
    process.exit(1);
  }

  if (kind === 'grammar') checkGrammar(items, report, !isJson);
  else checkVocab(items, report);

  print(report, asJson);
  process.exit(report.errors.length ? 1 : 0);
}

main(process.argv);
