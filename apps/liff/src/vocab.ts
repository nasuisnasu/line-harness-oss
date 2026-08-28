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

import { injectTestStyles } from './test-style.js';
import {
  defaultGoal,
  goalBar,
  goalFormHtml,
  readGoalForm,
  type Goal,
} from './goal.js';
import { CAT_PNG_BASE64 } from './vocab-cat.js';

const API_URL = import.meta.env?.VITE_API_URL || 'http://localhost:8787';

// ── 型 ──────────────────────────────────────────────────────────────────────

interface Word {
  id: number;
  no: number;
  en: string;
  ja: string;
  section?: string | null;
  /** 例文穴埋め用。空所は ___ 。原形（名詞は単数）が入る文脈だけを作ってある */
  example?: string | null;
  example_ja?: string | null;
  /** ダミーを同じ品詞から選ぶために使う。品詞が混ざると消去法で当たる */
  pos?: string | null;
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
  /** 'en' | 'kobun' */
  subject: string;
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

/**
 * どの教科の単語テストとして開いているか。
 *
 * **古文は英単語テストの中の1冊ではなく、別の入り口（`?page=kobun`）で開く独立したテスト。**
 * 生徒から見て別物だし、リッチメニューの枠も別なので、画面も記録も混ぜない。
 * ここが 'en' 以外のときは、
 *   - その教科の単語帳しか見せない（切り替えボタンも出さない）
 *   - **選んだ単語帳をサーバーに保存しない。** 保存は生徒ごとに1つしか持てないので、
 *     古文を開くと英単語テストの選択まで書き換わってしまう
 *   - ホームの数字（解いた問題・学習日数・推移）もその1冊だけで数える
 */
const MODE = { subject: 'en' };

/**
 * ホーム最下部に出す版。
 *
 * LINE内ブラウザはHTMLを強くキャッシュするので「直したはずなのに変わらない」が起きる。
 * この表示を見ればキャッシュか実装かが1往復で切り分く。**中身を変えたら値も上げること。**
 */
const BUILD = '2026-08-28b';

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
  fmt: 'choice' as 'choice' | 'recall' | 'cloze',
  dir: 'ej' as 'ej' | 'je',
  /** 既定はランダム。番号順だと毎回おなじ並びで、順番で覚えてしまう。 */
  ord: 'rnd' as 'seq' | 'rnd',
  tmr: 0,
  /** 実力テストの問題数。多いほど点が安定する（20問は±9ポイント、50問は±6ポイント）。 */
  checkupSize: 20,
};

/**
 * いま選んでいる単語帳が古文か。
 *
 * 古文には**方向が無い**（古語を見て意味を答える一方向だけ）。
 * 意味→古語の向きを出すと、語義の文言が他の語とかぶる単語が34%あるせいで
 * 「すばらしい → ?」に ありがたし・いみじ・めでたし… が7語ぶら下がり、問題が成立しない。
 * 例文穴埋めも英文の空所を埋める形式なので古文には無い。
 */
function isKobun(): boolean {
  return MODE.subject === 'kobun';
}

/** 出題の向きの呼び名。記録画面と設定画面で同じ言い方をする。 */
function dirName(dir: string): string {
  if (isKobun()) return '古語→意味';
  return dir === 'je' ? '日→英' : '英→日';
}

const state = {
  books: [] as Book[],
  dashboard: null as Dashboard | null,
  pool: [] as Word[],
  decoys: [] as Word[],
  /** このテストで既にダミーとして使った語。同じ語が何度も選択肢に出るのを防ぐ */
  usedDecoys: new Set<number>(),
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

/** 目標日。未取得のあいだは既定（共通テスト）を出す。読み込みで画面を止めない。 */
let goal: Goal = defaultGoal();

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

/** 見た目は文法テストと共有している（`test-style.ts`）。ここだけで色を変えないこと。 */
function injectStyles(): void {
  injectTestStyles('vocab-styles');
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
  <span class="ttl">${MODE.subject === 'kobun' ? '古文単語テスト' : '単語テスト'}</span>
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
/**
 * 正答率の推移。
 *
 * ⚠️ **CSSで高さを潰さないこと。** viewBox があるので文字まで一緒に縮む。
 * 一度ホーム用に 58px まで下げたが、縦軸が潰れて推移が読めなくなった。
 * 縮めるなら図形の側を作り分ける。ただし 100px を切ると意味を失う。
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
    <u>直近${pooled.sessions}回・${pooled.total}問／最新 ${Math.round(latest.score * 100)}%</u>
  </div>
  ${spark}
</div>`;
}

/** 共通テストまでの日数。猫にしゃべらせる。 */
/**
 * いま使っている単語帳と、その切り替え。
 *
 * 以前は下線つきのテキストリンクをボタンの2px下に置いていた。
 * 押し間違えるうえ、何のためのリンクか分からなかった。
 * 「いま何を使っているか」を見せる行にして、切り替えはその中に畳む。
 */
function bookRow(book: DashboardBook): string {
  return `
<div class="v-book">
  <div class="t">
    <span class="cap">いま使っている単語帳</span>
    <span class="nm">${esc(book.name)}</span>
  </div>
  <button id="vSwitch">切り替える</button>
</div>`;
}

/** カウントダウン。中身は `goal.ts`（文法テストと共有）。 */
function catBar(): string {
  return goalBar(goal);
}

// ── 目標日（文法テストと共通） ──────────────────────────────────────────────

/** ホームを描く前に取りに行く。落ちても既定で描くので画面は止めない。 */
async function loadGoal(): Promise<void> {
  try {
    const res = await api<{ goal: Goal | null }>('/api/lms/goal');
    goal = res.goal ?? defaultGoal();
  } catch {
    goal = defaultGoal();
  }
}

function renderGoalSetup(): void {
  const isDefault = goal.label === defaultGoal().label;
  app().innerHTML = shell('カウントダウン', '', goalFormHtml(goal, isDefault), '', 'home');
  bindNav();
  const err = document.getElementById('goalErr')!;
  const fail = (m: string) => {
    err.textContent = m;
    err.classList.remove('v-hide');
  };

  document.getElementById('goalSave')!.onclick = async () => {
    const r = readGoalForm();
    if (!r.goal) return fail(r.error!);
    const btn = document.getElementById('goalSave') as HTMLButtonElement;
    btn.disabled = true;
    try {
      await api('/api/lms/goal', { method: 'PUT', body: JSON.stringify(r.goal) });
      goal = r.goal;
      await showHome();
    } catch (e) {
      btn.disabled = false;
      fail(e instanceof Error ? e.message : '保存に失敗しました');
    }
  };

  const reset = document.getElementById('goalReset');
  if (reset) {
    reset.onclick = async () => {
      (reset as HTMLButtonElement).disabled = true;
      try {
        await api('/api/lms/goal', { method: 'DELETE' });
        goal = defaultGoal();
        await showHome();
      } catch (e) {
        (reset as HTMLButtonElement).disabled = false;
        fail(e instanceof Error ? e.message : '保存に失敗しました');
      }
    };
  }
  document.getElementById('goalBack')!.onclick = () => void showHome();
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
        // **英単語テストのときだけサーバーに覚えさせる。**
        // 選択は生徒ごとに1つしか持てないので、古文で保存すると
        // 英単語テストを開いたときの単語帳まで書き換わる（`MODE` のコメント）。
        if (MODE.subject === 'en') {
          await api('/api/vocab/book', { method: 'PUT', body: JSON.stringify({ book_id: bookId }) });
        }
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
  // 英単語帳から古文に持ち込めない設定を戻す。穴埋めのまま古文を始めると
  // 例文の無い語ばかりで1問も出ず、日→英のままだと成立しない問題が並ぶ。
  if (isKobun()) {
    if (cfg.fmt === 'cloze') cfg.fmt = 'choice';
    cfg.dir = 'ej';
  }
}

// ── ホーム ──────────────────────────────────────────────────────────────────

async function showHome(): Promise<void> {
  renderLoading();
  try {
    const [booksRes, dash] = await Promise.all([
      api<{ books: Book[] }>('/api/vocab/books'),
      // 古文は自分の1冊だけで数える。単語帳を指定しないと、解いた問題も学習日数も
      // 推移のグラフも英単語テストと合算されてしまう。
      api<Dashboard>(`/api/vocab/dashboard?subject=${MODE.subject}`),
      // 目標日も一緒に取る。落ちても既定で描くので画面は止めない
      loadGoal(),
    ]);
    state.books = booksRes.books.filter((b) => (b.subject ?? 'en') === MODE.subject);
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

  // 英単語以外は選択画面を出さない。入り口がテストごとに分かれていて、
  // その教科の単語帳は（いまは）1冊しかない。
  if (MODE.subject !== 'en') {
    if (cfg.bookId !== state.books[0].id) {
      cfg.bookId = state.books[0].id;
      resetRangeForBook();
    }
  } else if (!d.selected_book_id) {
    cfg.bookId = 0;
    renderBookPicker(false);
    return;
  } else if (cfg.bookId !== d.selected_book_id) {
    cfg.bookId = d.selected_book_id;
    resetRangeForBook();
  }

  const book = d.books.find((b) => b.id === cfg.bookId);
  if (!book) {
    renderBookPicker(false);
    return;
  }

  const hasHistory = d.totals.sessions > 0;

  // ホームの主導線は実力テスト。やり直しはその下の補助ボタン。
  // 呼び名は文法テストと揃える（同じ機能を別の名前で呼ばない）。
  const reviewBlock = book.unmastered
    ? `<button class="v-ghost" id="vReview">間違えた単語をやり直す（${Math.min(
        book.unmastered,
        20,
      )}語）</button>`
    : hasHistory
      ? '<p class="v-note" style="text-align:center">やり直しが必要な単語はありません。</p>'
      : '';

  // ホームはスクロールなしで収める。推移・弱点語・累計は「テスト結果を見る」に置く。
  // セクションごとの定着率はテストタブ、数字は実力テストのスコア1本。
  // 同じことを2箇所で言わない。
  //
  // **ボタンは枝ごとに並べ直さず、1か所で組む。**
  // 履歴あり／なしで別々に並べていたせいで、履歴ゼロの枝に実力テストのボタンだけ
  // 無い状態になっていた。実機は必ず履歴ゼロから始まるので、
  // 「スコアの説明カードは出ているのに受ける導線が無い」を全員が踏む。
  // 出す・出さないの分岐ではなく、**どちらを主導線にするか**だけを変える。
  //
  // 問題数はここで選ばせない。チップを置くと1行ぶん使って推移グラフを圧迫する。
  // タップ数は変わらない（チップ→ボタン が ボタン→問題数 になるだけ）。文法テストと同じ。
  const checkupBtn = `<button class="${hasHistory ? 'v-go' : 'v-ghost'}" id="vCheckup">実力テストを受ける</button>`;
  const sectionBtn = `<button class="${hasHistory ? 'v-ghost' : 'v-go'}" id="vStart">セクションテストを受ける</button>`;

  const body =
    catBar() +
    checkupCard(book) +
    // 空の状態。「記録がありません」で終わらせず、次にやることを出す。
    (hasHistory
      ? ''
      : `<div class="v-lead">
         <div class="cap">${esc(book.name)}</div>
         <div class="n" style="font-size:20px;font-family:inherit;font-weight:700">まずは20語やってみましょう</div>
       </div>`) +
    // 1問目からいきなり実力テストに行かせない。最初はセクションテストを主導線にして、
    // 実力テストは受けられる状態で下に置く。
    (hasHistory ? checkupBtn + sectionBtn : sectionBtn + checkupBtn) +
    reviewBlock +
    (MODE.subject === 'en' ? bookRow(book) : '');

  app().innerHTML = shell(
    '',
    book.name,
    body + `<p class="v-note" style="text-align:center;opacity:.5">build ${BUILD}</p>`,
  );
  bindNav();

  const bind = (id: string, fn: () => void) => {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  };
  bind('vStart', () => renderSetup());
  bind('vCheckup', () => renderCheckupSetup());
  bind('vRecords', () => void showRecords());
  bind('vReview', () => void startReview());
  bind('vSwitch', () => renderBookPicker(true));
  // カウントダウンを押したら目標日の設定へ（単語テストと共通の設定）
  bind('vGoalBar', () => renderGoalSetup());
}

// ── 設定 ────────────────────────────────────────────────────────────────────

function blockMax(book: Book): number {
  return Math.ceil(book.max_no / BLOCK);
}

/** セクション（100語ブロック）の一覧。定着率つきで、押すとその範囲のテストが始まる。 */
/**
 * 設定画面の1行説明。形式チップを押した瞬間に差し替えるので関数にしてある。
 *
 * 穴埋めに方向（英→日／日→英）は無い。空所に入るのは英単語だけなので、
 * 選ばせると意味のない選択肢を見せることになる。
 */
function setupSummary(): string {
  const fmt = cfg.fmt === 'choice' ? '4択' : cfg.fmt === 'cloze' ? '例文穴埋め' : '意味を答える';
  // 古文は向きが1つしか無いので、わざわざ名乗らせない
  const dir = cfg.fmt === 'cloze' || isKobun() ? '' : `・${dirName(cfg.dir)}`;
  return `セクションを選ぶと、その範囲のテストが始まります。${Math.min(cfg.lim, BLOCK)}問・${fmt}${dir}。`;
}

function renderSetup(): void {
  const book = state.books.find((b) => b.id === cfg.bookId);
  const dash = state.dashboard?.books.find((b) => b.id === cfg.bookId);
  if (!book) return;

  const kobun = isKobun();
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

  // 細かい設定を**一番上**に置く。下にあると、範囲や形式を変えたい人が
  // セクションの一覧を全部スクロールしてから戻ることになる。
  const body = `
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
    <div class="v-row" id="vLimRow"></div>
    <p class="v-hint" id="vLimNote" style="margin:6px 0 0"></p>

    <p class="v-hint" style="margin:16px 0 6px">形式</p>
    <div class="v-row">
      ${chip('fmt', 'choice', '4択', cfg.fmt === 'choice')}
      ${kobun ? '' : chip('fmt', 'cloze', '例文穴埋め', cfg.fmt === 'cloze')}
      ${chip('fmt', 'recall', '意味を答える', cfg.fmt === 'recall')}
    </div>
    <!-- 穴埋めは英文の空所に英単語を入れる形式しかないので、方向の選択は出さない。
         古文はそもそも古語→意味の一方向しか無いので行ごと出さない -->
    <div class="v-row${cfg.fmt === 'cloze' || kobun ? ' v-hide' : ''}" id="vDirRow" style="margin-top:8px">
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
<p class="v-sub" id="vSetupSub" style="margin:20px 0 12px">${setupSummary()}</p>
${sections || '<p class="v-empty">セクションがありません。</p>'}
<p class="v-err v-hide" id="vMsg"></p>`;

  app().innerHTML = shell('セクションテスト', book.name, body, '', 'test');
  bindNav();

  document.querySelectorAll<HTMLElement>('.v-sec').forEach((el) => {
    el.onclick = () => {
      cfg.from = Number(el.dataset.from);
      cfg.to = Number(el.dataset.to);
      cfg.lim = Math.min(cfg.lim, cfg.to - cfg.from + 1, MAX_QUESTIONS);
      void startNormal();
    };
  });

  const fromSl = document.getElementById('vFromSl') as HTMLInputElement;
  const toSl = document.getElementById('vToSl') as HTMLInputElement;

  /**
   * 出題数の選択肢。範囲に入っている語数を超える数は出さない。
   *
   * 以前は「全部」という選択肢があったが、範囲によって20問にも500問にもなり、
   * 押すまで何問か分からなかった。数字で出して MAX_QUESTIONS で頭打ちにする。
   */
  const paintLimits = (span: number) => {
    const opts = [10, 20, 30, 50, 100, 200, 500].filter((n) => n <= Math.min(span, MAX_QUESTIONS));
    const whole = Math.min(span, MAX_QUESTIONS);
    if (!opts.includes(whole)) opts.push(whole);
    if (!opts.includes(cfg.lim)) cfg.lim = opts[Math.min(1, opts.length - 1)];

    const row = document.getElementById('vLimRow');
    if (!row) return;
    row.innerHTML = opts
      .map(
        (n) =>
          `<button class="v-chip${cfg.lim === n ? ' on' : ''}" data-lim="${n}">${n}問${
            n === whole && span > n ? '' : n === whole ? '（全部）' : ''
          }</button>`,
      )
      .join('');
    row.querySelectorAll<HTMLElement>('[data-lim]').forEach((b) => {
      b.onclick = () => {
        cfg.lim = Number(b.dataset.lim);
        paint();
      };
    });
    const note = document.getElementById('vLimNote');
    if (note) {
      note.textContent =
        span > MAX_QUESTIONS
          ? `この範囲は ${span} 語あります。1回のテストは ${MAX_QUESTIONS} 問までです。`
          : '';
    }
  };

  const paintSummary = () => {
    const el = document.getElementById('vSetupSub');
    if (el) el.textContent = setupSummary();
  };
  const paint = () => {
    cfg.from = fromBlk * BLOCK + 1;
    cfg.to = Math.min((toBlk + 1) * BLOCK, book.max_no);
    const span = cfg.to - cfg.from + 1;
    paintLimits(span);
    const shown = Math.min(cfg.lim, span, MAX_QUESTIONS);
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
      else if (g === 'fmt') {
        cfg.fmt = b.dataset.v as 'choice' | 'recall' | 'cloze';
        // 押した瞬間に反映する。描き直しを待つと、穴埋めなのに英→日／日→英が
        // 選べる状態がそのまま残る。
        document.getElementById('vDirRow')?.classList.toggle('v-hide', cfg.fmt === 'cloze' || isKobun());
        paintSummary();
      }
      else if (g === 'dir') { cfg.dir = b.dataset.v as 'ej' | 'je'; paintSummary(); }
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
      `/api/vocab/words?book_id=${cfg.bookId}&from=${cfg.from}&to=${cfg.to}&limit=${cfg.lim}&order=${cfg.ord}` +
        (cfg.fmt === 'cloze' ? '&format=cloze' : ''),
    );
    if (!res.words.length) {
      say(cfg.fmt === 'cloze' ? 'その範囲に例文のある単語がありません。' : 'その範囲に単語がありません。');
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
/**
 * 実力テストの問題数を選ぶ画面。
 *
 * ホームにチップを並べるのをやめてここに移した。ホームは推移グラフを
 * 見せる場所なので、選択肢で行を使いたくない。文法テストと同じ作り。
 */
function renderCheckupSetup(): void {
  const body = `
<p class="v-sub">単語帳の全範囲から、100語ごとに均等に出します。いま何割答えられるかが分かります。<br>
  1問5秒。答え合わせは結果画面でまとめて見られます。</p>
${[20, 30, 50]
  .map((n) => `<button class="v-ghost" data-run="${n}">${n}問で受ける</button>`)
  .join('')}
<button class="v-switch" id="vBack">ホームに戻る</button>`;
  app().innerHTML = shell('実力テスト', '', body, '', 'test');
  bindNav();
  document.querySelectorAll<HTMLElement>('[data-run]').forEach((el) => {
    el.onclick = () => void startCheckup(Number(el.dataset.run));
  });
  document.getElementById('vBack')!.onclick = () => void showHome();
}

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
  state.usedDecoys.clear();
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
  const cloze = cfg.fmt === 'cloze';

  const body = `
<div class="v-stage">
  <div class="v-tbar${cfg.tmr ? '' : ' v-hide'}" id="vTbar"><i id="vTfill"></i><b id="vTleft"></b></div>
  <div class="v-qno">NO. ${no3(w.no)}</div>
  ${
    cloze
      ? // **答えたあとに要素を足さないこと。** 和訳を出していたが、正解でも0.45秒、
        // 不正解でも1.1秒で次の問題に進むので読めないうえ、その一瞬でカードが
        // 伸びて縮む。和訳は結果画面の一覧でゆっくり読ませる。
        //
        // 例文の枠は3行分で固定してある（実測で2行77%・3行23%）。
        // そうしないと、文の長さで選択肢の位置が問題ごとに変わって読みづらい。
        `<div class="v-cloze">${clozeHtml(w.example ?? '')}</div>
  <div class="v-opts" id="vOpts"></div>`
      : // 4択のときは答えを別に出さない。正解の選択肢が色で分かるうえ、
        // 途中で要素が増えると選択肢の位置がずれて読みづらい。
        `<div class="v-qword">${esc(askEn ? w.en : w.ja)}</div>
  <div class="v-reveal v-hide" id="vReveal">
    <div class="v-aword">${esc(askEn ? w.ja : w.en)}</div>
  </div>
  <div class="v-opts${cfg.fmt === 'recall' ? ' v-hide' : ''}" id="vOpts"></div>`
  }
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

  if (cfg.fmt === 'recall') renderRecall();
  else renderChoice(w, askEn);

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

/** 例文の `___` を空所の見た目に変える。文字は先にエスケープしてから置き換える。 */
function clozeHtml(ex: string): string {
  return esc(ex).replace('___', '<i class="v-blank"></i>');
}

function renderChoice(w: Word, askEn: boolean): void {
  const cloze = cfg.fmt === 'cloze';
  // 穴埋めの選択肢は常に英単語。空所に入るのは原形（名詞は単数）だけなので、
  // 活用形が答えを教えることはない（例文をそう作ってある）。
  const label = (c: Word) => (cloze ? c.en : askEn ? shortJa(c.ja) : c.en);
  const answer = label(w);

  // **正解と同じ文言になるダミーを外す。**
  // シス単は223語（11%）が他の語と同じ語義を持つ（「すばらしい」が7語など）。
  // 選択肢に同じ文言が並ぶと、その問題は答えようがなくなる。
  //
  // **出題語とダミーは混ぜてからシャッフルする。**
  // 出題語を先に使うと、20問のあいだ同じ20語が選択肢を埋め続ける。
  // 実測で「20問・延べ60枠に対しダミーは22種類、最多の語は6回」まで偏っていた。
  const usable = (c: Word) => c.id !== w.id && label(c) !== answer;
  const cands = shuffle([...state.pool, ...state.decoys].filter(usable));

  // 穴埋めでは**品詞をそろえる**。名詞の空所に動詞が並ぶと、
  // 意味を知らなくても消去法で当たってしまう。
  //
  // ただし品詞は偏っている。ターゲット1900は動詞760・名詞722・形容詞405に対し、
  // 副詞9・前置詞3・接続詞1しかない。接続詞の問題で同じ品詞のダミーは作れないので、
  // 足りなければ品詞の条件を外して埋める。該当は1900語中13語（0.7%）。
  const sameP = cloze && w.pos ? cands.filter((c) => c.pos === w.pos) : cands;

  // このテストでまだ使っていない語を先に配る。使い切ったら再利用に落ちる。
  const fresh = sameP.filter((c) => !state.usedDecoys.has(c.id));

  const picked: Word[] = [];
  const seen = new Set([answer]);
  for (const c of [...fresh, ...sameP, ...cands]) {
    if (picked.length >= 3) break;
    if (picked.includes(c)) continue;
    const l = label(c);
    if (seen.has(l)) continue; // ダミー同士が同じ文言になるのも避ける
    seen.add(l);
    picked.push(c);
  }
  picked.forEach((c) => state.usedDecoys.add(c.id));
  const choices = shuffle([w, ...picked]);

  const labels = choices.map(label);
  const opts = document.getElementById('vOpts')!;
  opts.innerHTML = choices
    .map(
      (c, i) =>
        `<button class="v-opt" data-id="${c.id}"><span class="k">${i + 1}</span><span>${esc(
          labels[i],
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

/**
 * 例文の空所を正解の語で埋めて返す。復習で読ませるのはこの形。
 *
 * 空所の直後の空白は落とす。元データは `___ , not just physical.` のように
 * 下線と句読点が詰まらないよう空白を入れてあるが、語を入れると
 * `physical , not` と句読点の前が空いてしまう。
 */
function filledHtml(w: Word): string {
  return esc(w.example ?? '')
    .replace('___', `<b class="v-fill">${esc(w.en)}</b>`)
    .replace(/<\/b> ([,.;:?!])/, '</b>$1');
}

/**
 * 結果の「できなかった／できた」をタブで切り替える。文法テストと同じ作り。
 *
 * 縦に積むと下のリストがスクロールの奥に沈む。そのうえ `.v-list ul` には
 * `max-height` の**入れ子スクロール**があり、「全部見えていない」と感じさせていた。
 * タブなら中を全部出せる。**既定はできなかった方**（見るべきはそちら）。
 *
 * 両方のパネルをDOMに置いて class を切り替えるだけなので、押しても再描画しない。
 * スタイルは `test-style.ts` の `.v-tabs` / `.v-pane`（文法と共有）。
 */
function resultTabs(ng: LogEntry[], ok: LogEntry[]): string {
  if (!ng.length && !ok.length) return '';
  // 穴埋めのときは例文まで出す。単語と訳だけ並べても、
  // どの文でどう使えなかったのかが分からず復習にならない。
  const withEx = cfg.fmt === 'cloze';
  const first = ng.length ? 'ng' : 'ok';
  const tab = (p: 'ng' | 'ok', label: string, n: number) =>
    n
      ? `<button data-p="${p}" class="${first === p ? 'on' : ''}">${label}<i>${n}</i></button>`
      : '';
  const item = (w: LogEntry) =>
    `<li><span class="n">${no3(w.no)}</span><span class="e">${esc(w.en)}${
      w.to ? ' <span class="t">時間切れ</span>' : ''
    }</span><span class="j">${esc(w.ja)}</span>${
      withEx && w.example
        ? `<div class="v-ex"><p>${filledHtml(w)}</p><p class="ja">${esc(w.example_ja ?? '')}</p></div>`
        : ''
    }</li>`;
  const pane = (p: 'ng' | 'ok', arr: LogEntry[]) =>
    arr.length
      ? `<div class="v-pane${first === p ? ' on' : ''}" data-p="${p}"><div class="v-list${
          withEx ? ' ex' : ''
        }"><ul>${arr
          .slice()
          .sort((a, b) => a.no - b.no)
          .map(item)
          .join('')}</ul></div></div>`
      : '';
  return (
    `<div class="v-tabs" id="vTabs">${tab('ng', 'できなかった', ng.length)}${tab(
      'ok',
      'できた',
      ok.length,
    )}</div>` +
    pane('ng', ng) +
    pane('ok', ok)
  );
}

function bindResultTabs(): void {
  const tabs = document.getElementById('vTabs');
  if (!tabs) return;
  tabs.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-p]');
    if (!b) return;
    tabs.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    document
      .querySelectorAll<HTMLElement>('.v-pane')
      .forEach((x) => x.classList.toggle('on', x.dataset.p === b.dataset.p));
  };
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
${resultTabs(ng, ok)}
<button class="v-ghost" id="vHome">ホームに戻る</button>`;
    app().innerHTML = shell('', '実力テスト', body0, '', 'home');
    bindNav();
    bindResultTabs();
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
${resultTabs(ng, ok)}
${ng.length ? '<p class="v-hint" style="margin:0 0 8px">できなかった単語は復習が必要に入りました。</p>' : ''}
<p class="v-hint" style="margin:0 0 8px">コピーは単語帳の番号順に並びます。</p>
<div class="v-cp">
  <button id="vCp1">できなかった単語</button>
  <button id="vCp2">できた単語</button>
  <button id="vCp3">結果を全部</button>
</div>
${ng.length ? '<button class="v-go" id="vAgain">できなかった単語を復習する</button>' : ''}
<button class="v-ghost" id="vHome">ホームに戻る</button>`;

  app().innerHTML = shell('', '', body, '', 'test');
  bindNav();
  bindResultTabs();
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
      cloze: number | null;
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
  const dirLabel = (d: string) => dirName(d);

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
      ${fRow(dirName('ej'), rec.formats.ej)}
      ${fRow(dirName('je'), rec.formats.je)}
      ${fRow('4択', rec.formats.choice)}
      ${fRow('例文穴埋め', rec.formats.cloze)}
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

/**
 * @param subject 'en'（英単語テスト）か 'kobun'（古文単語テスト）。
 *   入り口ごとに別のテストとして開く。`MODE` のコメントを読むこと。
 */
export async function initVocab(subject = 'en'): Promise<void> {
  MODE.subject = subject;
  injectStyles();
  await showHome();
}
