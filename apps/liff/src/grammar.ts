/**
 * LIFF 文法テスト（受講生専用）
 *
 * URL: https://liff.line.me/{LIFF_ID}?page=grammar
 *
 * 単語テスト（`vocab.ts`）の兄弟。ホーム → 分野 → 単元 → 出題 → 結果 → 記録。
 * 見た目は `test-style.ts` を共有している。次の3つが単語テストとの違い。
 *
 *   1. **出題の単位は単元。** 「No.301〜400をやる」ではなく「関係代名詞 what をやる」。
 *      分野（21）は入口で、実際に選ぶのは単元（140）
 *   2. **選択肢は問題に書いてある。** ダミーを他の問題から作らない。
 *      そのぶん「どの誤答を選んだか」を送る（chosen＝シャッフル前の添字）
 *   3. **解説をその場で出す。** 文法は「なぜそうなるか」が本体なので、
 *      答えたあと解説を読んで「次へ」を押す。ただし**総復習テストだけは出さない**
 *      （テンポを保つため。解説は結果画面でまとめて読む）
 *
 * テストは3種類。名前を混ぜないこと。
 *     単元テスト   … 単元（または分野まるごと）を選んで解く（kind='normal'）
 *     復習テスト   … 直近で間違えた問題だけ（kind='review'）
 *     総合演習     … 分野をまたいで通しで解く練習（kind='mixed'）
 *     総復習テスト … 最後に正解してから古い問題を引き直す（kind='checkup'）
 *
 * ★ 総復習テストは**実力を測っていない。仕事は「忘れの検出」1点。**
 *   習得率は「最後に解いたときに正解だったか」で時間経過を見ないので、
 *   3ヶ月前に正解したきりの問題も習得済みのまま残る。その穴だけを埋める。
 *   画面の文言で「実力」と書かないこと（`lms/grammar/01-categories.md`）。
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
import { CAT_PNG_BASE64 } from './vocab-cat.js';

const API_URL = import.meta.env?.VITE_API_URL || 'http://localhost:8787';

// ── 型 ──────────────────────────────────────────────────────────────────────

interface Question {
  id: number;
  no: number;
  category: string;
  sub_category?: string | null;
  prompt: string;
  choices: string[];
  answer: number;
  explanation?: string | null;
  level?: string | null;
}

interface BookCategory {
  name: string;
  count: number;
  from: number;
  to: number;
}

interface Book {
  id: number;
  slug: string;
  name: string;
  count: number;
  max_no: number;
  categories: BookCategory[];
}

interface CategoryMastery {
  name: string;
  from: number;
  to: number;
  total: number;
  mastered: number;
  unmastered: number;
  untried: number;
  rate: number;
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
  categories: CategoryMastery[];
  checkups: { at: string; total: number; correct: number; score: number }[];
  checkup_score: { score: number; correct: number; total: number; sessions: number } | null;
}

interface Dashboard {
  /** null なら未選択。問題集の選択画面から始める。 */
  selected_book_id: number | null;
  books: DashboardBook[];
  recent: {
    enough: boolean;
    needed: number;
    latest_rate: number | null;
    sessions: { at: string; rate: number; kind: string; total: number; correct: number }[];
  };
  weak_questions: WeakQuestion[];
  totals: { answers: number; sessions: number; days: number };
}

interface UnitMastery {
  category: string;
  name: string;
  total: number;
  mastered: number;
  unmastered: number;
  untried: number;
  rate: number;
}

/** よく間違えている単元。`asked` と `questions` の差が「繰り返し解いた度合い」。 */
interface UnitStat {
  category: string;
  name: string;
  asked: number;
  wrong: number;
  rate: number;
  questions: number;
  total: number;
  mastered: number;
}

interface WeakQuestion {
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

interface LogEntry extends Question {
  ok: boolean;
  /** 選んだ選択肢の**シャッフル前**の添字。時間切れは null。 */
  chosen: number | null;
  to: boolean;
  ms: number | null;
}

type Kind = 'normal' | 'review' | 'retry' | 'checkup' | 'mixed';

// ── 状態 ────────────────────────────────────────────────────────────────────

/** 1回のテストで出せる上限。サーバーの MAX_QUESTIONS_PER_REQUEST と揃えること。 */
const MAX_QUESTIONS = 100;
/**
 * 総復習テストの制限時間（秒）。
 *
 * 単語（5秒）より長い。文法問題は英文を読む時間が要るので、5秒だと
 * 「知っているか」ではなく「読むのが速いか」を測ってしまう。
 */
const CHECKUP_TIMER = 20;
/**
 * 総復習テストを主導線に出すのに必要な習得済み問題数。
 *
 * このテストの仕事は「前にできた問題を忘れていないか」なので、
 * **まだ何も仕上げていない生徒に見せても意味がない。** それまでは分野テストが主。
 */
const CHECKUP_MIN_MASTERED = 20;

const cfg = {
  bookId: 0,
  category: null as string | null,
  subCategory: null as string | null,
  lim: 10,
  /** 既定はランダム。番号順だと毎回おなじ並びで、順番で覚えてしまう。 */
  ord: 'rnd' as 'seq' | 'rnd',
  tmr: 0,
  checkupSize: 20,
  mixedSize: 20,
};

const state = {
  books: [] as Book[],
  dashboard: null as Dashboard | null,
  queue: [] as Question[],
  /** 出題中の問題の選択肢の並び。中身は**シャッフル前の添字**。 */
  order: [] as number[],
  idx: 0,
  log: [] as LogEntry[],
  kind: 'normal' as Kind,
  category: null as string | null,
  subCategory: null as string | null,
  /** 単元一覧を開いている分野。null ならまだ分野一覧。 */
  openCategory: null as string | null,
  units: [] as UnitMastery[],
  startedAt: '',
  qShownAt: 0,
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
    category_mastery: { before: number; after: number; mastered: number; total: number } | null;
  } | null,
};

// ── 小物 ────────────────────────────────────────────────────────────────────

function app(): HTMLElement {
  return document.getElementById('app')!;
}

function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
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

/** 次の共通テストまでの日数。「1月13日以降の最初の土曜日」に実施される。 */
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

/**
 * 問題文の整形。
 *
 * 講師が書く記法は2つだけ。
 *   `( )` … 空所。下線つきの空欄として描く
 *   `[…]` … 下線部。設問が指している箇所を目立たせる
 *
 * **必ず esc() を通したあとに置換すること。** 先に置換するとタグが壊れる。
 */
function renderPrompt(raw: string): string {
  return esc(raw)
    .replace(/\(\s*\)/g, '<span class="g-blank"></span>')
    .replace(/\[([^\]]+)\]/g, '<span class="g-uline">$1</span>');
}

// ── スタイル ────────────────────────────────────────────────────────────────

/**
 * 共通スタイル（`test-style.ts`）＋文法テストのぶん。
 *
 * 足しているのは3つだけ。**共通側の色や余白をここで上書きしないこと**
 * （単語テストと見た目がずれると、生徒には壊れて見える）。
 *   - 問題文（英文なので単語の 26px だと2〜3行になって読みにくい）
 *   - 選択肢と解説（文法は「なぜ」が本体なので解説に場所を取る）
 *   - 分野のチップ
 */
function injectStyles(): void {
  injectTestStyles('grammar-styles');
  if (document.getElementById('grammar-extra')) return;
  const el = document.createElement('style');
  el.id = 'grammar-extra';
  el.textContent = `
/* ── 出題（文法） ── */
/* 単語は1語なので中央寄せで大きく出せるが、英文は左寄せでないと読めない */
.g-stage{text-align:left}
.g-cat{font-family:"JetBrains Mono",monospace;font-size:10.5px;letter-spacing:.16em;
  color:var(--fg3);font-weight:500;margin-bottom:12px;display:flex;gap:10px;flex-wrap:wrap}
.g-cat b{font-style:normal;font-weight:700;color:var(--lime);letter-spacing:.06em}
.g-q{font-size:19px;font-weight:600;line-height:1.75;letter-spacing:-.01em;word-break:normal;
  overflow-wrap:anywhere}
.g-blank{display:inline-block;min-width:74px;border-bottom:2px solid var(--lime);
  margin:0 4px;vertical-align:-2px}
.g-uline{border-bottom:2px solid var(--accent);padding-bottom:1px}
/* 解説。正解でも出す（合っていた理由が違うことがあるため） */
.g-exp{margin-top:18px;padding:14px;border-radius:10px;border:1px solid var(--line2);
  background:var(--surface2);font-size:14px;line-height:1.85;color:var(--fg2);text-align:left}
.g-exp b{display:block;font-family:"JetBrains Mono",monospace;font-size:10px;letter-spacing:.18em;
  color:var(--fg3);font-weight:500;margin-bottom:7px}
.g-exp .ans{color:var(--lime);font-weight:700}
.g-exp.none{color:var(--fg3);font-size:13px}

/* ── 分野の一覧 ── */
/* 分野カード（.g-sec）と単元カード（.g-sec2）の両方に効かせる。
   以前は .g-sec だけを指していて、単元カードのタイトルが素の 400 に落ちていた。 */
.v-sec .nm{font-size:16.5px;font-weight:800;letter-spacing:-.02em;line-height:1.4}

/* ── 結果の問題リスト ── */
.v-list li.g-li{display:block;padding:12px 15px}
.g-li .hd{display:flex;align-items:baseline;gap:8px;margin-bottom:5px}
.g-li .hd .n{font-family:"JetBrains Mono",monospace;font-size:10.5px;color:var(--fg3)}
.g-li .hd .c{font-size:10.5px;color:var(--fg3);border:1px solid var(--line2);
  padding:1px 7px;border-radius:99px}
.g-li .hd .t{font-family:"JetBrains Mono",monospace;font-size:10px;color:var(--ng);margin-left:auto}
.g-li .q{font-size:14.5px;line-height:1.7;font-weight:500}
.g-li .a{font-size:13px;color:var(--fg2);margin-top:5px;line-height:1.7}
.g-li .a i{font-style:normal;color:var(--lime);font-weight:700}
.g-li .a u{text-decoration:none;color:var(--ng)}
.g-li .x{font-size:12.5px;color:var(--fg3);margin-top:6px;line-height:1.75}
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
  <span class="ttl">文法テスト</span>
  <span class="rng">${esc(sub)}</span>
  ${count ? `<span class="cnt">${esc(count)}</span>` : ''}
</div>
<div class="v-bar"><i id="gProg"></i></div>
<div class="v-wrap"${tab ? '' : ' style="padding-bottom:40px"'}>${
    title ? `<h1>${esc(title)}</h1>` : ''
  }${body}</div>
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
      (retry ? '<button class="v-ghost" id="gRetry">もう一度読み込む</button>' : ''),
  );
  const r = document.getElementById('gRetry');
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
  const d = points
    .map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.rate).toFixed(1)}`)
    .join(' ');
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
 * 総復習テストの結果カード。
 *
 * **「実力」と書かない。** ここに出る数字は「一度できた問題を、時間をおいて
 * まだ解けるか」であって、入試で何点取れるかではない。
 */
function checkupCard(b: DashboardBook): string {
  const cs = b.checkups || [];
  const pooled = b.checkup_score;
  const latest = cs.length ? cs[cs.length - 1] : null;
  const spark =
    cs.length >= 2 ? sparkline(cs.map((c) => ({ rate: c.score, at: c.at, kind: 'normal' }))) : '';

  if (!pooled || !latest) {
    return `
<div class="v-score-card">
  <div class="hd"><em>総復習テスト</em></div>
  <p class="none">一度できた問題を、しばらく経ってから解き直します。<br>
     <b>忘れていないか</b>を確かめるためのテストです。</p>
</div>`;
  }
  return `
<div class="v-score-card">
  <div class="hd"><em>総復習テスト</em><span>${esc(fmtDate(latest.at).slice(0, 5))}</span></div>
  <div class="val">
    <b>${Math.round(pooled.score * 100)}<i>%</i></b>
    <u>直近${pooled.sessions}回・${pooled.total}問から算出<br>
       最新は ${Math.round(latest.score * 100)}%（${latest.correct}/${latest.total}）</u>
  </div>
  ${spark}
  <p class="v-note">前にできた問題をいま解き直した正答率です。<b>入試の点数の予想ではありません。</b></p>
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

// ── 問題集の選択 ────────────────────────────────────────────────────────────

function renderBookPicker(canCancel: boolean): void {
  const body = `
<p class="v-sub">使っている問題集を選んでください。あとから切り替えられます。</p>
${state.books
  .map(
    (b) =>
      `<button class="v-pick${b.id === cfg.bookId ? ' on' : ''}" data-book="${b.id}">
         <b>${esc(b.name)}</b><em>${b.count} 問 ／ ${b.categories.length} 分野</em>
       </button>`,
  )
  .join('')}
${canCancel ? '<button class="v-ghost" id="gCancel">やめる</button>' : ''}`;

  app().innerHTML = shell('問題集を選ぶ', '', body, '', 'home');
  bindNav();

  document.querySelectorAll<HTMLElement>('.v-pick').forEach((el) => {
    el.onclick = async () => {
      if (state.switchingBook) return;
      state.switchingBook = true;
      const bookId = Number(el.dataset.book);
      try {
        await api('/api/grammar/book', {
          method: 'PUT',
          body: JSON.stringify({ book_id: bookId }),
        });
        cfg.bookId = bookId;
        cfg.category = null;
        state.dashboard = null;
        await showHome();
      } catch (e) {
        renderError(e instanceof Error ? e.message : '保存に失敗しました');
      } finally {
        state.switchingBook = false;
      }
    };
  });
  const cancel = document.getElementById('gCancel');
  if (cancel) cancel.onclick = () => void showHome();
}

// ── ホーム ──────────────────────────────────────────────────────────────────

async function showHome(): Promise<void> {
  renderLoading();
  try {
    const [booksRes, dash] = await Promise.all([
      api<{ books: Book[] }>('/api/grammar/books'),
      api<Dashboard>('/api/grammar/dashboard'),
    ]);
    state.books = booksRes.books;
    state.dashboard = dash;
  } catch (e) {
    renderError(e instanceof Error ? e.message : '読み込みに失敗しました');
    return;
  }

  const d = state.dashboard!;
  if (!state.books.length) {
    app().innerHTML = shell('', '', '<p class="v-empty">問題集がまだ登録されていません。</p>');
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
    cfg.category = null;
  }

  const book = d.books.find((b) => b.id === cfg.bookId);
  if (!book) {
    renderBookPicker(false);
    return;
  }

  const hasHistory = d.totals.sessions > 0;

  // ホームの主導線は実力テスト。復習はその下の補助ボタン。
  const reviewBlock = book.unmastered
    ? `<button class="v-ghost" id="gReview">復習テストを受ける（${Math.min(book.unmastered, 20)}問）</button>`
    : hasHistory
      ? '<p class="v-note" style="text-align:center">復習が必要な問題はまだありません。</p>'
      : '';

  // 総復習テストは「前にできた問題を忘れていないか」を見るもの。
  // まだ何も仕上げていないうちに主導線に置いても解くものが無いので、
  // 習得済みが溜まるまでは単元テストを主にする。
  const ready = book.mastered >= CHECKUP_MIN_MASTERED;

  const sizeChips = `<div class="v-row" style="justify-content:center;margin-top:10px">${[20, 30, 50]
    .map(
      (n) =>
        `<button class="v-chip${cfg.checkupSize === n ? ' on' : ''}" data-size="${n}">${n}問</button>`,
    )
    .join('')}</div>`;

  // 総合演習。分野を決めずに通しで解く練習。総復習テストと違って抽出に細工をしない。
  const mixedBlock =
    '<button class="v-ghost" id="gMixed">総合演習（分野をまたいで解く）</button>' +
    `<div class="v-row" style="justify-content:center;margin-top:8px">${[20, 30, 50]
      .map(
        (n) =>
          `<button class="v-chip${cfg.mixedSize === n ? ' on' : ''}" data-msize="${n}">${n}問</button>`,
      )
      .join('')}</div>`;

  // 分岐は2つだけにする。以前は3分岐で、初回の枝にだけ総合演習と復習を足し忘れていた。
  // 枝ごとにボタンを並べ直す作りが原因なので、共通部分は1か所にまとめる。
  const mainActions =
    '<button class="v-ghost" id="gStart">単元を選んで解く</button>' + mixedBlock + reviewBlock;

  const body = ready
    ? catBar() +
      checkupCard(book) +
      '<button class="v-go" id="gCheckup">総復習テストを受ける</button>' +
      sizeChips +
      mainActions +
      '<button class="v-switch" id="gSwitch">問題集を切り替える</button>'
    : catBar() +
      `<div class="v-lead">
         <div class="cap">${esc(book.name)}</div>
         <div class="n" style="font-size:20px;font-family:inherit;font-weight:700">${
           hasHistory ? `習得 ${book.mastered} 問` : 'まずは1単元やってみましょう'
         }</div>
       </div>` +
      mainActions +
      `<p class="v-note" style="text-align:center">
         あと ${CHECKUP_MIN_MASTERED - book.mastered} 問で総復習テストが受けられます。
         一度できた問題を忘れていないか確かめるテストなので、まず解き進めてください。
       </p>
       <button class="v-switch" id="gSwitch">問題集を切り替える</button>`;

  app().innerHTML = shell('', book.name, body);
  bindNav();

  const bind = (id: string, fn: () => void) => {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  };
  bind('gStart', () => renderSetup());
  bind('gCheckup', () => void startCheckup());
  document.querySelectorAll<HTMLElement>('[data-size]').forEach((el) => {
    el.onclick = () => {
      cfg.checkupSize = Number(el.dataset.size);
      document
        .querySelectorAll<HTMLElement>('[data-size]')
        .forEach((x) => x.classList.toggle('on', Number(x.dataset.size) === cfg.checkupSize));
    };
  });
  bind('gMixed', () => void startMixed());
  document.querySelectorAll<HTMLElement>('[data-msize]').forEach((el) => {
    el.onclick = () => {
      cfg.mixedSize = Number(el.dataset.msize);
      document
        .querySelectorAll<HTMLElement>('[data-msize]')
        .forEach((x) => x.classList.toggle('on', Number(x.dataset.msize) === cfg.mixedSize));
    };
  });
  bind('gReview', () => void startReview());
  bind('gSwitch', () => renderBookPicker(true));
}

// ── 分野の一覧（テストタブ） ────────────────────────────────────────────────

/** 分野の一覧。定着率つきで、押すとその分野のテストが始まる。 */
function renderSetup(): void {
  const book = state.books.find((b) => b.id === cfg.bookId);
  const dash = state.dashboard?.books.find((b) => b.id === cfg.bookId);
  if (!book) return;

  // 定着率はダッシュボード側にしか無いので、まだ解いていない分野は問題集から補う。
  const byName = new Map((dash?.categories ?? []).map((c) => [c.name, c]));
  const cats = book.categories.map((c) => {
    const m = byName.get(c.name);
    return (
      m ?? {
        name: c.name,
        from: c.from,
        to: c.to,
        total: c.count,
        mastered: 0,
        unmastered: 0,
        untried: c.count,
        rate: 0,
      }
    );
  });

  const sections = cats
    .map((c) => {
      const w1 = c.total ? (c.mastered / c.total) * 100 : 0;
      const w2 = c.total ? (c.unmastered / c.total) * 100 : 0;
      return `
<button class="v-sec g-sec" data-cat="${esc(c.name)}">
  <span class="r1">
    <span class="nm">${esc(c.name)}</span>
    <span class="pc${c.rate ? '' : ' zero'}">${pct(c.rate)}</span>
  </span>
  <span class="tr"><i style="width:${w1.toFixed(1)}%"></i><u style="width:${w2.toFixed(1)}%"></u></span>
  <span class="sub">全${c.total}問　習得 ${c.mastered} ／ 復習 ${c.unmastered} ／ 未挑戦 ${c.untried}</span>
</button>`;
    })
    .join('');

  const chip = (group: string, v: string, label: string, on: boolean) =>
    `<button class="v-chip${on ? ' on' : ''}" data-g="${group}" data-v="${v}">${esc(label)}</button>`;

  const body = `
<p class="v-sub">分野を選ぶと、中の単元が開きます。${cfg.lim}問・4択・解説つき。</p>
${sections || '<p class="v-empty">分野がありません。</p>'}

<details class="v-adv">
  <summary>問題数や制限時間を決める</summary>
  <div>
    <p class="v-hint" style="margin:4px 0 6px">出題数</p>
    <div class="v-row">
      ${[5, 10, 20, 30, 50].map((n) => chip('lim', String(n), `${n}問`, cfg.lim === n)).join('')}
    </div>

    <p class="v-hint" style="margin:16px 0 6px">並び順</p>
    <div class="v-row">
      ${chip('ord', 'seq', '番号順', cfg.ord === 'seq')}
      ${chip('ord', 'rnd', 'ランダム', cfg.ord === 'rnd')}
    </div>

    <p class="v-hint" style="margin:16px 0 6px">制限時間</p>
    <div class="v-row">
      ${[0, 15, 20, 30, 60]
        .map((n) => chip('tmr', String(n), n ? `${n}秒` : 'なし', cfg.tmr === n))
        .join('')}
    </div>
    <p class="v-hint" style="margin:8px 0 0">
      制限時間は既定で「なし」です。文法問題は英文を読む時間が要るので、
      短くすると「知っているか」ではなく「読むのが速いか」を測ることになります。
    </p>
  </div>
</details>
<p class="v-err v-hide" id="gMsg"></p>`;

  app().innerHTML = shell('分野テスト', book.name, body, '', 'test');
  bindNav();

  document.querySelectorAll<HTMLElement>('.g-sec').forEach((el) => {
    el.onclick = () => {
      void showUnits(el.dataset.cat ?? '');
    };
  });

  document.querySelectorAll<HTMLElement>('.v-chip[data-g]').forEach((b) => {
    b.onclick = () => {
      const g = b.dataset.g!;
      document
        .querySelectorAll<HTMLElement>(`.v-chip[data-g="${g}"]`)
        .forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      if (g === 'tmr') cfg.tmr = Number(b.dataset.v);
      else if (g === 'ord') cfg.ord = b.dataset.v as 'seq' | 'rnd';
      else if (g === 'lim') cfg.lim = Math.min(Number(b.dataset.v), MAX_QUESTIONS);
    };
  });
}

/**
 * 単元一覧。分野をタップすると開く。
 *
 * ここが**実際の出題の入口**。分野（21）は粗すぎて「関係詞が弱い」までしか言えないので、
 * 選ぶのも定着率を見るのも単元（140）でやる。
 *
 * 単元が設定されていない問題集（`sub_category` が空）では単元一覧を出さず、
 * 分野まるごとで始める。古い問題集でも動くようにしておく。
 */
async function showUnits(category: string): Promise<void> {
  if (!category) return;
  state.openCategory = category;
  renderLoading();

  try {
    const res = await api<{ units: UnitMastery[] }>(
      `/api/grammar/units?book_id=${cfg.bookId}&category=${encodeURIComponent(category)}`,
    );
    state.units = res.units.filter((u) => u.name);
  } catch (e) {
    renderError(e instanceof Error ? e.message : '読み込みに失敗しました');
    return;
  }

  // 単元が無い問題集はそのまま分野まるごとで始める（1画面ぶん無駄に挟まない）
  if (!state.units.length) {
    cfg.category = category;
    cfg.subCategory = null;
    void startNormal();
    return;
  }

  const rows = state.units
    .map((u) => {
      const w1 = u.total ? (u.mastered / u.total) * 100 : 0;
      const w2 = u.total ? (u.unmastered / u.total) * 100 : 0;
      return `
<button class="v-sec g-sec2" data-unit="${esc(u.name)}">
  <span class="r1">
    <span class="nm">${esc(u.name)}</span>
    <span class="pc${u.rate ? '' : ' zero'}">${pct(u.rate)}</span>
  </span>
  <span class="tr"><i style="width:${w1.toFixed(1)}%"></i><u style="width:${w2.toFixed(1)}%"></u></span>
  <span class="sub">全${u.total}問　習得 ${u.mastered} ／ 復習 ${u.unmastered} ／ 未挑戦 ${u.untried}</span>
</button>`;
    })
    .join('');

  const totals = state.units.reduce(
    (a, u) => ({ total: a.total + u.total, mastered: a.mastered + u.mastered }),
    { total: 0, mastered: 0 },
  );

  const body = `
<button class="v-switch" id="gBack" style="margin-bottom:12px">← 分野一覧にもどる</button>
<p class="v-sub">${esc(category)}　全${totals.total}問中 ${totals.mastered}問が習得済み。<br>
   単元を選ぶとテストが始まります。</p>
${rows}
<button class="v-ghost" id="gWhole">この分野をまるごと（${cfg.lim}問）</button>
<p class="v-err v-hide" id="gMsg"></p>`;

  app().innerHTML = shell('単元を選ぶ', esc(category), body, '', 'test');
  bindNav();

  document.getElementById('gBack')!.onclick = () => {
    state.openCategory = null;
    renderSetup();
  };
  document.getElementById('gWhole')!.onclick = () => {
    cfg.category = category;
    cfg.subCategory = null;
    void startNormal();
  };
  document.querySelectorAll<HTMLElement>('.g-sec2').forEach((el) => {
    el.onclick = () => {
      cfg.category = category;
      cfg.subCategory = el.dataset.unit ?? null;
      void startNormal();
    };
  });
}

function say(msg: string): void {
  const el = document.getElementById('gMsg');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('v-hide', !msg);
}

// ── テストの開始 ────────────────────────────────────────────────────────────

async function startNormal(): Promise<void> {
  say('');
  const back = () => {
    // 失敗したら来た画面に戻す。単元から来たなら単元一覧、分野からなら分野一覧。
    if (state.openCategory) void showUnits(state.openCategory);
    else renderSetup();
  };
  renderLoading();
  try {
    const sub = cfg.subCategory
      ? `&sub_category=${encodeURIComponent(cfg.subCategory)}`
      : '';
    const res = await api<{ questions: Question[] }>(
      `/api/grammar/questions?book_id=${cfg.bookId}&category=${encodeURIComponent(
        cfg.category ?? '',
      )}${sub}&limit=${cfg.lim}`,
    );
    if (!res.questions.length) {
      back();
      say(cfg.subCategory ? 'その単元に問題がありません。' : 'その分野に問題がありません。');
      return;
    }
    begin(res.questions, 'normal', cfg.category, cfg.subCategory);
  } catch (e) {
    back();
    say(e instanceof Error ? e.message : '読み込みに失敗しました');
  }
}

/**
 * 総復習テスト。**最後に正解してから古い問題**をサーバーが優先して返す。
 * 実力ではなく「忘れていないか」を見るテスト。
 */
async function startCheckup(size = cfg.checkupSize): Promise<void> {
  renderLoading();
  try {
    cfg.checkupSize = size;
    const res = await api<{ questions: Question[] }>(
      `/api/grammar/checkup?book_id=${cfg.bookId}&size=${size}`,
    );
    if (!res.questions.length) {
      await showHome();
      return;
    }
    // 条件を毎回そろえないと回をまたいで比べられない。制限時間を固定する。
    cfg.tmr = CHECKUP_TIMER;
    begin(res.questions, 'checkup', null, null);
  } catch (e) {
    renderError(e instanceof Error ? e.message : '読み込みに失敗しました');
  }
}

/**
 * 総合演習。分野をまたいで通しで解く練習。
 *
 * 総復習テスト（checkup）は「最後に正解してから古い順」に偏らせてあるので、
 * 練習として通しで解くには向かない。こちらは素のランダムで、制限時間も付けない。
 * 解説はその場で出す（測定ではなく練習なので）。
 */
async function startMixed(size = cfg.mixedSize): Promise<void> {
  renderLoading();
  try {
    cfg.mixedSize = size;
    const res = await api<{ questions: Question[] }>(
      `/api/grammar/mixed?book_id=${cfg.bookId}&size=${size}`,
    );
    if (!res.questions.length) {
      await showHome();
      return;
    }
    cfg.tmr = 0;
    begin(res.questions, 'mixed', null, null);
  } catch (e) {
    renderError(e instanceof Error ? e.message : '読み込みに失敗しました');
  }
}

async function startReview(): Promise<void> {
  renderLoading();
  try {
    const res = await api<{ questions: Question[] }>(
      `/api/grammar/review?book_id=${cfg.bookId}&limit=20`,
    );
    if (!res.questions.length) {
      await showHome();
      return;
    }
    begin(res.questions, 'review', null, null);
  } catch (e) {
    renderError(e instanceof Error ? e.message : '読み込みに失敗しました');
  }
}

function begin(
  questions: Question[],
  kind: Kind,
  category: string | null,
  subCategory: string | null,
): void {
  let queue = questions.slice();
  if (cfg.ord === 'rnd' || kind === 'checkup') queue = shuffle(queue);
  else queue.sort((a, b) => a.no - b.no);

  state.queue = queue;
  state.idx = 0;
  state.log = [];
  state.kind = kind;
  state.category = category;
  state.subCategory = subCategory;
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
  const bar = document.getElementById('gTbar');
  const fill = document.getElementById('gTfill');
  const left = document.getElementById('gTleft');
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
  state.timedOut = true;
  // 未選択のまま締める。正解を見せてから次に進む導線は settle() が持つ。
  settle(null);
}

function renderQuestion(): void {
  const q = state.queue[state.idx];
  state.answered = false;

  // 選択肢は毎回シャッフルする。並びを覚えて「いつも3番」で当てられると測れない。
  // 中身は**シャッフル前の添字**。これをそのままサーバーに送る。
  state.order = shuffle(q.choices.map((_, i) => i));

  const body = `
<div class="v-stage g-stage">
  <div class="v-tbar${cfg.tmr ? '' : ' v-hide'}" id="gTbar"><i id="gTfill"></i><b id="gTleft"></b></div>
  <div class="g-cat">
    <span>NO. ${no3(q.no)}</span>
    <b>${esc(q.category)}</b>
    ${q.sub_category ? `<span>${esc(q.sub_category)}</span>` : ''}
  </div>
  <div class="g-q">${renderPrompt(q.prompt)}</div>
  <div class="v-opts" id="gOpts"></div>
  <div class="v-hide" id="gExp"></div>
</div>
<div class="v-acts" id="gActs"></div>
<button class="v-abort" id="gAbort">中断する（記録は残りません）</button>`;

  app().innerHTML = shell('', '', body, `${state.idx + 1} / ${state.queue.length}`, null);
  const prog = document.getElementById('gProg');
  if (prog) prog.style.width = `${(state.idx / state.queue.length) * 100}%`;

  document.getElementById('gAbort')!.onclick = () => {
    stopTimer();
    void showHome();
  };

  const opts = document.getElementById('gOpts')!;
  opts.innerHTML = state.order
    .map(
      (orig, i) =>
        `<button class="v-opt" data-orig="${orig}"><span class="k">${i + 1}</span><span>${esc(
          q.choices[orig],
        )}</span></button>`,
    )
    .join('');
  opts.querySelectorAll<HTMLButtonElement>('.v-opt').forEach((b) => {
    b.onclick = () => settle(Number(b.dataset.orig));
  });

  state.qShownAt = performance.now();
  startTimer();
}

/**
 * 解答を締める。`chosen` は**シャッフル前の添字**。時間切れは null。
 *
 * 締めたあとの流れが単語テストと違う。単語は色が変わったら自動で次へ進むが、
 * 文法は解説を読ませてから「次へ」を押させる。**ただし実力テストは自動で進む**
 * （条件を揃えて速さを測るため。解説は結果画面でまとめて読む）。
 */
function settle(chosen: number | null): void {
  if (state.answered) return;
  state.answered = true;
  stopTimer();
  document.getElementById('gTbar')?.classList.add('v-hide');

  const q = state.queue[state.idx];
  const ok = !state.timedOut && chosen === q.answer;

  document.querySelectorAll<HTMLButtonElement>('.v-opt').forEach((b) => {
    b.disabled = true;
    const orig = Number(b.dataset.orig);
    if (orig === q.answer) b.classList.add('ok');
    else if (chosen !== null && orig === chosen) b.classList.add('ng');
  });

  state.log.push({
    ...q,
    ok,
    chosen: state.timedOut ? null : chosen,
    to: state.timedOut,
    ms: Math.round(performance.now() - state.qShownAt),
  });

  const next = () => {
    state.idx++;
    if (state.idx >= state.queue.length) void finish();
    else renderQuestion();
  };

  if (state.kind === 'checkup') {
    setTimeout(next, ok ? 500 : 1200);
    return;
  }

  // 解説は正解でも出す。合っていても理由が違っていることがある。
  const exp = document.getElementById('gExp')!;
  exp.className = 'g-exp' + (q.explanation ? '' : ' g-exp none');
  exp.innerHTML = q.explanation
    ? `<b>かいせつ</b>正解は <span class="ans">${esc(q.choices[q.answer])}</span><br>${esc(
        q.explanation,
      ).replace(/\n/g, '<br>')}`
    : `<b>かいせつ</b>正解は <span class="ans">${esc(q.choices[q.answer])}</span>`;

  const acts = document.getElementById('gActs')!;
  const last = state.idx >= state.queue.length - 1;
  acts.innerHTML = `<button class="pri" id="gNext">${last ? '結果を見る' : '次の問題へ'}</button>`;
  document.getElementById('gNext')!.onclick = next;
  // 解説まで一気に読めるよう、押すところまでスクロールを送る
  exp.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
      category_mastery: { before: number; after: number; mastered: number; total: number } | null;
    }>('/api/grammar/sessions', {
      method: 'POST',
      body: JSON.stringify({
        // 再送しても二重に入らないよう、セッションごとに1つだけ発行する
        client_session_id: crypto.randomUUID(),
        book_id: cfg.bookId,
        kind: state.kind,
        category: state.category,
        sub_category: state.subCategory,
        range_from: null,
        range_to: null,
        order_mode: cfg.ord,
        timer_sec: cfg.tmr,
        started_at: state.startedAt,
        finished_at: jstNow(),
        answers: state.log.map((l) => ({
          question_id: l.id,
          ok: l.ok ? 1 : 0,
          chosen: l.chosen,
          timed_out: l.to ? 1 : 0,
          elapsed_ms: l.ms,
        })),
      }),
    });
    state.lastResult = res;
    // 定着率とスコアが変わったのでホームのキャッシュを捨てる
    state.dashboard = null;
  } catch {
    state.lastResult = null;
  } finally {
    state.sending = false;
  }
}

/** 結果の1問。間違えた問題は解説まで出す（ここが復習の本体）。 */
function resultItem(l: LogEntry, withExplanation: boolean): string {
  const chosenText = l.chosen !== null ? l.choices[l.chosen] : null;
  return `
<li class="g-li">
  <span class="hd">
    <span class="n">${no3(l.no)}</span>
    <span class="c">${esc(l.category)}</span>
    ${l.to ? '<span class="t">時間切れ</span>' : ''}
  </span>
  <span class="q">${renderPrompt(l.prompt)}</span>
  <span class="a">正解 <i>${esc(l.choices[l.answer])}</i>${
    chosenText !== null && !l.ok ? ` ／ あなた <u>${esc(chosenText)}</u>` : ''
  }</span>
  ${withExplanation && l.explanation ? `<span class="x">${esc(l.explanation).replace(/\n/g, '<br>')}</span>` : ''}
</li>`;
}

function listBlock(title: string, arr: LogEntry[], ok: boolean, withExplanation: boolean): string {
  if (!arr.length) return '';
  return `
<div class="v-list">
  <h3 class="${ok ? 'o' : ''}"><em>${esc(title)}</em><span>${arr.length} 問</span></h3>
  <ul>${arr
    .slice()
    .sort((a, b) => a.no - b.no)
    .map((l) => resultItem(l, withExplanation))
    .join('')}</ul>
</div>`;
}

function renderResult(sending: boolean): void {
  const ok = state.log.filter((x) => x.ok);
  const ng = state.log.filter((x) => !x.ok);
  const r = state.lastResult;

  // 間違えた問題は解説つき。できた問題は畳んでおく（正解の確認は短くていい）。
  const lists =
    listBlock('できなかった問題', ng, false, true) + listBlock('できた問題', ok, true, false);

  if (state.kind === 'checkup') {
    // 総復習テストは点数がすべて。単元の定着率の変化は出さない（測っているものが違う）。
    const pt = state.log.length ? Math.round((ok.length / state.log.length) * 100) : 0;
    const body0 = `
<div class="v-score-card">
  <div class="hd"><em>総復習テスト</em></div>
  <div class="val"><b>${pt}<i>%</i></b><u>${ok.length} / ${state.log.length} 問</u></div>
  <p class="v-note">しばらく解いていない問題を選んで出しています。
    ここで落とした問題は<b>忘れかけている</b>ということなので、復習テストに入りました。</p>
</div>
${lists}
${sending ? '<p class="v-hint">記録を保存しています...</p>' : ''}
<button class="v-ghost" id="gHome">ホームに戻る</button>`;
    app().innerHTML = shell('', '総復習テスト', body0, '', 'home');
    bindNav();
    document.getElementById('gHome')!.onclick = () => void showHome();
    return;
  }

  // 出すのは「いま解いた分野の定着率」だけ。問題集全体の進み具合は出さない。
  const delta =
    r && r.category_mastery
      ? `<div class="v-card">
           <span class="lg">${esc(state.subCategory || state.category || '')}の定着率</span>
           <div class="v-delta">${pct(r.category_mastery.before)} → <b>${pct(
             r.category_mastery.after,
           )}</b>
             <span style="color:var(--fg3)">（${r.category_mastery.mastered}/${
               r.category_mastery.total
             }問）</span></div>
         </div>`
      : sending
        ? '<p class="v-hint">記録を保存しています...</p>'
        : r
          ? ''
          : `<div class="v-err">記録の保存に失敗しました。<br>電波の良いところで「もう一度保存する」を押してください。</div>
             <button class="v-ghost" id="gResend">もう一度保存する</button>`;

  const body = `
<div class="v-score">
  <b>${ok.length}/${state.log.length}</b>
  <span>正答率 ${state.log.length ? pct(ok.length / state.log.length) : '—'}</span>
</div>
${delta}
${lists}
${ng.length ? '<button class="v-go" id="gAgain">できなかった問題だけ、もう一度</button>' : ''}
<button class="v-ghost" id="gHome">ホームに戻る</button>`;

  app().innerHTML = shell('', '', body, '', 'test');
  bindNav();
  const prog = document.getElementById('gProg');
  if (prog) prog.style.width = '100%';

  document.getElementById('gHome')!.onclick = () => void showHome();

  const resend = document.getElementById('gResend');
  if (resend) {
    resend.onclick = async () => {
      (resend as HTMLButtonElement).disabled = true;
      await sendSession();
      renderResult(false);
    };
  }

  const again = document.getElementById('gAgain');
  if (again) {
    again.onclick = () => {
      // 「もう一度」は最初のテストとは別のセッションとして記録する（集計からは外れる）。
      const questions: Question[] = ng.map((l) => ({
        id: l.id,
        no: l.no,
        category: l.category,
        sub_category: l.sub_category,
        prompt: l.prompt,
        choices: l.choices,
        answer: l.answer,
        explanation: l.explanation,
      }));
      begin(questions, 'retry', state.category, state.subCategory);
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
      category: string | null;
      sub_category: string | null;
      timer_sec: number;
      kind: string;
      total: number;
      correct: number;
    }[];
    weak_questions: WeakQuestion[];
    categories: { name: string; asked: number; correct: number; rate: number }[];
    units: UnitStat[];
    pace: { timeout_rate: number | null; median_ms: number | null };
  };
  try {
    rec = await api(`/api/grammar/records?book_id=${cfg.bookId}`);
    if (!state.dashboard) state.dashboard = await api<Dashboard>('/api/grammar/dashboard');
  } catch (e) {
    renderError(e instanceof Error ? e.message : '読み込みに失敗しました');
    return;
  }

  const kindLabel = (k: string) =>
    k === 'checkup' ? '総復習'
      : k === 'mixed' ? '総合演習'
      : k === 'review' ? '復習'
      : k === 'retry' ? 'もう一度'
      : '単元';

  const history = rec.sessions.length
    ? `<div class="v-card"><span class="lg">テスト履歴</span>
         <table class="v-hist">
           <thead><tr><th>日時</th><th>単元</th><th>種別</th><th>結果</th></tr></thead>
           <tbody>${rec.sessions
             .map(
               (s) => `<tr>
                 <td>${esc(fmtDate(s.finished_at))}</td>
                 <td>${esc(s.sub_category || s.category || '—')}</td>
                 <td>${kindLabel(s.kind)}${s.timer_sec ? ` ${s.timer_sec}秒` : ''}</td>
                 <td class="s">${s.correct}/${s.total}</td>
               </tr>`,
             )
             .join('')}</tbody>
         </table>
       </div>`
    : '';

  /**
   * よく間違えている単元。**記録タブの主役はこれ。**
   *
   * 総復習テストは全体を薄く引くので、そこから「この単元が弱い」は読めない。
   * 苦手は解答の蓄積から出す。復習テストが間違えた問題を繰り返し出すので、
   * 苦手な単元ほど自然に回数が貯まる。
   *
   * `延べ○回 / ○問` を必ず併記する。3問を1回ずつやった33%と、
   * 8問を延べ20回やった40%を同じ顔で並べないため。
   */
  const units = rec.units.length
    ? `<div class="v-card"><span class="lg">よく間違えている単元</span>
         ${rec.units
           .slice(0, 12)
           .map(
             (u) => `<div class="v-blk" style="align-items:flex-start">
               <span class="lb" style="width:auto;min-width:104px;flex:none">
                 ${esc(u.name)}<br><em style="font-style:normal;color:var(--fg3);font-size:9.5px">${esc(u.category)}</em>
               </span>
               <span class="tr" style="margin-top:5px"><i style="width:${(u.rate * 100).toFixed(1)}%"></i></span>
               <span class="vl" style="width:74px">${pct(u.rate)}<br>
                 <em style="font-style:normal;color:var(--fg3);font-size:9.5px">延べ${u.asked}回/${u.questions}問</em></span>
             </div>`,
           )
           .join('')}
         <p class="v-note">上ほど苦手です。延べ回数が少ないうちは数字がぶれます。
           同じ問題を何度か解いて回数が貯まるほど確かになります。</p>
       </div>`
    : '<div class="v-card"><span class="lg">よく間違えている単元</span>' +
      '<p class="v-hint" style="margin:0">まだ判定できません。単元テストを解くと出てきます。</p></div>';

  // サーバーは正答率の低い順・解答5問以上の分野だけ返す。薄いデータは描かせない。
  const categories = rec.categories.length
    ? `<div class="v-card"><span class="lg">苦手な分野</span>
         ${rec.categories
           .map(
             (c) => `<div class="v-blk">
               <span class="lb" style="width:auto;min-width:88px">${esc(c.name)}</span>
               <span class="tr"><i style="width:${(c.rate * 100).toFixed(1)}%"></i></span>
               <span class="vl">${pct(c.rate)}</span>
             </div>`,
           )
           .join('')}
         <p class="v-note">解答が5問以上ある分野だけ出しています。上ほど苦手です。</p>
       </div>`
    : '';

  const pace =
    rec.pace.timeout_rate !== null || rec.pace.median_ms !== null
      ? `<div class="v-card"><span class="lg">解く速さ</span>
           ${
             rec.pace.median_ms !== null
               ? `<div class="v-delta">正解までの中央値 <b>${(rec.pace.median_ms / 1000).toFixed(
                   1,
                 )}秒</b></div>`
               : ''
           }
           ${
             rec.pace.timeout_rate !== null
               ? `<p class="v-note">時間切れ率 ${pct(rec.pace.timeout_rate)}（制限時間ありの回のみ）</p>`
               : ''
           }
         </div>`
      : '';

  const weak = rec.weak_questions.length
    ? `<div class="v-list"><h3>くり返し間違えている問題<em>${rec.weak_questions.length}</em></h3>
         <ul>${rec.weak_questions
           .map(
             (w) => `<li class="g-li">
               <span class="hd"><span class="n">${no3(w.no)}</span>
                 <span class="c">${esc(w.category)}</span>
                 <span class="t">×${w.wrong}/${w.asked}</span></span>
               <span class="q">${renderPrompt(w.prompt)}</span>
               <span class="a">正解 <i>${esc(w.choices[w.answer] ?? '')}</i></span>
               ${w.explanation ? `<span class="x">${esc(w.explanation).replace(/\n/g, '<br>')}</span>` : ''}
             </li>`,
           )
           .join('')}</ul>
       </div>`
    : '';

  const d = state.dashboard;
  const trend =
    d && d.recent.enough
      ? `<div class="v-card">
           <span class="lg">単元テストの正答率</span>
           ${sparkline(d.recent.sessions)}
           <p class="v-note">直近 ${d.recent.sessions.length} 回　最新 ${
             d.recent.latest_rate === null ? '—' : pct(d.recent.latest_rate)
           }</p>
         </div>`
      : d
        ? `<div class="v-card"><span class="lg">単元テストの正答率</span>
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
    units +
    trend +
    categories +
    weak +
    pace +
    history +
    totals +
    '<button class="v-ghost" id="gHome">ホームに戻る</button>';

  app().innerHTML = shell('', 'テスト結果', body, '', 'records');
  bindNav();
  document.getElementById('gHome')!.onclick = () => void showHome();
}

// ── キーボード（画面共有で使うとき用） ──────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (!document.querySelector('.g-stage')) return;
  if (state.answered) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('gNext')?.click();
    }
    return;
  }
  const n = Number(e.key);
  if (n >= 1 && n <= 5) {
    const b = document.querySelectorAll<HTMLButtonElement>('.v-opt')[n - 1];
    if (b) b.click();
  }
});

// ── 入口 ────────────────────────────────────────────────────────────────────

export async function initGrammar(): Promise<void> {
  injectStyles();
  await showHome();
}
