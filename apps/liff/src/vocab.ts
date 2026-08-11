/**
 * LIFF 単語テスト（受講生専用）
 *
 * URL: https://liff.line.me/{LIFF_ID}?page=vocab
 *
 * ホーム → 設定 → 出題 → 結果 → 記録 の5画面。
 * 出題まわりのロジックとデザインは vocab-test.html から移植している。
 *
 * 仕様の正本は `.company/英弱ニキ/lms/vocab/`。とくに次を守ること。
 *   - 数字は「実力テストのスコア」1本。セクションごとの定着率はテストタブの一覧で見せる
 *   - テストは3種類。名前を混ぜないこと
 *       実力テスト   … 全範囲からランダム20問。実力の指標（kind='checkup'）
 *       セクションテスト … 範囲を選んで解く（kind='normal'）
 *       復習テスト   … 間違えた語だけ（kind='review'）
 *   - データが足りないときは数字を出さない
 *   - 時間切れは不正解として送る
 *   - サーバーへの送信は結果画面で1回だけ
 *   - 差し色は --accent 1色だけ
 */

declare const liff: {
  init(config: { liffId: string }): Promise<void>;
  isLoggedIn(): boolean;
  getProfile(): Promise<{ userId: string; displayName: string; pictureUrl?: string }>;
  getIDToken(): string | null;
  isInClient(): boolean;
  closeWindow(): void;
};

import { NUM_FONT_WOFF2_BASE64 } from './vocab-font.js';
import { CAT_PNG_BASE64 } from './vocab-cat.js';

const API_URL = import.meta.env?.VITE_API_URL || 'http://localhost:8787';

// ── 型 ──────────────────────────────────────────────────────────────────────

interface Word {
  id: number;
  no: number;
  en: string;
  ja: string;
  section?: string | null;
}

interface BookSection {
  name: string;
  from: number;
  to: number;
}

interface Book {
  id: number;
  slug: string;
  name: string;
  count: number;
  max_no: number;
  sections: BookSection[];
}

interface BlockMastery {
  block: number;
  from: number;
  to: number;
  total: number;
  mastered: number;
  unmastered: number;
  untried: number;
}

interface DashboardBook {
  id: number;
  name: string;
  total: number;
  mastered: number;
  unmastered: number;
  untried: number;
  rate: number;
  review_count: number;
  last_played_at: string | null;
  blocks: BlockMastery[];
  checkups: { at: string; total: number; correct: number; score: number }[];
  checkup_score: { score: number; correct: number; total: number; sessions: number } | null;
}

interface Dashboard {
  /** null なら未選択。単語帳の選択画面から始める。 */
  selected_book_id: number | null;
  books: DashboardBook[];
  recent: {
    enough: boolean;
    needed: number;
    latest_rate: number | null;
    sessions: { at: string; rate: number; kind: string; total: number; correct: number }[];
  };
  weak_words: { word_id: number; no: number; en: string; ja: string; wrong: number; asked: number }[];
  totals: { answers: number; sessions: number; days: number };
}

interface LogEntry extends Word {
  ok: boolean;
  to: boolean;
  ms: number | null;
}

type Kind = 'normal' | 'review' | 'retry' | 'checkup';

// ── 状態 ────────────────────────────────────────────────────────────────────

/** 範囲は100語ブロック単位でしか選ばせない。キリ番以外を使う場面が無いため。 */
const BLOCK = 100;
/** 1回のテストで出せる上限。サーバーの MAX_WORDS_PER_REQUEST と揃えること。 */
const MAX_QUESTIONS = 500;
/** 実力テストの制限時間（秒）。即答できるかを測るので固定する。 */
const CHECKUP_TIMER = 5;

const cfg = {
  bookId: 0,
  from: 1,
  to: 100,
  lim: 20,
  /** 出題数「全部」。範囲内の全単語を出す（サーバー上限まで）。 */
  limAll: false,
  fmt: 'choice' as 'choice' | 'recall',
  dir: 'ej' as 'ej' | 'je',
  /** 既定はランダム。番号順だと毎回おなじ並びで、順番で覚えてしまう。 */
  ord: 'rnd' as 'seq' | 'rnd',
  tmr: 0,
  /** 実力テストの問題数。多いほど点が安定する（20問は±9ポイント、50問は±6ポイント）。 */
  checkupSize: 20,
};

const state = {
  books: [] as Book[],
  dashboard: null as Dashboard | null,
  pool: [] as Word[],
  decoys: [] as Word[],
  queue: [] as Word[],
  idx: 0,
  log: [] as LogEntry[],
  kind: 'normal' as Kind,
  rangeFrom: null as number | null,
  rangeTo: null as number | null,
  startedAt: '',
  qShownAt: 0,
  shown: false,
  answered: false,
  timedOut: false,
  timer: null as number | null,
  tEnd: 0,
  sending: false,
  switchingBook: false,
  lastResult: null as {
    total: number;
    correct: number;
    mastery: { before: number; after: number; mastered: number; total: number };
    range_mastery: { before: number; after: number; mastered: number; total: number } | null;
  } | null,
};

// ── 小物 ────────────────────────────────────────────────────────────────────

function app(): HTMLElement {
  return document.getElementById('app')!;
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function pct(v: number): string {
  return Math.round(v * 100) + '%';
}

function no3(n: number): string {
  return String(n).padStart(3, '0');
}

function shuffle<T>(a: T[]): T[] {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

/** JST の ISO 文字列。サーバーと表記を揃える。 */
function jstNow(): string {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, -1) + '+09:00';
}

/**
 * 次の共通テストまでの日数。
 *
 * 共通テストは「1月13日以降の最初の土曜日・日曜日」に実施される。
 * 年をまたぐので、その年の日程を過ぎていたら翌年で数え直す。
 */
function daysToExam(now = new Date()): { days: number; date: Date } {
  const firstSatOnOrAfter13 = (year: number): Date => {
    const d = new Date(year, 0, 13);
    while (d.getDay() !== 6) d.setDate(d.getDate() + 1);
    return d;
  };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let exam = firstSatOnOrAfter13(today.getFullYear());
  if (exam < today) exam = firstSatOnOrAfter13(today.getFullYear() + 1);
  const days = Math.round((exam.getTime() - today.getTime()) / 86_400_000);
  return { days, date: exam };
}

function fmtDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[2]}/${m[3]} ${m[4]}:${m[5]}` : iso;
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const idToken = liff.getIDToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      ...options?.headers,
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error || `通信に失敗しました（${res.status}）`);
  return body;
}

// ── スタイル ────────────────────────────────────────────────────────────────

function injectStyles(): void {
  if (document.getElementById('vocab-styles')) return;
  const el = document.createElement('style');
  el.id = 'vocab-styles';
  el.textContent = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&family=Noto+Sans+JP:wght@400;500;700&display=swap');
/* 数字用。数字と記号だけのサブセットを埋め込んである（vocab-font.ts） */
@font-face{font-family:'ChakraNum';font-style:normal;font-weight:700;font-display:block;
  src:url(data:font/woff2;base64,${NUM_FONT_WOFF2_BASE64}) format('woff2')}
/* YouTube のトンマナに合わせたダーク配色で固定。端末の設定には追随しない。

   色はスライドから抽出した値をもとに、暗い地の上で沈まないよう彩度と明度を上げてある
   （抽出値 #983CF1 / #DFF04E → 実装 #A93BFF / #D8FF3A）。
   **発光（グロー）は使わない。** 色だけで蛍光感を出す。

   差し色は2色。役割を固定して混ぜないこと。
     --lime        … 押すところと、できたところ。主ボタン、選択中のチップ、
                      スライダーのつまみ、選択中のタブ、習得済み、正解、成績の数字
     --accent（紫）… ブランドの色。上端の進捗バーと出題カードの光の線だけ。
                      暗い地の上では輝度差が小さく、文字やボタンに使うと読みにくい
     --ng          … 誤答と「復習が必要」だけ。それ以外に使わない */
:root{
  --bg:#13161D; --surface:#1A1E27; --surface2:#232833;
  --line:#2A2F3B; --line2:#3A4150;
  --fg:#FFFFFF; --fg2:#A6ADBB; --fg3:#6E7686;
  --accent:#A93BFF; --accent2:#FFFFFF;
  --lime:#D8FF3A; --blue:#4990EF;
  --ok:#D8FF3A; --ng:#FF5A6E;
  --q:26px; --a:21px; --r:10px;
  /* 主役の数字は等幅をやめる。等幅は桁を揃えるための書体で、大きく出すと間延びする。
     ChakraNum は数字と記号だけのサブセット。**和文や英単語には使わない**（落ちる）。 */
  --num:'ChakraNum',-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;
  color-scheme: dark;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--fg);overflow-x:hidden;
  font-family:"Inter","Noto Sans JP",-apple-system,"Hiragino Sans",sans-serif;
  font-size:16px;line-height:1.75;letter-spacing:-.005em;
  font-feature-settings:"palt" 1;-webkit-font-smoothing:antialiased}
button,input{font-family:inherit;font-size:inherit}
.v-top{background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:blur(14px);
  border-bottom:1px solid var(--line);padding:11px 16px;display:flex;align-items:center;gap:12px;
  position:sticky;top:0;z-index:5}
.v-top .ttl{font-size:15px;font-weight:700;letter-spacing:-.02em;white-space:nowrap;
  display:flex;align-items:center;gap:8px}
.v-top .ttl::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--lime)}
/* min-width:0 が無いと、flexアイテムの最小幅が中身の長さになって縮まず、
   単語帳名が長いときにヘッダーごと横に伸びて画面全体が横スクロールする。 */
.v-top .rng{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--fg3);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.v-top .cnt{margin-left:auto;font-family:"JetBrains Mono",monospace;font-size:12.5px;font-weight:500;
  color:var(--fg2);border:1px solid var(--line2);padding:2px 10px;border-radius:99px;white-space:nowrap}
.v-bar{height:2px;background:var(--line)}
.v-bar i{display:block;height:100%;background:var(--accent);width:0;
  transition:width .25s cubic-bezier(.4,0,.2,1)}
.v-wrap{max-width:860px;margin:0 auto;padding:18px 14px 40px}
.v-hide{display:none !important}

h1{font-size:24px;font-weight:800;letter-spacing:-.03em;margin:6px 0 4px}
.v-sub{font-size:13px;color:var(--fg2);margin:0 0 18px}
.v-card{border:1px solid var(--line);background:var(--surface);border-radius:var(--r);
  padding:16px 16px;margin:0 0 12px}
.v-card > .lg{display:block;font-family:"JetBrains Mono",monospace;font-size:10px;letter-spacing:.18em;
  color:var(--fg3);font-weight:500;margin-bottom:12px;text-transform:uppercase}
.v-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.v-num{width:88px;padding:10px;border:1px solid var(--line2);border-radius:8px;
  background:var(--surface2);color:var(--fg);
  font-family:"JetBrains Mono",monospace;font-size:16px;text-align:center;outline:none}
.v-num:focus{border-color:var(--accent)}
.v-hint{font-size:12.5px;color:var(--fg3)}
.v-chip{border:1px solid var(--line2);background:var(--surface2);color:var(--fg2);
  padding:8px 14px;border-radius:99px;cursor:pointer;font-size:13.5px;font-weight:500;transition:.15s}
/* 選択中はライム。紫は暗い地の上だと輝度差が小さく、選ばれているかが読み取りにくい。
   紫は主ボタン（実行）だけに残す。 */
.v-chip.on{border-color:var(--lime);background:color-mix(in srgb,var(--lime) 16%,transparent);
  color:var(--lime);font-weight:700}
.v-chip:active{transform:scale(.97)}
/* 主ボタンはライム地に暗い文字。暗い地の上では紫より圧倒的に読める。
   紫は上端の進捗バーと出題カードの光の線に残し、ブランドの色として効かせる。 */
.v-go{width:100%;margin-top:8px;padding:16px;border:none;background:var(--lime);color:var(--bg);
  font-size:16px;font-weight:800;border-radius:10px;cursor:pointer;letter-spacing:-.01em}
.v-go:active{transform:scale(.99)}
.v-go:disabled{background:var(--line2);color:var(--fg3);cursor:default}
.v-ghost{width:100%;margin-top:8px;padding:14px;border:1px solid var(--line2);background:var(--surface2);
  color:var(--fg);font-size:15px;font-weight:600;border-radius:10px;cursor:pointer}
.v-ghost:active{transform:scale(.99)}
/* ボタンの直後にカードが続くと詰まって見えるので、ここで区切りを作る */
.v-go + .v-card, .v-ghost + .v-card, .v-go + .v-list, .v-ghost + .v-list,
.v-go + .v-stats, .v-ghost + .v-stats{margin-top:26px}
.v-books{display:flex;flex-wrap:wrap;gap:8px}
.v-book{border:1px solid var(--line2);background:var(--surface2);color:var(--fg2);
  padding:10px 14px;border-radius:10px;cursor:pointer;font-size:14px;font-weight:500;
  text-align:left;line-height:1.35}
.v-book.on{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent);
  color:var(--accent);font-weight:600}
.v-book em{display:block;font-family:"JetBrains Mono",monospace;font-size:10.5px;
  font-style:normal;color:var(--fg3);margin-top:2px;letter-spacing:.03em}
.v-book.on em{color:color-mix(in srgb,var(--accent) 72%,var(--fg3))}

.v-lead{border:1px solid var(--line);background:var(--surface);border-radius:14px;
  padding:16px;margin:0 0 12px}
.v-lead .cap{font-size:13px;color:var(--fg2);margin-bottom:6px}
.v-lead .n{font-family:var(--num);font-variant-numeric:tabular-nums;font-size:32px;font-weight:700;
  color:var(--fg);line-height:1.1;letter-spacing:-.02em}
.v-lead .n em{font-style:normal;font-size:14px;color:var(--fg2);margin-left:4px}

.v-spark{display:block;width:100%;height:118px;margin:8px 0 4px}
.v-stats{display:flex;gap:10px;flex-wrap:wrap}
.v-stat{flex:1;min-width:92px;border:1px solid var(--line);background:var(--surface);
  border-radius:var(--r);padding:13px 14px}
.v-stat b{display:block;font-family:var(--num);font-variant-numeric:tabular-nums;font-size:32px;
  font-weight:700;line-height:1.1;letter-spacing:-.02em}
.v-stat span{font-size:11.5px;color:var(--fg3)}

.v-list{background:var(--surface);border:1px solid var(--line);border-radius:12px;
  margin:0 0 12px;overflow:hidden}
.v-list h3{margin:0;padding:12px 15px;font-size:13px;font-weight:600;color:var(--fg2);
  border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px}
.v-list h3 em{font-family:"JetBrains Mono",monospace;font-size:10.5px;font-style:normal;
  color:var(--ng);border:1px solid color-mix(in srgb,var(--ng) 45%,transparent);
  padding:2px 9px;border-radius:99px}
.v-list h3.o em{color:var(--lime);border-color:color-mix(in srgb,var(--lime) 45%,transparent)}
.v-list ul{margin:0;padding:2px 0;list-style:none;max-height:300px;overflow:auto}
.v-list li{display:grid;grid-template-columns:40px 1fr;gap:2px 8px;padding:8px 15px;font-size:14.5px;
  border-bottom:1px solid var(--line)}
.v-list li:last-child{border-bottom:none}
.v-list li .n{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--fg3);padding-top:3px;
  grid-row:span 2}
.v-list li .e{font-weight:600;letter-spacing:-.01em}
.v-list li .j{color:var(--fg2);font-size:13.5px}
.v-list li .x{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--ng);margin-left:6px}
.v-list li .t{font-family:"JetBrains Mono",monospace;font-size:10px;color:var(--ng)}

/* ── 下部の固定タブ ── */
/* LINE内ブラウザは戻る操作がしづらいので、画面間の移動は必ずここでできるようにする。 */
.v-nav{position:fixed;left:0;right:0;bottom:0;z-index:20;display:flex;
  background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(14px);
  border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom)}
.v-nav button{flex:1;background:none;border:none;color:var(--fg3);font-family:inherit;
  padding:9px 4px 8px;display:flex;flex-direction:column;align-items:center;gap:3px;
  font-size:11px;font-weight:600;letter-spacing:.02em;cursor:pointer}
.v-nav button svg{width:22px;height:22px;display:block;fill:none;stroke:currentColor;stroke-width:1.7;
  stroke-linecap:round;stroke-linejoin:round}
.v-nav button.on{color:var(--lime)}
.v-nav button:active{transform:scale(.97)}
/* タブに隠れないよう、本文の下に余白を作る */
.v-wrap{padding-bottom:96px}

/* ── 猫のカウントダウン ── */
.v-cat{display:flex;align-items:center;gap:12px;border:1px solid var(--line);
  background:var(--surface);border-radius:14px;padding:12px 14px;margin:0 0 12px}
.v-cat .av{width:52px;height:52px;border-radius:50%;background:#FFF;flex:none;
  display:flex;align-items:center;justify-content:center;overflow:hidden}
.v-cat .av img{width:44px;height:44px;object-fit:contain;display:block}
.v-cat .say{min-width:0}
.v-cat .say em{display:block;font-style:normal;font-size:12.5px;color:var(--fg2);line-height:1.5}
.v-cat .say b{display:block;font-family:var(--num);font-variant-numeric:tabular-nums;
  font-size:30px;font-weight:700;color:var(--lime);line-height:1.15;letter-spacing:-.02em}
.v-cat .say b i{font-style:normal;font-size:.48em;font-weight:700;color:var(--fg2);
  margin-left:4px;letter-spacing:0}
.v-cat .dt{margin-left:auto;text-align:right;font-family:var(--num);
  font-variant-numeric:tabular-nums;font-size:11px;color:var(--fg3);line-height:1.5;flex:none}

/* ── セクション一覧（テストタブ） ── */
.v-sec{display:block;width:100%;text-align:left;border:1px solid var(--line);background:var(--surface);
  color:var(--fg);border-radius:12px;padding:13px 14px;margin:0 0 8px;font-family:inherit;cursor:pointer}
.v-sec:active{transform:scale(.995)}
.v-sec .r1{display:flex;align-items:baseline;gap:10px}
.v-sec .rg{font-family:var(--num);font-variant-numeric:tabular-nums;font-size:16px;font-weight:700;
  letter-spacing:-.01em}
.v-sec .pc{margin-left:auto;font-family:var(--num);font-variant-numeric:tabular-nums;font-size:16px;
  font-weight:700;color:var(--lime)}
.v-sec .pc.zero{color:var(--fg3)}
.v-sec .tr{height:6px;background:var(--surface2);border-radius:99px;overflow:hidden;display:flex;margin-top:8px}
.v-sec .tr i{display:block;height:100%;background:var(--lime)}
.v-sec .tr u{display:block;height:100%;background:color-mix(in srgb,var(--ng) 60%,transparent)}
.v-sec .sub{font-family:var(--num);font-variant-numeric:tabular-nums;font-size:11px;color:var(--fg3);
  margin-top:5px;display:block}
details.v-adv{border:1px solid var(--line);background:var(--surface);border-radius:var(--r);
  padding:0 16px;margin:14px 0 0}
details.v-adv summary{cursor:pointer;padding:14px 0;font-size:13.5px;font-weight:600;color:var(--fg2);
  list-style:none;display:flex;align-items:center;gap:8px}
details.v-adv summary::-webkit-details-marker{display:none}
details.v-adv summary::before{content:"+";font-family:var(--num);color:var(--lime);font-weight:700}
details.v-adv[open] summary::before{content:"−"}
details.v-adv > div{padding-bottom:16px}

/* ── 実力テストのスコア ── */
.v-score-card{border:1px solid var(--line);background:var(--surface);border-radius:14px;
  padding:18px 16px;margin:0 0 12px}
.v-score-card .hd{display:flex;align-items:baseline;gap:10px;margin-bottom:2px}
.v-score-card .hd em{font-style:normal;font-size:13.5px;color:var(--fg2);font-weight:600}
.v-score-card .hd span{margin-left:auto;font-family:var(--num);font-variant-numeric:tabular-nums;
  font-size:11px;color:var(--fg3)}
.v-score-card .val{display:flex;align-items:baseline;gap:10px}
.v-score-card .val b{font-family:var(--num);font-variant-numeric:tabular-nums;font-size:58px;
  font-weight:700;color:var(--lime);line-height:.95;letter-spacing:-.02em}
.v-score-card .val b i{font-style:normal;font-size:.34em;font-weight:700;color:var(--fg2);
  margin-left:4px;vertical-align:.5em;letter-spacing:0}
.v-score-card .val u{text-decoration:none;font-family:var(--num);font-variant-numeric:tabular-nums;
  font-size:13px;color:var(--fg2)}
.v-score-card .none{font-size:13.5px;color:var(--fg2);line-height:1.7}

/* ── 単語帳の選択 ── */
.v-pick{display:block;width:100%;text-align:left;border:1px solid var(--line2);background:var(--surface);
  color:var(--fg);border-radius:12px;padding:18px 16px;margin:0 0 10px;cursor:pointer}
.v-pick.on{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent)}
.v-pick b{display:block;font-size:16.5px;font-weight:700;letter-spacing:-.02em}
.v-pick em{display:block;font-style:normal;font-family:"JetBrains Mono",monospace;font-size:11.5px;
  color:var(--fg3);margin-top:4px}
.v-pick:active{transform:scale(.995)}
.v-switch{display:block;margin:2px 0 14px;background:none;border:none;color:var(--fg3);
  font-size:12.5px;text-decoration:underline;cursor:pointer;padding:0}

/* ── 習得の内訳 ── */
.v-note{font-size:12.5px;color:var(--fg3);line-height:1.7;margin:12px 0 0}

/* ── 範囲スライダー ── */
.v-rng{font-family:var(--num);font-variant-numeric:tabular-nums;font-size:27px;font-weight:700;letter-spacing:-.01em;
  display:flex;align-items:baseline;gap:8px;margin:0 0 2px}
.v-rng small{font-size:12px;color:var(--fg3);font-weight:500}
.v-sl{display:flex;align-items:center;gap:12px;margin:14px 0 0}
.v-sl span{font-size:11.5px;color:var(--fg3);width:34px;flex:none}
.v-sl input[type=range]{flex:1;-webkit-appearance:none;appearance:none;background:transparent;height:28px;margin:0}
.v-sl input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:99px;background:var(--line2)}
.v-sl input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:26px;height:26px;
  border-radius:50%;background:var(--lime);border:none;margin-top:-11px;
  box-shadow:0 0 0 1px var(--bg),0 2px 8px rgba(0,0,0,.35)}
.v-sl input[type=range]::-moz-range-track{height:4px;border-radius:99px;background:var(--line2)}
.v-sl input[type=range]::-moz-range-thumb{width:26px;height:26px;border-radius:50%;
  background:var(--lime);border:none}

/* ── 出題 ── */
.v-stage{background:var(--surface);border:1px solid var(--line);border-radius:14px;
  padding:32px 20px;margin:0 0 12px;text-align:center;position:relative;overflow:hidden}
.v-stage::before{content:"";position:absolute;inset:0 0 auto 0;height:1px;
  background:linear-gradient(90deg,transparent,var(--accent),var(--blue),transparent);opacity:.75}
.v-tbar{position:absolute;top:0;left:0;right:0;height:3px;background:var(--line)}
.v-tbar i{display:block;height:100%;width:100%;background:var(--accent);
  transform-origin:left center;transition:background .2s}
.v-tbar.warn i{background:var(--ng)}
.v-tbar b{position:absolute;right:10px;top:9px;font-family:"JetBrains Mono",monospace;
  font-size:11px;font-weight:500;color:var(--fg3)}
.v-tbar.warn b{color:var(--ng)}
.v-qno{font-family:"JetBrains Mono",monospace;font-size:10.5px;letter-spacing:.2em;color:var(--fg3);
  font-weight:500;margin-bottom:14px}
.v-qword{font-size:var(--q);font-weight:700;line-height:1.35;letter-spacing:-.025em;word-break:break-word}
.v-reveal{margin-top:20px;padding-top:18px;border-top:1px solid var(--line)}
.v-aword{font-size:var(--a);font-weight:600;color:var(--lime);line-height:1.5}
.v-opts{display:grid;gap:8px;margin:20px 0 0}
.v-opt{display:flex;align-items:center;gap:11px;padding:12px 13px;border:1px solid var(--line2);
  background:var(--surface2);color:var(--fg);border-radius:10px;cursor:pointer;
  text-align:left;font-size:15px;line-height:1.45;font-weight:500;transition:.14s;width:100%}
.v-opt > span:last-child{min-width:0;word-break:break-word}
.v-opt .k{font-family:"JetBrains Mono",monospace;font-size:11px;font-weight:500;color:var(--fg3);
  border:1px solid var(--line2);width:23px;height:23px;border-radius:6px;display:flex;
  align-items:center;justify-content:center;flex:none}
.v-opt.ok{border-color:var(--lime);background:color-mix(in srgb,var(--lime) 14%,transparent);color:var(--lime)}
.v-opt.ok .k{border-color:var(--lime);color:var(--lime)}
.v-opt.ng{border-color:var(--ng);background:color-mix(in srgb,var(--ng) 12%,transparent);color:var(--ng)}
.v-opt.ng .k{border-color:var(--ng);color:var(--ng)}
.v-acts{display:flex;gap:8px;flex-wrap:wrap}
.v-acts button{flex:1;min-width:120px;padding:14px;border-radius:10px;cursor:pointer;
  font-size:15.5px;font-weight:600;border:1px solid var(--line2);
  background:var(--surface2);color:var(--fg)}
.v-acts button:active{transform:scale(.99)}
.v-acts .pri{background:var(--lime);border-color:var(--lime);color:var(--bg);font-weight:800}
.v-acts .yes{border-color:color-mix(in srgb,var(--lime) 45%,transparent);color:var(--lime)}
.v-acts .no2{border-color:color-mix(in srgb,var(--ng) 45%,transparent);color:var(--ng)}
.v-abort{display:block;margin:16px auto 0;background:none;border:none;color:var(--fg3);
  font-size:12.5px;text-decoration:underline;cursor:pointer}

/* ── 結果 ── */
.v-score{display:flex;align-items:baseline;gap:14px;background:var(--surface);
  border:1px solid var(--line);border-radius:14px;padding:20px;margin:0 0 12px}
.v-score b{font-family:var(--num);font-size:42px;font-weight:700;font-variant-numeric:tabular-nums;
  color:var(--lime);line-height:1;letter-spacing:-.02em}
.v-score span{font-size:13.5px;color:var(--fg2);font-family:var(--num);font-variant-numeric:tabular-nums}
.v-delta{font-family:var(--num);font-variant-numeric:tabular-nums;font-size:14px;color:var(--fg2)}
.v-delta b{color:var(--lime);font-size:20px;font-weight:700}
.v-cp{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px}
.v-cp button{padding:10px 14px;border:1px solid var(--line2);background:var(--surface2);
  color:var(--fg2);border-radius:9px;cursor:pointer;font-size:12.5px;font-weight:600}
.v-cp button.done{border-color:var(--accent);color:var(--accent);
  background:color-mix(in srgb,var(--accent) 12%,transparent)}

/* ── 記録 ── */
.v-hist{width:100%;border-collapse:collapse;font-size:13px}
.v-hist th{font-family:"JetBrains Mono",monospace;font-size:10px;letter-spacing:.1em;color:var(--fg3);
  text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-weight:500}
.v-hist td{padding:9px 10px;border-bottom:1px solid var(--line);color:var(--fg2)}
.v-hist td.s{font-family:"JetBrains Mono",monospace;color:var(--fg);font-weight:600}
.v-blk{display:flex;align-items:center;gap:9px;margin-bottom:6px}
.v-blk .lb{font-family:"JetBrains Mono",monospace;font-size:10.5px;color:var(--fg3);width:64px;flex:none}
.v-blk .tr{flex:1;height:7px;background:var(--surface2);border-radius:99px;overflow:hidden}
.v-blk .tr i{display:block;height:100%;background:var(--lime)}
.v-blk .vl{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--fg2);width:38px;
  text-align:right;flex:none}
.v-empty{text-align:center;color:var(--fg2);font-size:14px;padding:26px 10px}
.v-err{border:1px solid color-mix(in srgb,var(--ng) 45%,transparent);
  background:color-mix(in srgb,var(--ng) 10%,transparent);color:var(--ng);
  border-radius:var(--r);padding:14px;font-size:14px;margin:0 0 12px}
.v-tabs{display:flex;gap:8px;margin:0 0 14px;flex-wrap:wrap}
`;
  document.head.appendChild(el);
}

// ── 画面の骨格 ──────────────────────────────────────────────────────────────

type Tab = 'home' | 'test' | 'records' | null;

/** 下部タブ。出題中は出さない（誤って触ってテストが飛ぶのを防ぐ）。 */
function navBar(active: Tab): string {
  if (!active) return '';
  const item = (key: Exclude<Tab, null>, label: string, path: string) =>
    `<button data-tab="${key}" class="${active === key ? 'on' : ''}">
       <svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>${label}
     </button>`;
  return `
<nav class="v-nav">
  ${item('home', 'ホーム', '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/>')}
  ${item('test', 'テスト', '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9.5 13.5l2 2 3.5-4"/>')}
  ${item('records', '記録', '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M3 20h18"/>')}
</nav>`;
}

function shell(title: string, sub: string, body: string, count = '', tab: Tab = 'home'): string {
  return `
<div class="v-top">
  <span class="ttl">単語テスト</span>
  <span class="rng">${esc(sub)}</span>
  ${count ? `<span class="cnt">${esc(count)}</span>` : ''}
</div>
<div class="v-bar"><i id="vProg"></i></div>
<div class="v-wrap"${tab ? '' : ' style="padding-bottom:40px"'}>${title ? `<h1>${esc(title)}</h1>` : ''}${body}</div>
${navBar(tab)}`;
}

/** タブの配線。画面を描くたびに呼ぶ。 */
function bindNav(): void {
  document.querySelectorAll<HTMLElement>('.v-nav button').forEach((b) => {
    b.onclick = () => {
      const t = b.dataset.tab;
      if (t === 'home') void showHome();
      else if (t === 'test') renderSetup();
      else if (t === 'records') void showRecords();
    };
  });
}

function renderLoading(): void {
  app().innerHTML = shell('', '', '<p class="v-empty">読み込み中...</p>');
}

function renderError(msg: string, retry = true): void {
  app().innerHTML = shell(
    '',
    '',
    `<div class="v-err">${esc(msg)}</div>` +
      (retry ? '<button class="v-ghost" id="vRetry">もう一度読み込む</button>' : ''),
  );
  const r = document.getElementById('vRetry');
  if (r) r.onclick = () => void showHome();
}

// ── ホーム ──────────────────────────────────────────────────────────────────

/**
 * 正答率の推移。
 *
 * **目盛りを必ず描く。** 軸の無い折れ線は上下しか読めず、60%なのか90%なのかが
 * 分からないので意味がない。縦は0〜100%固定にする（データに合わせて伸縮させない）。
 */
function sparkline(points: { rate: number; at: string; kind: string }[]): string {
  if (points.length < 2) return '';
  const W = 320;
  const H = 118;
  const L = 30;
  const R = 8;
  const T = 8;
  const B = 22;
  const iw = W - L - R;
  const ih = H - T - B;
  const x = (i: number) => L + (iw * i) / (points.length - 1);
  const y = (v: number) => T + ih * (1 - v);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.rate).toFixed(1)}`).join(' ');
  const shortDate = (iso: string) => {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${Number(m[2])}/${Number(m[3])}` : '';
  };

  const grid = [0, 0.5, 1]
    .map(
      (v) =>
        `<line x1="${L}" y1="${y(v).toFixed(1)}" x2="${W - R}" y2="${y(v).toFixed(1)}"
           stroke="var(--line2)" stroke-width="1"${v === 0.5 ? ' stroke-dasharray="3 3"' : ''}/>
         <text x="${L - 5}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end"
           fill="var(--fg3)" font-size="10" font-family="JetBrains Mono, monospace">${v * 100}</text>`,
    )
    .join('');

  const dots = points
    .map(
      (p, i) =>
        `<circle cx="${x(i).toFixed(1)}" cy="${y(p.rate).toFixed(1)}" r="${
          p.kind === 'normal' ? 3.5 : 3
        }" fill="${p.kind === 'normal' ? 'var(--lime)' : 'var(--surface)'}"
         stroke="var(--lime)" stroke-width="1.5"/>`,
    )
    .join('');

  return `<svg class="v-spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="正答率の推移">
    ${grid}
    <path d="${d}" fill="none" stroke="var(--lime)" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
    <text x="${L}" y="${H - 6}" fill="var(--fg3)" font-size="10"
      font-family="JetBrains Mono, monospace">${shortDate(points[0].at)}</text>
    <text x="${W - R}" y="${H - 6}" text-anchor="end" fill="var(--fg3)" font-size="10"
      font-family="JetBrains Mono, monospace">${shortDate(points[points.length - 1].at)}</text>
  </svg>`;
}

/**
 * 実力テストのスコア。全範囲からランダム20問の正答率。
 *
 * これが唯一の実力の指標。語ごとの状態はセクション一覧と復習の出題にだけ使う。
 */
function checkupCard(b: DashboardBook): string {
  const cs = b.checkups || [];
  const pooled = b.checkup_score;
  const latest = cs.length ? cs[cs.length - 1] : null;
  const spark = cs.length >= 2 ? sparkline(cs.map((c) => ({ rate: c.score, at: c.at, kind: 'normal' }))) : '';

  if (!pooled || !latest) {
    return `
<div class="v-score-card">
  <div class="hd"><em>実力テストのスコア</em></div>
  <p class="none">単語帳の<b>全範囲</b>から、100語ごとに均等に出します。<br>いま何割答えられるかが分かります。</p>
</div>`;
  }
  return `
<div class="v-score-card">
  <div class="hd"><em>実力テストのスコア</em><span>${esc(fmtDate(latest.at).slice(0, 5))}</span></div>
  <div class="val">
    <b>${Math.round(pooled.score * 100)}<i>%</i></b>
    <u>直近${pooled.sessions}回・${pooled.total}問から算出<br>
       最新は ${Math.round(latest.score * 100)}%（${latest.correct}/${latest.total}）</u>
  </div>
  ${spark}
</div>`;
}

/** 共通テストまでの日数。猫にしゃべらせる。 */
function catBar(): string {
  const { days, date } = daysToExam();
  const md = `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  return `
<div class="v-cat">
  <span class="av"><img src="data:image/png;base64,${CAT_PNG_BASE64}" alt=""></span>
  <span class="say">
    <em>共通テストまで</em>
    <b>${days}<i>日</i></b>
  </span>
  <span class="dt">${esc(md)}<br>（土）から</span>
</div>`;
}

// ── 単語帳の選択 ────────────────────────────────────────────────────────────

/**
 * 最初に必ず1冊選ばせる。だいたいの生徒はどちらか片方しか使わないので、
 * 毎回選ばせるのではなく1回決めて覚えておく（選択は friends.metadata に入る）。
 */
function renderBookPicker(canCancel: boolean): void {
  const body = `
<p class="v-sub">使っている単語帳を選んでください。あとから切り替えられます。</p>
${state.books
  .map(
    (b) =>
      `<button class="v-pick${b.id === cfg.bookId ? ' on' : ''}" data-book="${b.id}">
         <b>${esc(b.name)}</b><em>${b.count} 語</em>
       </button>`,
  )
  .join('')}
${canCancel ? '<button class="v-ghost" id="vCancel">やめる</button>' : ''}`;

  app().innerHTML = shell('単語帳を選ぶ', '', body, '', 'home');
  bindNav();

  document.querySelectorAll<HTMLElement>('.v-pick').forEach((el) => {
    el.onclick = async () => {
      if (state.switchingBook) return;
      state.switchingBook = true;
      const bookId = Number(el.dataset.book);
      try {
        await api('/api/vocab/book', { method: 'PUT', body: JSON.stringify({ book_id: bookId }) });
        cfg.bookId = bookId;
        resetRangeForBook();
        state.dashboard = null;
        await showHome();
      } catch (e) {
        renderError(e instanceof Error ? e.message : '保存に失敗しました');
      } finally {
        state.switchingBook = false;
      }
    };
  });
  const cancel = document.getElementById('vCancel');
  if (cancel) cancel.onclick = () => void showHome();
}

/** 単語帳を変えたら範囲を既定（1〜100）に戻す。前の単語帳の範囲が残ると事故る。 */
function resetRangeForBook(): void {
  const book = state.books.find((b) => b.id === cfg.bookId);
  const max = book ? book.max_no : BLOCK;
  cfg.from = 1;
  cfg.to = Math.min(BLOCK, Math.max(BLOCK, Math.ceil(max / BLOCK) * BLOCK));
  if (cfg.to > max) cfg.to = Math.ceil(max / BLOCK) * BLOCK;
  cfg.to = Math.min(cfg.to, Math.ceil(max / BLOCK) * BLOCK);
  cfg.lim = 20;
  cfg.limAll = false;
}

// ── ホーム ──────────────────────────────────────────────────────────────────

async function showHome(): Promise<void> {
  renderLoading();
  try {
    const [booksRes, dash] = await Promise.all([
      api<{ books: Book[] }>('/api/vocab/books'),
      api<Dashboard>('/api/vocab/dashboard'),
    ]);
    state.books = booksRes.books;
    state.dashboard = dash;
  } catch (e) {
    renderError(e instanceof Error ? e.message : '読み込みに失敗しました');
    return;
  }

  const d = state.dashboard!;
  if (!state.books.length) {
    app().innerHTML = shell('', '', '<p class="v-empty">単語帳がまだ登録されていません。</p>');
    return;
  }

  // 未選択なら選択画面から。選択済みならその1冊だけを見せる。
  if (!d.selected_book_id) {
    cfg.bookId = 0;
    renderBookPicker(false);
    return;
  }
  if (cfg.bookId !== d.selected_book_id) {
    cfg.bookId = d.selected_book_id;
    resetRangeForBook();
  }

  const book = d.books.find((b) => b.id === cfg.bookId);
  if (!book) {
    renderBookPicker(false);
    return;
  }

  const hasHistory = d.totals.sessions > 0;

  // ホームの主導線は実力テスト。復習はその下の補助ボタン。
  const reviewBlock = book.unmastered
    ? '<button class="v-ghost" id="vReview">復習テストを受ける</button>'
    : hasHistory
      ? '<p class="v-note" style="text-align:center">復習が必要な単語はまだありません。</p>'
      : '';

  // ホームはスクロールなしで収める。推移・弱点語・累計は「テスト結果を見る」に置く。
  // ホームは実力テスト1本に絞る。セクションごとの定着率はテストタブ、
  // 数字は実力テストのスコア1本。同じことを2箇所で言わない。
  const body = hasHistory
    ? catBar() +
      checkupCard(book) +
      '<button class="v-go" id="vCheckup">実力テストを受ける</button>' +
      `<div class="v-row" style="justify-content:center;margin-top:10px">${[20, 30, 50]
        .map(
          (n) =>
            `<button class="v-chip${cfg.checkupSize === n ? ' on' : ''}" data-size="${n}">${n}問</button>`,
        )
        .join('')}</div>` +
      '<button class="v-ghost" id="vStart">セクションテストを受ける</button>' +
      reviewBlock +
      '<button class="v-switch" id="vSwitch">単語帳を切り替える</button>'
    : // 空の状態。「記録がありません」で終わらせず、次にやることを出す。
      catBar() +
      checkupCard(book) +
      `<div class="v-lead">
         <div class="cap">${esc(book.name)}</div>
         <div class="n" style="font-size:20px;font-family:inherit;font-weight:700">まずは20語やってみましょう</div>
       </div>
       <button class="v-go" id="vStart">セクションテストを受ける</button>
       <button class="v-switch" id="vSwitch">単語帳を切り替える</button>`;

  app().innerHTML = shell('', book.name, body);
  bindNav();

  const bind = (id: string, fn: () => void) => {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  };
  bind('vStart', () => renderSetup());
  bind('vCheckup', () => void startCheckup());
  document.querySelectorAll<HTMLElement>('[data-size]').forEach((el) => {
    el.onclick = () => {
      cfg.checkupSize = Number(el.dataset.size);
      document.querySelectorAll<HTMLElement>('[data-size]').forEach((x) =>
        x.classList.toggle('on', Number(x.dataset.size) === cfg.checkupSize),
      );
    };
  });
  bind('vRecords', () => void showRecords());
  bind('vReview', () => void startReview());
  bind('vSwitch', () => renderBookPicker(true));
}

// ── 設定 ────────────────────────────────────────────────────────────────────

function blockMax(book: Book): number {
  return Math.ceil(book.max_no / BLOCK);
}

/** セクション（100語ブロック）の一覧。定着率つきで、押すとその範囲のテストが始まる。 */
function renderSetup(): void {
  const book = state.books.find((b) => b.id === cfg.bookId);
  const dash = state.dashboard?.books.find((b) => b.id === cfg.bookId);
  if (!book) return;

  const nBlocks = blockMax(book);
  let fromBlk = Math.min(Math.max(Math.floor((cfg.from - 1) / BLOCK), 0), nBlocks - 1);
  let toBlk = Math.min(Math.max(Math.ceil(cfg.to / BLOCK) - 1, fromBlk), nBlocks - 1);

  const chip = (group: string, v: string, label: string, on: boolean) =>
    `<button class="v-chip${on ? ' on' : ''}" data-g="${group}" data-v="${v}">${esc(label)}</button>`;

  const sections = (dash?.blocks ?? [])
    .map((b) => {
      const rate = b.total ? b.mastered / b.total : 0;
      const w1 = b.total ? (b.mastered / b.total) * 100 : 0;
      const w2 = b.total ? (b.unmastered / b.total) * 100 : 0;
      return `
<button class="v-sec" data-from="${b.from}" data-to="${b.to}">
  <span class="r1">
    <span class="rg">${b.from} – ${b.to}</span>
    <span class="pc${rate ? '' : ' zero'}">${pct(rate)}</span>
  </span>
  <span class="tr"><i style="width:${w1.toFixed(1)}%"></i><u style="width:${w2.toFixed(1)}%"></u></span>
  <span class="sub">習得 ${b.mastered} ／ 復習 ${b.unmastered} ／ 未挑戦 ${b.untried}</span>
</button>`;
    })
    .join('');

  const body = `
<p class="v-sub">セクションを選ぶと、その範囲のテストが始まります。${cfg.lim}問・${
    cfg.fmt === 'choice' ? '4択' : '意味を答える'
  }・${cfg.dir === 'ej' ? '英→日' : '日→英'}。</p>
${sections || '<p class="v-empty">セクションがありません。</p>'}

<details class="v-adv">
  <summary>範囲や形式を細かく決める</summary>
  <div>
    <div class="v-rng" id="vRngLabel"></div>
    <div class="v-hint" id="vRngCount"></div>
    <div class="v-sl"><span>はじめ</span>
      <input type="range" id="vFromSl" min="0" max="${nBlocks - 1}" step="1" value="${fromBlk}"></div>
    <div class="v-sl"><span>おわり</span>
      <input type="range" id="vToSl" min="0" max="${nBlocks - 1}" step="1" value="${toBlk}"></div>

    <p class="v-hint" style="margin:16px 0 6px">出題数</p>
    <div class="v-row">
      ${[10, 20, 30, 50, 100].map((n) => chip('lim', String(n), `${n}問`, !cfg.limAll && cfg.lim === n)).join('')}
      ${chip('lim', 'all', '全部', cfg.limAll)}
    </div>

    <p class="v-hint" style="margin:16px 0 6px">形式</p>
    <div class="v-row">
      ${chip('fmt', 'choice', '4択', cfg.fmt === 'choice')}
      ${chip('fmt', 'recall', '意味を答える', cfg.fmt === 'recall')}
    </div>
    <div class="v-row" style="margin-top:8px">
      ${chip('dir', 'ej', '英 → 日', cfg.dir === 'ej')}
      ${chip('dir', 'je', '日 → 英', cfg.dir === 'je')}
    </div>
    <div class="v-row" style="margin-top:8px">
      ${chip('ord', 'seq', '番号順', cfg.ord === 'seq')}
      ${chip('ord', 'rnd', 'ランダム', cfg.ord === 'rnd')}
    </div>

    <p class="v-hint" style="margin:16px 0 6px">制限時間</p>
    <div class="v-row">
      ${[0, 3, 5, 10, 15].map((n) => chip('tmr', String(n), n ? `${n}秒` : 'なし', cfg.tmr === n)).join('')}
    </div>

    <button class="v-go" id="vBegin">この設定ではじめる</button>
  </div>
</details>
<p class="v-err v-hide" id="vMsg"></p>`;

  app().innerHTML = shell('セクションテスト', book.name, body, '', 'test');
  bindNav();

  document.querySelectorAll<HTMLElement>('.v-sec').forEach((el) => {
    el.onclick = () => {
      cfg.from = Number(el.dataset.from);
      cfg.to = Number(el.dataset.to);
      void startNormal();
    };
  });

  const fromSl = document.getElementById('vFromSl') as HTMLInputElement;
  const toSl = document.getElementById('vToSl') as HTMLInputElement;
  const paint = () => {
    cfg.from = fromBlk * BLOCK + 1;
    cfg.to = Math.min((toBlk + 1) * BLOCK, book.max_no);
    const span = cfg.to - cfg.from + 1;
    if (cfg.limAll) cfg.lim = Math.min(span, MAX_QUESTIONS);
    const shown = Math.min(cfg.lim, span);
    document.getElementById('vRngLabel')!.textContent = `${cfg.from} 〜 ${cfg.to}`;
    document.getElementById('vRngCount')!.textContent = `この範囲に ${span} 語（${shown}問を出題）`;
  };
  fromSl.oninput = () => {
    fromBlk = Number(fromSl.value);
    if (fromBlk > toBlk) { toBlk = fromBlk; toSl.value = String(toBlk); }
    paint();
  };
  toSl.oninput = () => {
    toBlk = Number(toSl.value);
    if (toBlk < fromBlk) { fromBlk = toBlk; fromSl.value = String(fromBlk); }
    paint();
  };

  document.querySelectorAll<HTMLElement>('.v-chip[data-g]').forEach((b) => {
    b.onclick = () => {
      const g = b.dataset.g!;
      document.querySelectorAll<HTMLElement>(`.v-chip[data-g="${g}"]`).forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      if (g === 'tmr') cfg.tmr = Number(b.dataset.v);
      else if (g === 'lim') {
        cfg.limAll = b.dataset.v === 'all';
        if (!cfg.limAll) cfg.lim = Number(b.dataset.v);
        paint();
      } else if (g === 'fmt') cfg.fmt = b.dataset.v as 'choice' | 'recall';
      else if (g === 'dir') cfg.dir = b.dataset.v as 'ej' | 'je';
      else if (g === 'ord') cfg.ord = b.dataset.v as 'seq' | 'rnd';
    };
  });

  document.getElementById('vBegin')!.onclick = () => void startNormal();
  paint();
}

function say(msg: string): void {
  const el = document.getElementById('vMsg');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('v-hide', !msg);
}

// ── テストの開始 ────────────────────────────────────────────────────────────

async function startNormal(): Promise<void> {
  const btn = document.getElementById('vBegin') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  say('');
  try {
    const res = await api<{ words: Word[]; decoys: Word[] }>(
      `/api/vocab/words?book_id=${cfg.bookId}&from=${cfg.from}&to=${cfg.to}&limit=${cfg.lim}&order=${cfg.ord}`,
    );
    if (!res.words.length) {
      say('その範囲に単語がありません。');
      if (btn) btn.disabled = false;
      return;
    }
    state.decoys = res.decoys || [];
    begin(res.words, 'normal', cfg.from, cfg.to);
  } catch (e) {
    say(e instanceof Error ? e.message : '読み込みに失敗しました');
    if (btn) btn.disabled = false;
  }
}

/** 実力テスト。全範囲から100語ごとに均等に出す。 */
async function startCheckup(size = cfg.checkupSize): Promise<void> {
  renderLoading();
  try {
    cfg.checkupSize = size;
    const res = await api<{ words: Word[]; decoys: Word[] }>(
      `/api/vocab/checkup?book_id=${cfg.bookId}&size=${size}`,
    );
    if (!res.words.length) {
      await showHome();
      return;
    }
    state.decoys = res.decoys || [];
    // 条件を毎回そろえないと点が比較できない。4択・英→日・5秒に固定する。
    // 制限なしだと思い出す時間を与えてしまい、「見た瞬間に意味が入るか」を測れない。
    cfg.fmt = 'choice';
    cfg.dir = 'ej';
    cfg.tmr = CHECKUP_TIMER;
    begin(res.words, 'checkup', null, null);
  } catch (e) {
    renderError(e instanceof Error ? e.message : '読み込みに失敗しました');
  }
}

async function startReview(): Promise<void> {
  renderLoading();
  try {
    const res = await api<{ words: Word[]; decoys: Word[] }>(
      `/api/vocab/review?book_id=${cfg.bookId}&limit=20`,
    );
    if (!res.words.length) {
      await showHome();
      return;
    }
    // 復習語が少ないと出題語だけでは4択が埋まらないので、サーバーのダミーを必ず使う
    state.decoys = res.decoys || [];
    begin(res.words, 'review', null, null);
  } catch (e) {
    renderError(e instanceof Error ? e.message : '読み込みに失敗しました');
  }
}

function begin(words: Word[], kind: Kind, from: number | null, to: number | null): void {
  let queue = words.slice();
  if (cfg.ord === 'rnd') queue = shuffle(queue);
  else queue.sort((a, b) => a.no - b.no);

  state.pool = words.slice();
  state.queue = queue;
  state.idx = 0;
  state.log = [];
  state.kind = kind;
  state.rangeFrom = from;
  state.rangeTo = to;
  state.startedAt = jstNow();
  state.lastResult = null;
  renderQuestion();
}

// ── 出題 ────────────────────────────────────────────────────────────────────

function stopTimer(): void {
  if (state.timer !== null) {
    cancelAnimationFrame(state.timer);
    state.timer = null;
  }
}

function startTimer(): void {
  stopTimer();
  state.timedOut = false;
  if (!cfg.tmr) return;
  const bar = document.getElementById('vTbar');
  const fill = document.getElementById('vTfill');
  const left = document.getElementById('vTleft');
  if (!bar || !fill || !left) return;
  bar.classList.remove('v-hide', 'warn');
  state.tEnd = performance.now() + cfg.tmr * 1000;
  const tick = () => {
    const ms = state.tEnd - performance.now();
    const r = Math.max(0, ms / (cfg.tmr * 1000));
    fill.style.transform = `scaleX(${r})`;
    left.textContent = (Math.ceil(Math.max(0, ms) / 100) / 10).toFixed(1);
    bar.classList.toggle('warn', r <= 0.3);
    if (ms <= 0) {
      stopTimer();
      onTimeout();
      return;
    }
    state.timer = requestAnimationFrame(tick);
  };
  tick();
}

function onTimeout(): void {
  if (state.answered) return;
  state.answered = true;
  state.timedOut = true;
  const w = state.queue[state.idx];
  if (cfg.fmt === 'choice') {
    document.querySelectorAll<HTMLButtonElement>('.v-opt').forEach((b) => {
      b.disabled = true;
      if (Number(b.dataset.id) === w.id) b.classList.add('ok');
    });
  } else {
    document.getElementById('vReveal')?.classList.remove('v-hide');
  }
  const acts = document.getElementById('vActs');
  if (acts) acts.innerHTML = '<p class="v-hint" style="text-align:center;width:100%">時間切れ</p>';
  setTimeout(() => mark(false), 1100);
}

function renderQuestion(): void {
  const w = state.queue[state.idx];
  state.shown = false;
  state.answered = false;
  const askEn = cfg.dir === 'ej';

  const body = `
<div class="v-stage">
  <div class="v-tbar${cfg.tmr ? '' : ' v-hide'}" id="vTbar"><i id="vTfill"></i><b id="vTleft"></b></div>
  <div class="v-qno">NO. ${no3(w.no)}</div>
  <div class="v-qword">${esc(askEn ? w.en : w.ja)}</div>
  <div class="v-reveal v-hide" id="vReveal">
    <div class="v-aword">${esc(askEn ? w.ja : w.en)}</div>
  </div>
  <!-- 4択のときは答えを別に出さない。正解の選択肢が色で分かるうえ、
       途中で要素が増えると選択肢の位置がずれて読みづらい -->
  <div class="v-opts${cfg.fmt === 'choice' ? '' : ' v-hide'}" id="vOpts"></div>
</div>
<div class="v-acts" id="vActs"></div>
<button class="v-abort" id="vAbort">中断する（記録は残りません）</button>`;

  app().innerHTML = shell('', '', body, `${state.idx + 1} / ${state.queue.length}`, null);
  const prog = document.getElementById('vProg');
  if (prog) prog.style.width = `${(state.idx / state.queue.length) * 100}%`;

  document.getElementById('vAbort')!.onclick = () => {
    stopTimer();
    void showHome();
  };

  if (cfg.fmt === 'choice') renderChoice(w, askEn);
  else renderRecall();

  state.qShownAt = performance.now();
  startTimer();
}

function renderRecall(): void {
  const acts = document.getElementById('vActs')!;
  acts.innerHTML = '<button class="pri" id="vRev">答えを見る</button>';
  document.getElementById('vRev')!.onclick = reveal;
}

function reveal(): void {
  if (state.shown || state.answered) return;
  state.shown = true;
  state.answered = true;
  stopTimer();
  document.getElementById('vTbar')?.classList.add('v-hide');
  document.getElementById('vReveal')!.classList.remove('v-hide');
  const acts = document.getElementById('vActs')!;
  acts.innerHTML = '<button class="yes" id="vY">できた</button><button class="no2" id="vN">できなかった</button>';
  document.getElementById('vY')!.onclick = () => mark(true);
  document.getElementById('vN')!.onclick = () => mark(false);
}

/**
 * 4択の選択肢に出す短い語義。`；` の前だけを取る。
 *
 * 語義は平均13.9字あり、1900語中1462語が複数の語義を持つ。全部出すと選択肢が2行になり、
 * 5秒の制限時間が「読む速さ」の勝負になってしまう。最初の語義だけなら平均7字に収まる。
 */
function shortJa(ja: string): string {
  const i = ja.indexOf('；');
  return i > 0 ? ja.slice(0, i) : ja;
}

function renderChoice(w: Word, askEn: boolean): void {
  // ダミーは同じテストで出す語から作る。足りないぶんだけサーバーが補ってくれている。
  const others = state.pool.filter((x) => x.id !== w.id);
  const fallback = state.decoys.filter((x) => x.id !== w.id);
  const picked = shuffle(others.length >= 3 ? others : [...others, ...fallback]).slice(0, 3);
  const choices = shuffle([w, ...picked]);

  // 短縮したせいで選択肢が同じ文言になったら、その回だけ全文に戻す
  const labels = choices.map((c) => (askEn ? shortJa(c.ja) : c.en));
  const dup = new Set(labels).size !== labels.length;
  const opts = document.getElementById('vOpts')!;
  opts.innerHTML = choices
    .map(
      (c, i) =>
        `<button class="v-opt" data-id="${c.id}"><span class="k">${i + 1}</span><span>${esc(
          dup ? (askEn ? c.ja : c.en) : labels[i],
        )}</span></button>`,
    )
    .join('');
  opts.querySelectorAll<HTMLButtonElement>('.v-opt').forEach((b) => {
    b.onclick = () => pick(b, w);
  });
}

function pick(btn: HTMLButtonElement, w: Word): void {
  if (state.answered) return;
  state.answered = true;
  stopTimer();
  document.getElementById('vTbar')?.classList.add('v-hide');
  const right = Number(btn.dataset.id) === w.id;
  document.querySelectorAll<HTMLButtonElement>('.v-opt').forEach((b) => {
    b.disabled = true;
    if (Number(b.dataset.id) === w.id) b.classList.add('ok');
    else if (b === btn) b.classList.add('ng');
  });
  setTimeout(() => mark(right), right ? 450 : 1100);
}

function mark(ok: boolean): void {
  stopTimer();
  const w = state.queue[state.idx];
  state.log.push({
    ...w,
    // 時間切れは必ず不正解。画面でも「できなかった」に入れる。
    ok: state.timedOut ? false : ok,
    to: state.timedOut,
    ms: Math.round(performance.now() - state.qShownAt),
  });
  state.idx++;
  if (state.idx >= state.queue.length) void finish();
  else renderQuestion();
}

// ── 結果 ────────────────────────────────────────────────────────────────────

async function finish(): Promise<void> {
  stopTimer();
  renderResult(true);
  await sendSession();
  renderResult(false);
}

async function sendSession(): Promise<void> {
  if (state.sending) return;
  state.sending = true;
  try {
    const res = await api<{
      total: number;
      correct: number;
      mastery: { before: number; after: number; mastered: number; total: number };
      range_mastery: { before: number; after: number; mastered: number; total: number } | null;
    }>('/api/vocab/sessions', {
      method: 'POST',
      body: JSON.stringify({
        // 再送しても二重に入らないよう、セッションごとに1つだけ発行する
        client_session_id: crypto.randomUUID(),
        book_id: cfg.bookId,
        kind: state.kind,
        range_from: state.rangeFrom,
        range_to: state.rangeTo,
        format: cfg.fmt,
        direction: cfg.dir,
        order_mode: cfg.ord,
        timer_sec: cfg.tmr,
        started_at: state.startedAt,
        finished_at: jstNow(),
        answers: state.log.map((l) => ({
          word_id: l.id,
          ok: l.ok ? 1 : 0,
          timed_out: l.to ? 1 : 0,
          elapsed_ms: l.ms,
        })),
      }),
    });
    state.lastResult = res;
    // 進み具合とスコアが変わったのでホームのキャッシュを捨てる
    state.dashboard = null;
  } catch {
    state.lastResult = null;
  } finally {
    state.sending = false;
  }
}

function listBlock(title: string, arr: LogEntry[], ok: boolean): string {
  if (!arr.length) return '';
  return `
<div class="v-list">
  <h3 class="${ok ? 'o' : ''}"><em>${esc(title)}</em><span>${arr.length} 語</span></h3>
  <ul>${arr
    .slice()
    .sort((a, b) => a.no - b.no)
    .map(
      (w) =>
        `<li><span class="n">${no3(w.no)}</span><span class="e">${esc(w.en)}${
          w.to ? ' <span class="t">時間切れ</span>' : ''
        }</span><span class="j">${esc(w.ja)}</span></li>`,
    )
    .join('')}</ul>
</div>`;
}

function renderResult(sending: boolean): void {
  const ok = state.log.filter((x) => x.ok);
  const ng = state.log.filter((x) => !x.ok);
  const r = state.lastResult;

  if (state.kind === 'checkup') {
    // 実力テストは点数がすべて。進み具合の変化は出さない（測っているものが違う）。
    const pt = state.log.length ? Math.round((ok.length / state.log.length) * 100) : 0;
    const body0 = `
<div class="v-score-card">
  <div class="hd"><em>実力テストのスコア</em></div>
  <div class="val"><b>${pt}<i>%</i></b><u>${ok.length} / ${state.log.length} 問</u></div>
  <p class="v-note">単語帳の<b>全範囲</b>からランダムに出しています。セクションテストの点とは別物です。</p>
</div>
${listBlock('できなかった単語', ng, false)}
${listBlock('できた単語', ok, true)}
<button class="v-ghost" id="vHome">ホームに戻る</button>`;
    app().innerHTML = shell('', '実力テスト', body0, '', 'home');
    bindNav();
    document.getElementById('vHome')!.onclick = () => void showHome();
    return;
  }

  // 出すのは「いま解いたセクションの定着率」だけ。単語帳全体の進み具合は出さない。
  const delta = r && r.range_mastery
    ? `<div class="v-card">
         <span class="lg">このセクションの定着率</span>
         <div class="v-delta">${pct(r.range_mastery.before)} → <b>${pct(r.range_mastery.after)}</b>
           <span style="color:var(--fg3)">（${r.range_mastery.mastered}/${r.range_mastery.total}語）</span></div>
       </div>`
    : sending
      ? '<p class="v-hint">記録を保存しています...</p>'
      : `<div class="v-err">記録の保存に失敗しました。<br>電波の良いところで「もう一度保存する」を押してください。</div>
         <button class="v-ghost" id="vResend">もう一度保存する</button>`;

  const body = `
<div class="v-score">
  <b>${ok.length}/${state.log.length}</b>
  <span>正答率 ${state.log.length ? pct(ok.length / state.log.length) : '—'}</span>
</div>
${delta}
${listBlock('できなかった（復習が必要に入りました）', ng, false)}
${listBlock('できた', ok, true)}
<p class="v-hint" style="margin:0 0 8px">コピーは単語帳の番号順に並びます。</p>
<div class="v-cp">
  <button id="vCp1">できなかった単語</button>
  <button id="vCp2">できた単語</button>
  <button id="vCp3">結果を全部</button>
</div>
${ng.length ? '<button class="v-go" id="vAgain">できなかった単語だけ、もう一度</button>' : ''}
<button class="v-ghost" id="vHome">ホームに戻る</button>`;

  app().innerHTML = shell('', '', body, '', 'test');
  bindNav();
  const prog = document.getElementById('vProg');
  if (prog) prog.style.width = '100%';

  const txt = (arr: LogEntry[], withMark: boolean) =>
    arr
      .slice()
      .sort((a, b) => a.no - b.no)
      .map((w) => [no3(w.no), w.en, w.ja].concat(withMark ? [w.ok ? '◯' : '✗'] : []).join('\t'))
      .join('\n');

  const copy = (t: string, btn: HTMLElement) => {
    void navigator.clipboard?.writeText(t);
    btn.classList.add('done');
    const o = btn.textContent;
    btn.textContent = 'コピーしました';
    setTimeout(() => {
      btn.textContent = o;
      btn.classList.remove('done');
    }, 1600);
  };

  document.getElementById('vCp1')!.onclick = (e) => copy(txt(ng, false), e.currentTarget as HTMLElement);
  document.getElementById('vCp2')!.onclick = (e) => copy(txt(ok, false), e.currentTarget as HTMLElement);
  document.getElementById('vCp3')!.onclick = (e) => copy(txt(state.log, true), e.currentTarget as HTMLElement);
  document.getElementById('vHome')!.onclick = () => void showHome();

  const resend = document.getElementById('vResend');
  if (resend) {
    resend.onclick = async () => {
      (resend as HTMLButtonElement).disabled = true;
      await sendSession();
      renderResult(false);
    };
  }

  const again = document.getElementById('vAgain');
  if (again) {
    again.onclick = () => {
      // 復習は最初のテストとは別のセッションとして記録する。元のセッションに追記しない。
      const words: Word[] = ng.map((w) => ({ id: w.id, no: w.no, en: w.en, ja: w.ja }));
      begin(words, 'retry', null, null);
    };
  }
}

// ── 記録 ────────────────────────────────────────────────────────────────────

async function showRecords(): Promise<void> {
  renderLoading();
  let rec: {
    sessions: {
      id: number;
      finished_at: string;
      range_from: number | null;
      range_to: number | null;
      format: string;
      direction: string;
      timer_sec: number;
      kind: string;
      total: number;
      correct: number;
    }[];
    weak_words: { no: number; en: string; ja: string; wrong: number; asked: number }[];
    sections: { from: number; to: number; asked: number; rate: number }[];
    formats: {
      ej: number | null;
      je: number | null;
      choice: number | null;
      recall: number | null;
      timeout_rate: number | null;
    };
  };
  try {
    rec = await api(`/api/vocab/records?book_id=${cfg.bookId}`);
    // 推移と累計はダッシュボード側の集計。ホームから外したぶんここで見せる。
    if (!state.dashboard) state.dashboard = await api<Dashboard>('/api/vocab/dashboard');
  } catch (e) {
    renderError(e instanceof Error ? e.message : '読み込みに失敗しました');
    return;
  }

  const kindLabel = (k: string) => (k === 'review' ? '復習' : k === 'retry' ? 'もう一度' : '通常');
  const fmtLabel = (f: string) => (f === 'recall' ? '自己採点' : '4択');
  const dirLabel = (d: string) => (d === 'je' ? '日→英' : '英→日');

  const history = rec.sessions.length
    ? `<div class="v-card"><span class="lg">テスト履歴</span>
         <table class="v-hist">
           <thead><tr><th>日時</th><th>範囲</th><th>形式</th><th>結果</th></tr></thead>
           <tbody>${rec.sessions
             .map(
               (s) => `<tr>
                 <td>${esc(fmtDate(s.finished_at))}</td>
                 <td>${s.range_from !== null ? `${s.range_from}–${s.range_to}` : kindLabel(s.kind)}</td>
                 <td>${fmtLabel(s.format)} ${dirLabel(s.direction)}${s.timer_sec ? ` ${s.timer_sec}秒` : ''}</td>
                 <td class="s">${s.correct}/${s.total}</td>
               </tr>`,
             )
             .join('')}</tbody>
         </table>
       </div>`
    : '';

  // 基準未満のブロックはサーバーが返してこない。薄く描くと誤読されるので、そもそも描かない。
  const sections = rec.sections.length
    ? `<div class="v-card"><span class="lg">苦手セクション</span>
         ${rec.sections
           .map(
             (s) => `<div class="v-blk">
               <span class="lb">${s.from}–${s.to}</span>
               <span class="tr"><i style="width:${(s.rate * 100).toFixed(1)}%"></i></span>
               <span class="vl">${pct(s.rate)}</span>
             </div>`,
           )
           .join('')}
       </div>`
    : '';

  const fRow = (label: string, v: number | null) =>
    v === null
      ? ''
      : `<div class="v-blk"><span class="lb">${esc(label)}</span>
           <span class="tr"><i style="width:${(v * 100).toFixed(1)}%"></i></span>
           <span class="vl">${pct(v)}</span></div>`;

  const formats = `<div class="v-card"><span class="lg">苦手な形式</span>
      ${fRow('英→日', rec.formats.ej)}
      ${fRow('日→英', rec.formats.je)}
      ${fRow('4択', rec.formats.choice)}
      ${fRow('自己採点', rec.formats.recall)}
      ${fRow('時間切れ率', rec.formats.timeout_rate)}
    </div>`;

  const weak = rec.weak_words.length
    ? `<div class="v-list"><h3>くり返し間違えている単語</h3>
         <ul>${rec.weak_words
           .map(
             (w) =>
               `<li><span class="n">${no3(w.no)}</span><span class="e">${esc(w.en)}<span class="x">×${w.wrong}/${
                 w.asked
               }</span></span><span class="j">${esc(w.ja)}</span></li>`,
           )
           .join('')}</ul>
       </div>`
    : '';

  const d = state.dashboard;
  const trend =
    d && d.recent.enough
      ? `<div class="v-card">
           <span class="lg">セクションテストの正答率</span>
           ${sparkline(d.recent.sessions)}
           <div class="v-mlegend">直近 ${d.recent.sessions.length} 回　最新 ${
             d.recent.latest_rate === null ? '—' : pct(d.recent.latest_rate)
           }</div>
         </div>`
      : d
        ? `<div class="v-card"><span class="lg">セクションテストの正答率</span>
             <p class="v-hint" style="margin:0">あと ${d.recent.needed} 回でグラフが出ます。</p>
           </div>`
        : '';

  const totals = d
    ? `<div class="v-stats">
         <div class="v-stat"><b>${d.totals.answers}</b><span>解いた問題</span></div>
         <div class="v-stat"><b>${d.totals.days}</b><span>学習日数</span></div>
         <div class="v-stat"><b>${d.totals.sessions}</b><span>実施回数</span></div>
       </div>`
    : '';

  const body =
    (rec.sessions.length ? '' : '<p class="v-empty">まだ記録がありません。</p>') +
    trend +
    weak +
    sections +
    (rec.sessions.length ? formats : '') +
    history +
    totals +
    '<button class="v-ghost" id="vHome">ホームに戻る</button>';

  app().innerHTML = shell('', 'テスト結果', body, '', 'records');
  bindNav();
  document.getElementById('vHome')!.onclick = () => void showHome();
}

// ── キーボード（画面共有で使うとき用） ──────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (!document.querySelector('.v-stage')) return;
  if (cfg.fmt === 'recall') {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (state.shown) mark(true);
      else reveal();
    } else if (e.key === '1' && state.shown) mark(true);
    else if (e.key === '2' && state.shown) mark(false);
  } else {
    const n = Number(e.key);
    if (n >= 1 && n <= 4) {
      const b = document.querySelectorAll<HTMLButtonElement>('.v-opt')[n - 1];
      if (b && !state.answered) b.click();
    }
  }
});

// ── 入口 ────────────────────────────────────────────────────────────────────

export async function initVocab(): Promise<void> {
  injectStyles();
  await showHome();
}
