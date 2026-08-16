#!/usr/bin/env node
/**
 * セルフ受験（L2）の入力を作る。
 *
 *   node solve-back-prep.mjs --type grammar questions.json --out ./sb --pick 12 --suspects 3,8,27
 *
 * ★ なぜスクリプトなのか
 *   L2 の肝は「素の状態で解かせる」こと。生成した文脈を持ったまま解くと、
 *   自分の書いた答えをなぞるだけで何も検出できない。正解・解説・勘違いラベルを
 *   **物理的に落とした**ファイルを作っておけば、それを読ませるだけで条件が揃う。
 *   手で切り出すと必ずどこかに答えが残るので、機械でやる。
 *
 * 出す3つ（+採点用）
 *   1-no-choices.md  … 問題文だけ。自由記述で答えさせる → 別解・正解の非一意を炙る
 *   2-choices-only.md… 選択肢だけ。当てさせる → 個別の問題のリークを炙る
 *   3-persona.md     … 勘違いラベルごとの指示つき → 死んだ誤答を炙る
 *   answer-key.json  … 採点用。**解かせるエージェントには渡さないこと**
 *
 * 単語（cloze）は 1 と 3 に相当するものが無い（選択肢は出題時に他の語から作られ、
 * 誤答ラベルも無い）。1 だけを出す。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 再現できる擬似乱数。抽出をやり直すたびに対象が変わると比較できない。 */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function parseArgs(argv) {
  const a = argv.slice(2);
  const get = (k, d = null) => {
    const i = a.indexOf(k);
    return i >= 0 && a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : d;
  };
  const flags = new Set(a.filter((x) => x.startsWith('--')));
  const positional = a.filter((x, i) => {
    if (x.startsWith('--')) return false;
    const prev = a[i - 1];
    return !(prev && prev.startsWith('--') && get(prev) === x);
  });
  return {
    type: get('--type'),
    file: positional[0],
    out: get('--out', './solve-back'),
    pick: Number(get('--pick', '12')),
    seed: Number(get('--seed', '42')),
    suspects: (get('--suspects', '') || '').split(',').map(Number).filter(Boolean),
    all: flags.has('--all'),
  };
}

/**
 * 対象の選び方。L1 が疑った問題を先に入れ、残りを乱数で埋める。
 * 疑わしいものだけを見ると全体像が歪む（偏りは正常な問題の中にしか現れない）ので、
 * ランダム枠は必ず残す。
 */
function select(items, { pick, seed, suspects, all }) {
  if (all || items.length <= pick) return items;
  const byNo = new Map(items.map((x) => [x.no, x]));
  const chosen = [];
  const taken = new Set();
  for (const no of suspects) {
    const it = byNo.get(no);
    if (it && !taken.has(no)) { chosen.push(it); taken.add(no); }
  }
  const rest = items.filter((x) => !taken.has(x.no));
  const r = rng(seed);
  while (chosen.length < pick && rest.length) {
    const i = Math.floor(r() * rest.length);
    chosen.push(rest.splice(i, 1)[0]);
  }
  return chosen.sort((a, b) => a.no - b.no);
}

function loadGrammar(file) {
  const raw = readFileSync(file, 'utf8');
  if (file.endsWith('.json') || raw.trimStart().startsWith('[') || raw.trimStart().startsWith('{')) {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : (p.questions ?? []);
  }
  // TSV。読み方は check.mjs / サーバーと同じ（正解番号を末尾から探す）
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = line.split('\t').map((x) => x.trim());
    if (c.length < 6) continue;
    let ai = -1;
    for (let k = c.length - 1; k >= 5; k--) {
      const v = Number(c[k]);
      if (Number.isInteger(v) && v >= 1 && v <= 5 && c[k] !== '') { ai = k; break; }
    }
    if (ai < 0) continue;
    out.push({
      no: Number(c[0]), category: c[1], prompt: c[2],
      choices: c.slice(3, ai).filter((x) => x !== ''),
      answer: Number(c[ai]) - 1,
      explanation: c.slice(ai + 1).join(' ').trim() || null,
      distractors: null,
    });
  }
  return out;
}

function loadVocab(file) {
  const raw = readFileSync(file, 'utf8');
  if (file.endsWith('.json') || raw.trimStart().startsWith('[') || raw.trimStart().startsWith('{')) {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : (p.words ?? []);
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = line.split('\t').map((x) => x.trim());
    if (c.length < 3) continue;
    out.push({ no: Number(c[0]), en: c[1], ja: c[2], section: c[3] || null, example: c[4] || null, exampleJa: c[5] || null, pos: c[6] || null });
  }
  return out;
}

// ── 出力 ──────────────────────────────────────────────────────

const HEAD_NO_CHOICES = `# セルフ受験 1 — 選択肢を隠して解く

あなたは日本の高校生（共通テストを受ける層）です。以下の問題の空所 ( ) に入る形を、
**選択肢を見ずに**自分で書いてください。1問につき次の3つを答えます。

- 入ると思う形（複数あるなら全部。ここが最重要）
- そう考えた根拠
- 空所以外に意味の取れない語があればその語

答えを1つに絞ろうとしないでください。**成立する形が複数あるなら複数書くこと**が
この作業の目的です（正解が唯一かを確かめている）。

---

`;

const HEAD_CHOICES_ONLY = `# セルフ受験 2 — 選択肢だけを見て当てる

以下は、ある文法問題の選択肢だけです。問題文はありません。
**どれが正解らしいか**を推測し、そう思った根拠を書いてください。

「分からない」でかまいません。むしろ分からないのが正常です。
当てられてしまう場合、選択肢の作りが正解を漏らしています（長さ・丁寧さ・
他の選択肢だけが不自然に崩れている、など）。根拠を具体的に書いてください。

---

`;

const HEAD_PERSONA = `# セルフ受験 3 — 勘違いを持つ生徒として解く

問題ごとに「この勘違いを持つ生徒として解いてください」という指示が付いています。
**その理解のまま**解答してください。正しく解こうとしないこと。

指示された勘違いを持つ人が自然に選ぶものを選び、なぜそれを選んだかを書いてください。
指示の勘違いを持っていても正解を選んでしまうなら、そう書いてください（それが分かるのが目的です）。

---

`;

const HEAD_VOCAB = `# セルフ受験 1 — 例文の空所を自分で埋める

あなたは日本の高校生（共通テストを受ける層）です。以下の英文の空所 ___ に入る語を、
選択肢を見ずに書いてください。1語につき次の3つを答えます。

- 入ると思う語（複数あるなら全部）
- 空所以外に意味の取れない語があればその語（**ここが重要**。空所以外は
  共通テストレベルまでの語彙で作ってあるはずなので、詰まったら例文のほうが悪い）
- 空所に入るのは原形か、活用した形か（活用形が要るなら例文の作りが悪い）

---

`;

function writeGrammar(items, dir) {
  mkdirSync(dir, { recursive: true });

  const a = items.map((q) => `## No.${q.no}\n\n${q.prompt}\n`).join('\n');
  writeFileSync(join(dir, '1-no-choices.md'), HEAD_NO_CHOICES + a);

  const b = items
    .map((q) => `## No.${q.no}\n\n${q.choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n`)
    .join('\n');
  writeFileSync(join(dir, '2-choices-only.md'), HEAD_CHOICES_ONLY + b);

  // 3つ目はラベルのある問題だけ。ラベルが無い問題を混ぜても指示が書けない
  const labelled = items.filter((q) => q.distractors && Object.keys(q.distractors).length);
  const c = labelled
    .map((q) => {
      const tasks = Object.entries(q.distractors)
        .filter(([k]) => Number(k) !== q.answer)
        .map(([, note], i) => `${i + 1}. 「${note}」という勘違いを持つ生徒として解答してください`)
        .join('\n');
      return `## No.${q.no}\n\n${q.prompt}\n\n${q.choices.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\n### 指示（それぞれ別々に答える）\n${tasks}\n`;
    })
    .join('\n');
  writeFileSync(
    join(dir, '3-persona.md'),
    labelled.length
      ? HEAD_PERSONA + c
      : HEAD_PERSONA + '（勘違いラベル（distractor_notes）のある問題がありません。\nTSV では運べない列なので、JSON にしてから作り直してください。）\n',
  );

  writeFileSync(
    join(dir, 'answer-key.json'),
    JSON.stringify(
      items.map((q) => ({
        no: q.no,
        answer: q.answer,
        answerText: q.choices[q.answer],
        choices: q.choices,
        explanation: q.explanation ?? null,
        distractors: q.distractors ?? null,
      })),
      null,
      2,
    ),
  );
  return { total: items.length, labelled: labelled.length };
}

function writeVocab(items, dir) {
  mkdirSync(dir, { recursive: true });
  const withEx = items.filter((w) => w.example);
  const a = withEx.map((w) => `## No.${w.no}\n\n${w.example}\n`).join('\n');
  writeFileSync(join(dir, '1-no-choices.md'), HEAD_VOCAB + a);
  writeFileSync(
    join(dir, 'answer-key.json'),
    JSON.stringify(
      withEx.map((w) => ({ no: w.no, en: w.en, ja: w.ja, pos: w.pos ?? null, exampleJa: w.exampleJa ?? null })),
      null,
      2,
    ),
  );
  return { total: withEx.length, labelled: 0 };
}

// ── エントリポイント ─────────────────────────────────────────

const opts = parseArgs(process.argv);
if (!opts.file || !['grammar', 'vocab'].includes(opts.type)) {
  console.error('usage: node solve-back-prep.mjs --type grammar|vocab <file> [--out DIR] [--pick N] [--suspects 3,8,27] [--seed N] [--all]');
  process.exit(2);
}

const all = opts.type === 'grammar' ? loadGrammar(opts.file) : loadVocab(opts.file);
if (!all.length) {
  console.error('1件も読めませんでした。列区切りがタブか、JSON の形が合っているかを確認してください');
  process.exit(1);
}
const picked = select(all, opts);
const res = opts.type === 'grammar' ? writeGrammar(picked, opts.out) : writeVocab(picked, opts.out);

console.log(`\n${opts.file} から ${all.length}件 中 ${res.total}件を抽出（seed=${opts.seed}）`);
if (opts.suspects.length) console.log(`L1が疑った問題を優先: No.${opts.suspects.join(', ')}`);
console.log(`\n出力先: ${opts.out}`);
if (opts.type === 'grammar') {
  console.log('  1-no-choices.md   … 選択肢を隠して解かせる（正解が唯一かを見る）');
  console.log('  2-choices-only.md … 選択肢だけ当てさせる（個別のリークを見る）');
  console.log(`  3-persona.md      … 勘違いを持つ生徒として解かせる（死んだ誤答を見る／対象 ${res.labelled}問）`);
} else {
  console.log('  1-no-choices.md   … 空所を自由記述で埋めさせる（別解と語彙レベルを見る）');
}
console.log('  answer-key.json   … 採点用。**解かせる側には渡さないこと**\n');
console.log('解かせるときは、生成した文脈を持たない状態で読ませること。');
console.log('自分で解く場合は answer-key.json を開かずに 1 → 2 → 3 の順で。\n');
