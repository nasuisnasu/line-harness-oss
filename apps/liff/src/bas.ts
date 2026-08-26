/**
 * LIFF 並び替えテスト（Build a Sentence／受講生専用）
 *
 * URL: https://liff.line.me/{LIFF_ID}?page=bas
 *
 * 単語テスト（`vocab.ts`）・文法テスト（`grammar.ts`）の弟。
 * 見た目は `test-style.ts` を共有している。違いは3つ。
 *
 *   1. **選択肢が無い。** 語群をタップして順に置き、1文を組み立てる。
 *      したがって「どう間違えたか」が並びとしてそのまま残る
 *   2. **出題の単位はプール全体。** 「第N週の100問」を選ばせない。
 *      毎週100問足して池を深くしていくので、束の境目は生徒には見えなくてよい
 *   3. **弱点は型（A1〜G4）で見る。** 攻略ブックの記号がそのまま集計の軸になる。
 *      1問が型を複数持つので、大分類（A〜G）→型 の2階層で出す
 *
 * テストは3種類。名前を混ぜないこと。
 *     総合ランダム … プールからランダムに出す（kind='mixed'）
 *     弱点だけ復習 … 正答率の低い型を含む問題から、間違い直しを優先（kind='weak'）
 *     記号を指定   … 'E1 の問題だけ' を集中的に（kind='type'）
 *
 * ★ 採点はサーバーでやり直される。画面の正誤とサーバーの記録が食い違ったら
 *   サーバーが正。ここで出す正誤はあくまで即時フィードバック。
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

const API_URL = import.meta.env?.VITE_API_URL || 'http://localhost:8787';

/**
 * ビルドの目印。ホームの最下部に小さく出す。
 * LINE内ブラウザはHTMLを強くキャッシュするので「直したはずなのに変わらない」が起きる。
 * 中身を変えたらこの値も上げること。
 */
const BUILD = '2026-08-25a';

// ── 型 ──────────────────────────────────────────────────────────────────────

interface Question {
  id: number;
  no: number;
  lead: string;
  frame: string;
  blanks: number;
  words: string[];
  answer: string[];
  /** 意味が変わらない別解。ここに一致しても正解にする */
  accepted: string[][];
  extra: string | null;
  types: string[];
  steps: string[];
  sentence: string;
  ja: string;
}

interface TypeRow {
  code: string;
  group_code: string;
  group_name: string;
  name: string;
  hint: string | null;
  sort: number;
}

interface TypeStat extends TypeRow {
  total: number;
  tried: number;
  ok: number;
  rate: number;
}

interface GroupStat {
  code: string;
  name: string;
  total: number;
  tried: number;
  ok: number;
  rate: number;
  types: TypeStat[];
}

interface RecentSession {
  id: number;
  kind: string;
  focus_type: string | null;
  timer_sec: number;
  total: number;
  correct: number;
  finished_at: string;
}

interface Dashboard {
  pool: number;
  tried: number;
  sessions: number;
  answered: number;
  correct: number;
  rate: number;
  groups: GroupStat[];
  weak: TypeStat[];
  recent: RecentSession[];
}

type Kind = 'mixed' | 'weak' | 'type' | 'retry';

// ── 状態 ────────────────────────────────────────────────────────────────────

/** 設定。localStorage に残して次回も同じ条件で始められるようにする。 */
const cfg = {
  kind: 'mixed' as Kind,
  focusType: null as string | null,
  lim: 10,
  /** 制限時間（秒）。0 は「なし」。10秒刻みで60秒まで。 */
  tmr: 0,
};

const state = {
  types: [] as TypeRow[],
  dashboard: null as Dashboard | null,
  queue: [] as Question[],
  idx: 0,
  kind: 'mixed' as Kind,
  focusType: null as string | null,
  startedAt: '',
  /** 置いた語。値は state.pool の添字（同じ綴りの語が2つあっても取り違えない） */
  slots: [] as (number | null)[],
  /** 語群。使った語は used=true にして、並びは動かさない */
  pool: [] as { word: string; used: boolean }[],
  answered: false,
  timedOut: false,
  tEnd: 0,
  timer: null as number | null,
  qStart: 0,
  log: [] as {
    q: Question;
    submitted: string[] | null;
    ok: boolean;
    timed_out: number;
    elapsed_ms: number | null;
  }[],
  openGroup: null as string | null,
  lastSessionId: null as number | null,
};

const CFG_KEY = 'basCfg';

function loadCfg(): void {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (!raw) return;
    const v = JSON.parse(raw) as Partial<typeof cfg>;
    if (v.lim && LIMITS.includes(v.lim)) cfg.lim = v.lim;
    if (typeof v.tmr === 'number' && TIMERS.includes(v.tmr)) cfg.tmr = v.tmr;
  } catch {
    // 壊れていたら既定のまま。設定の読み込みで画面を止めない
  }
}

function saveCfg(): void {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify({ lim: cfg.lim, tmr: cfg.tmr }));
  } catch {
    // silent fail
  }
}

const LIMITS = [5, 10, 20, 30];
/** 制限時間は10秒刻みで60秒まで。0 は「なし」。 */
const TIMERS = [0, 10, 20, 30, 40, 50, 60];

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

/**
 * 解説の書式。
 *
 * 決め手の文には強調が入る（<b> と <em>）。**必ず全部エスケープしてから**
 * この2つだけ戻す。素の innerHTML に流すと、問題データが1か所壊れただけで
 * 画面ごと乗っ取られる経路になる。
 */
function rich(s: string): string {
  return esc(s)
    .replace(/&lt;(\/?)(b|em|u)&gt;/g, '<$1$2>');
}

function jstNow(): string {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, -1) + '+09:00';
}

function fmtDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[2]}/${m[3]} ${m[4]}:${m[5]}` : iso;
}

function shuffle<T>(a: T[]): T[] {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
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

function typeLabel(code: string): string {
  const t = state.types.find((x) => x.code === code);
  return t ? `${t.code} ${t.name}` : code;
}

const MARU = '①②③④⑤⑥⑦⑧⑨⑩';

// ── スタイル ────────────────────────────────────────────────────────────────

/**
 * 共通スタイル（`test-style.ts`）＋並び替えのぶん。
 *
 * 足しているのは3つ。**共通側の色や余白をここで上書きしないこと**
 * （単語・文法テストと見た目がずれると、生徒には壊れて見える）。
 *   - 解答欄と語群（この画面の本体）
 *   - 決め手（8行の解説）
 *   - 弱点の2階層
 */
function injectStyles(): void {
  injectTestStyles('bas-styles');
  if (document.getElementById('bas-extra')) return;
  const el = document.createElement('style');
  el.id = 'bas-extra';
  el.textContent = `
/* ── 出題 ── */
.b-stage{text-align:left;padding:20px 16px}
/* 導入文。ここに答えの文脈が入るので、問題文と同じ強さで出すと的が絞れない。
   一段落として斜体で置く。 */
.b-lead{font-size:14.5px;line-height:1.7;color:var(--fg2);font-style:italic;
  border-left:2px solid var(--line2);padding-left:11px;margin:0 0 16px}

/* 解答欄。空所は下線、置いた語はチップ。
   **高さを固定する。** 語を置くたびに行が増えて下の語群が動くと、
   次に押したい語が指の下から逃げる。3行ぶんを先に確保しておく。 */
.b-slots{font-size:17px;line-height:2.2;min-height:calc(2.2em * 2);
  word-break:normal;overflow-wrap:anywhere}
.b-slots .lit{color:var(--fg3)}
.b-slots .hole{display:inline-block;min-width:56px;height:1.15em;margin:0 3px;
  border-bottom:2px solid var(--line2);vertical-align:-.2em}
.b-slots .hole.next{border-bottom-color:var(--lime)}
.b-slots .put{display:inline-block;margin:0 3px 4px 0;padding:2px 10px;border-radius:7px;
  border:1px solid var(--lime);color:var(--lime);font-weight:600;
  background:color-mix(in srgb,var(--lime) 12%,transparent);cursor:pointer;
  font-size:16px;line-height:1.5}
.b-slots .put:active{transform:scale(.97)}
/* 答え合わせのあとは触れない。色も判定に合わせる */
.b-slots.done .put{cursor:default;border-color:var(--line2);color:var(--fg);
  background:var(--surface2)}
.b-slots.ng .put{border-color:color-mix(in srgb,var(--ng) 55%,transparent);color:var(--ng);
  background:color-mix(in srgb,var(--ng) 10%,transparent)}

/* 語群。**使った語も消さずに残す**（薄くするだけ）。
   消すと下の語が繰り上がって、狙って押した語の位置がずれる。 */
.b-pool{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 0}
.b-pool button{padding:9px 14px;border-radius:9px;border:1px solid var(--line2);
  background:var(--surface2);color:var(--fg);font-size:16px;font-weight:500;
  cursor:pointer;transition:.12s;line-height:1.4}
.b-pool button:active{transform:scale(.97)}
.b-pool button.used{opacity:.22;pointer-events:none}
.b-pool button:disabled{opacity:.22;pointer-events:none}

/* 語群の下の小さなやり直し。**ボタンは1つだけ。**
   置いた語はタップで戻せるので「1つ戻す」は要らなかった。 */
.b-tools{margin:12px 0 0;text-align:right}
.b-tools button{background:none;border:none;color:var(--fg3);font-size:12px;
  text-decoration:underline;cursor:pointer;padding:2px 0}
.b-tools button:disabled{opacity:.3;text-decoration:none}

/* ── 判定 ── */
/* **答える前は高さを持たせない。**
   ここに 220px の空枠を置いていたせいで「答え合わせ」が画面の下に押し出され、
   スクロールしないと押せなかった。テスト中に長い解説を出さない方針にしたので、
   判定は数行で収まる。答えたあとに下へ伸びるだけなら、上の語群は動かない。 */
.b-judge{margin-top:14px}
.b-judge:empty{display:none}

/* 出題中のボタンは画面の下端に貼りつける。
   語群が3行になっても「答え合わせ」が指の届く位置から動かない。
   下部タブは出題中に出さないので、ここを占有してよい。 */
.v-acts.b-sticky{position:sticky;bottom:0;z-index:4;margin-top:6px;
  padding:10px 0 calc(10px + env(safe-area-inset-bottom));
  background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(10px)}
.b-judge .hd{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:800}
.b-judge .hd.ok{color:var(--lime)}
.b-judge .hd.ng{color:var(--ng)}
.b-judge .ans{margin-top:9px;font-size:17px;font-weight:700;line-height:1.65;letter-spacing:-.01em}
.b-judge .ja{margin-top:5px;font-size:13.5px;color:var(--fg2);line-height:1.7}
.b-judge .mine{margin-top:8px;font-size:13.5px;color:var(--ng);line-height:1.7}
.b-judge .mine em{font-style:normal;color:var(--fg3);margin-right:6px;
  font-family:"JetBrains Mono",monospace;font-size:10.5px;letter-spacing:.14em}
.b-badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:11px}
.b-badge{font-size:11px;color:var(--fg2);border:1px solid var(--line2);
  padding:2px 9px;border-radius:99px;white-space:nowrap}
.b-badge i{font-style:normal;font-family:"JetBrains Mono",monospace;font-size:10px;
  color:var(--accent);margin-right:5px;font-weight:700}
/* 決め手（①〜⑧）。**出題中には出さない。**
   解いている最中に長い解説を読ませると、テストではなく教材になってしまう。
   結果画面で、落とした問題の折りたたみの中から読む。 */
.b-steps{margin:8px 0 0;padding:11px 12px;border-radius:9px;border:1px solid var(--line2);
  background:var(--surface2)}
.b-steps ol{margin:0;padding:0;list-style:none}
.b-steps li{display:grid;grid-template-columns:20px 1fr;gap:8px;font-size:13.5px;
  line-height:1.75;color:var(--fg2);padding:3px 0}
.b-steps li span{color:var(--fg3);font-size:12px;padding-top:2px}
.b-steps li em{font-style:italic;color:var(--fg);font-weight:600}
.b-steps li b{color:var(--fg);font-weight:700}

/* 一覧を枠内でスクロールさせない。
   ページのスクロールの中にもう1つスクロールがあると、
   「下にまだあること」に気づけず、落とした問題を全部見てもらえない。
   共通CSS（test-style.ts）の .v-list ul は触らない——単語・文法テストと共有しているため。 */
.v-list.b-flat ul{max-height:none;overflow:visible}

/* 結果画面の「決め手を見る」 */
details.b-why{margin-top:8px}
details.b-why > summary{cursor:pointer;font-size:12px;color:var(--fg3);
  list-style:none;display:inline-flex;align-items:center;gap:5px}
details.b-why > summary::-webkit-details-marker{display:none}
details.b-why > summary::before{content:"▸";font-size:10px}
details.b-why[open] > summary::before{content:"▾"}

/* ── 設定のスライダー ── */
.b-set{border:1px solid var(--line);background:var(--surface);border-radius:12px;
  padding:14px 15px;margin:0 0 10px}
.b-set > .lb{display:flex;align-items:baseline;gap:8px;font-size:13px;color:var(--fg2);
  font-weight:600}
.b-set > .lb b{margin-left:auto;font-family:var(--num);font-variant-numeric:tabular-nums;
  font-size:19px;font-weight:700;color:var(--lime);letter-spacing:-.01em}
.b-set > .lb b.off{color:var(--fg3);font-size:15px}
.b-set .v-sl{margin:6px 0 0}
.b-set .nt{display:block;margin:8px 0 0;font-size:11.5px;color:var(--fg3);line-height:1.7}

/* ── 弱点（大分類 → 型） ── */
.b-grp{margin:0 0 8px;border:1px solid var(--line);background:var(--surface);border-radius:12px;
  overflow:hidden}
.b-grp > button{display:block;width:100%;text-align:left;border:none;background:none;
  color:var(--fg);padding:13px 14px;cursor:pointer;font-family:inherit}
.b-grp .r1{display:flex;align-items:baseline;gap:10px}
.b-grp .r1 .cd{font-family:"JetBrains Mono",monospace;font-size:12px;font-weight:700;
  color:var(--accent);width:14px;flex:none}
.b-grp .r1 .nm{font-size:16px;font-weight:800;letter-spacing:-.02em}
.b-grp .r1 .pc{margin-left:auto;font-family:var(--num);font-variant-numeric:tabular-nums;
  font-size:16px;font-weight:700;color:var(--lime)}
.b-grp .r1 .pc.zero{color:var(--fg3)}
.b-grp .tr{display:block;height:5px;border-radius:99px;background:var(--line);margin:8px 0 6px;
  overflow:hidden}
.b-grp .tr i{display:block;height:100%;background:var(--lime)}
.b-grp .tr i.low{background:var(--ng)}
.b-grp .sub{display:block;font-size:11.5px;color:var(--fg3)}
.b-grp ul{margin:0;padding:0 0 6px;list-style:none;border-top:1px solid var(--line)}
.b-grp li{display:grid;grid-template-columns:30px 1fr auto;gap:3px 9px;align-items:baseline;
  padding:9px 14px;border-bottom:1px solid var(--line)}
.b-grp li:last-child{border-bottom:none}
.b-grp li .cd{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--fg3);font-weight:700}
.b-grp li .nm{font-size:14px;font-weight:600}
.b-grp li .pc{font-family:var(--num);font-variant-numeric:tabular-nums;font-size:14px;
  font-weight:700;color:var(--lime)}
.b-grp li .pc.low{color:var(--ng)}
.b-grp li .pc.zero{color:var(--fg3);font-weight:500}
.b-grp li .go{grid-column:2 / -1;justify-self:start;margin-top:3px;font-size:11.5px;
  color:var(--fg3);background:none;border:none;padding:0;text-decoration:underline;cursor:pointer}
.b-grp li .go:disabled{opacity:.35;text-decoration:none;cursor:default}

/* ── 結果の一覧 ── */
.v-list li.b-li{display:block;padding:12px 15px}
.b-li .hd{display:flex;align-items:baseline;gap:8px;margin-bottom:5px}
.b-li .hd .n{font-family:"JetBrains Mono",monospace;font-size:10.5px;color:var(--fg3)}
.b-li .hd .t{font-family:"JetBrains Mono",monospace;font-size:10px;color:var(--ng);margin-left:auto}
.b-li .e{font-size:14.5px;line-height:1.7;font-weight:600}
.b-li .m{font-size:13px;color:var(--ng);margin-top:4px;line-height:1.7}
.b-li .j{font-size:12.5px;color:var(--fg3);margin-top:4px;line-height:1.7}
.b-li .bd{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}
`;
  document.head.appendChild(el);
}

// ── 画面の骨格 ──────────────────────────────────────────────────────────────

type Tab = 'home' | 'test' | 'weak' | null;

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
  ${item('weak', '弱点', '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M3 20h18"/>')}
</nav>`;
}

function shell(title: string, sub: string, body: string, count = '', tab: Tab = 'home'): string {
  return `
<div class="v-top">
  <span class="ttl">並び替えテスト</span>
  <span class="rng">${esc(sub)}</span>
  ${count ? `<span class="cnt">${esc(count)}</span>` : ''}
</div>
<div class="v-bar"><i id="bProg"></i></div>
<div class="v-wrap"${tab ? '' : ' style="padding-bottom:40px"'}>${
    title ? `<h1>${esc(title)}</h1>` : ''
  }${body}</div>
${navBar(tab)}`;
}

function bindNav(): void {
  document.querySelectorAll<HTMLElement>('.v-nav button').forEach((b) => {
    b.onclick = () => {
      const t = b.dataset.tab;
      if (t === 'home') void showHome();
      else if (t === 'test') renderSetup();
      else if (t === 'weak') void showWeakness();
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
      (retry ? '<button class="v-ghost" id="bRetry">もう一度読み込む</button>' : ''),
  );
  const r = document.getElementById('bRetry');
  if (r) r.onclick = () => void showHome();
}

function setProgress(done: number, total: number): void {
  const p = document.getElementById('bProg');
  if (p) p.style.width = total ? `${(done / total) * 100}%` : '0%';
}

// ── ホーム ──────────────────────────────────────────────────────────────────

async function showHome(): Promise<void> {
  renderLoading();
  try {
    const res = await api<{
      pool: number;
      types: TypeRow[];
      dashboard: Dashboard;
    }>('/api/bas/home');
    state.types = res.types;
    state.dashboard = res.dashboard;
    renderHome(res.pool, res.dashboard);
  } catch (e) {
    renderError(e instanceof Error ? e.message : '読み込みに失敗しました');
  }
}

function renderHome(pool: number, d: Dashboard): void {
  const weak = d.weak.length
    ? `
<div class="v-list b-flat">
  <h3>いま落としやすい型 <em>${d.weak.length}</em></h3>
  <ul>
    ${d.weak
      .map(
        (t) => `<li class="b-li">
      <div class="e">${esc(t.code)}　${esc(t.name)}</div>
      <div class="j">${t.tried}問中 ${t.tried - t.ok}問を落としています${
        t.hint ? `　／　${esc(t.hint)}` : ''
      }</div>
    </li>`,
      )
      .join('')}
  </ul>
</div>`
    : `<p class="v-note">解いた数が少ないうちは弱点を出しません。${
        d.answered ? `いまは${d.answered}問。` : ''
      }型ごとに3問ほど解くと出てきます。</p>`;

  const recent = d.recent.length
    ? `
<div class="v-list b-flat">
  <h3>最近のテスト</h3>
  <ul>
    ${d.recent
      .slice(0, 5)
      .map(
        (s) => `<li class="b-li">
      <div class="hd"><span class="n">${esc(fmtDate(s.finished_at))}</span>
        <span class="t" style="color:var(--fg3)">${esc(kindLabel(s.kind, s.focus_type))}${
          s.timer_sec ? ` ${s.timer_sec}秒` : ''
        }</span></div>
      <div class="e">${s.correct} / ${s.total}</div>
    </li>`,
      )
      .join('')}
  </ul>
</div>`
    : '';

  const body = `
<div class="v-stats">
  <div class="v-stat"><b>${pool}</b><span>いま出せる問題</span></div>
  <div class="v-stat"><b>${d.tried}</b><span>解いた問題</span></div>
  <div class="v-stat"><b>${d.rate}</b><span>通算の正答率（%）</span></div>
</div>

<button class="v-go" id="bStart" style="margin-top:14px">テストをはじめる</button>
<button class="v-ghost" id="bWeakGo"${d.weak.length ? '' : ' disabled'}>弱点だけ復習する</button>

${weak}
${recent}
<p class="v-note">語群をタップして1文を組み立てます。置いた語をもう一度タップすると戻せます。全部置いてから「答え合わせ」を押すので、並べ終わってから見直せます。</p>
<p class="v-note" style="opacity:.5;font-size:10px">build ${BUILD}</p>`;

  app().innerHTML = shell('', `${pool}問`, body, '', 'home');
  bindNav();

  document.getElementById('bStart')!.onclick = () => renderSetup();
  const w = document.getElementById('bWeakGo') as HTMLButtonElement | null;
  if (w && !w.disabled) {
    w.onclick = () => {
      cfg.kind = 'weak';
      cfg.focusType = null;
      void startTest();
    };
  }
}

function kindLabel(kind: string, focusType: string | null): string {
  if (kind === 'retry') return '解き直し';
  if (kind === 'weak') return '弱点復習';
  if (kind === 'type') return focusType ? `${focusType} 集中` : '記号指定';
  return '総合ランダム';
}

// ── テストの設定 ────────────────────────────────────────────────────────────

function renderSetup(): void {
  const chip = (group: string, v: string, label: string, on: boolean) =>
    `<button class="v-chip${on ? ' on' : ''}" data-g="${group}" data-v="${esc(v)}">${esc(
      label,
    )}</button>`;

  const hasWeak = (state.dashboard?.weak.length ?? 0) > 0;

  // 記号は「プールに問題がある型」だけ出す。0問の型を並べても押せないだけ。
  const typeOptions = state.types.filter((t) => {
    const s = state.dashboard?.groups.flatMap((g) => g.types).find((x) => x.code === t.code);
    return (s?.total ?? 0) > 0;
  });

  const body = `
<p class="v-hint" style="margin:0 0 6px">出題のしかた</p>
<div class="v-row">
  ${chip('kind', 'mixed', '総合ランダム', cfg.kind === 'mixed')}
  ${chip('kind', 'weak', '弱点だけ復習', cfg.kind === 'weak')}
  ${chip('kind', 'type', '記号を指定', cfg.kind === 'type')}
</div>
${
  hasWeak
    ? ''
    : '<p class="v-hint" style="margin:8px 0 0">弱点復習は、型ごとに3問ほど解くと使えるようになります。</p>'
}

<div id="bTypeWrap" class="${cfg.kind === 'type' ? '' : 'v-hide'}">
  <p class="v-hint" style="margin:18px 0 6px">どの型をやるか</p>
  <div class="v-row">
    ${typeOptions
      .map((t) => chip('type', t.code, `${t.code} ${t.name}`, cfg.focusType === t.code))
      .join('')}
  </div>
</div>

<div class="b-set" style="margin-top:18px">
  <span class="lb">出題数<b id="bLimVal">${cfg.lim}問</b></span>
  <div class="v-sl">
    <span>5</span>
    <input type="range" id="bLim" min="5" max="30" step="5" value="${cfg.lim}">
    <span>30</span>
  </div>
</div>

<div class="b-set">
  <span class="lb">制限時間（1問あたり）<b id="bTmrVal" class="${
    cfg.tmr ? '' : 'off'
  }">${cfg.tmr ? `${cfg.tmr}秒` : 'なし'}</b></span>
  <div class="v-sl">
    <span>なし</span>
    <input type="range" id="bTmr" min="0" max="60" step="10" value="${cfg.tmr}">
    <span>60秒</span>
  </div>
  <span class="nt">既定は「なし」。並び替えは組み立てに時間が要るので、短くすると
  「わかっているか」ではなく「手が速いか」を測ることになります。</span>
</div>

<button class="v-go" id="bGo" style="margin-top:16px">はじめる</button>
<p class="v-err v-hide" id="bMsg"></p>`;

  app().innerHTML = shell('テスト', '', body, '', 'test');
  bindNav();

  document.querySelectorAll<HTMLElement>('.v-chip[data-g]').forEach((b) => {
    b.onclick = () => {
      const g = b.dataset.g!;
      document
        .querySelectorAll<HTMLElement>(`.v-chip[data-g="${g}"]`)
        .forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      if (g === 'kind') {
        cfg.kind = b.dataset.v as Kind;
        document.getElementById('bTypeWrap')!.classList.toggle('v-hide', cfg.kind !== 'type');
      } else if (g === 'type') cfg.focusType = b.dataset.v!;
      saveCfg();
    };
  });

  // 出題数と制限時間はスライダー。チップを7個並べると、選ぶ前から画面がボタンだらけになる
  const lim = document.getElementById('bLim') as HTMLInputElement;
  const limVal = document.getElementById('bLimVal')!;
  lim.oninput = () => {
    cfg.lim = Number(lim.value);
    limVal.textContent = `${cfg.lim}問`;
  };
  lim.onchange = () => saveCfg();

  const tmr = document.getElementById('bTmr') as HTMLInputElement;
  const tmrVal = document.getElementById('bTmrVal')!;
  tmr.oninput = () => {
    cfg.tmr = Number(tmr.value);
    tmrVal.textContent = cfg.tmr ? `${cfg.tmr}秒` : 'なし';
    tmrVal.classList.toggle('off', !cfg.tmr);
  };
  tmr.onchange = () => saveCfg();

  document.getElementById('bGo')!.onclick = () => void startTest();
}

function setupMsg(text: string): void {
  const el = document.getElementById('bMsg');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('v-hide', !text);
}

async function startTest(): Promise<void> {
  if (cfg.kind === 'type' && !cfg.focusType) {
    setupMsg('やる型を1つ選んでください');
    return;
  }
  renderLoading();
  try {
    const qs = new URLSearchParams({ kind: cfg.kind, limit: String(cfg.lim) });
    if (cfg.kind === 'type' && cfg.focusType) qs.set('type', cfg.focusType);
    const res = await api<{ questions: Question[]; weak_types?: string[] }>(
      `/api/bas/questions?${qs.toString()}`,
    );

    if (!res.questions.length) {
      // 弱点がまだ決まらない、あるいはその型の問題がプールに無い。
      // 適当な問題で埋めない（「弱点」として出したものが弱点でなくなる）。
      app().innerHTML = shell(
        '',
        '',
        `<p class="v-empty">${
          cfg.kind === 'weak'
            ? '弱点を出せるだけの解答がまだありません。<br>総合ランダムを何回か解いてから戻ってきてください。'
            : 'この条件で出せる問題がありませんでした。'
        }</p><button class="v-ghost" id="bBack">条件を変える</button>`,
        '',
        'test',
      );
      bindNav();
      document.getElementById('bBack')!.onclick = () => renderSetup();
      return;
    }

    state.queue = res.questions;
    state.idx = 0;
    state.log = [];
    state.kind = cfg.kind;
    state.focusType = cfg.kind === 'type' ? cfg.focusType : null;
    state.startedAt = jstNow();
    renderQuestion();
  } catch (e) {
    renderError(e instanceof Error ? e.message : '読み込みに失敗しました');
  }
}

// ── タイマー ────────────────────────────────────────────────────────────────

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
  const bar = document.getElementById('bTbar');
  const fill = document.getElementById('bTfill');
  const left = document.getElementById('bTleft');
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
  // 途中まで置いた並びは残したまま締める。時間切れは必ず不正解。
  settle();
}

// ── 出題 ────────────────────────────────────────────────────────────────────

function renderQuestion(): void {
  const q = state.queue[state.idx];
  state.answered = false;
  state.timedOut = false;
  state.slots = new Array(q.blanks).fill(null);
  state.pool = q.words.map((w) => ({ word: w, used: false }));
  state.qStart = performance.now();

  const body = `
<div class="v-stage b-stage">
  <div class="v-tbar${cfg.tmr ? '' : ' v-hide'}" id="bTbar"><i id="bTfill"></i><b id="bTleft"></b></div>
  <p class="b-lead">${esc(q.lead)}</p>
  <div class="b-slots" id="bSlots"></div>
  <div class="b-pool" id="bPool"></div>
  <div class="b-tools"><button id="bClear">全部戻す</button></div>
  <div class="b-judge" id="bJudge"></div>
</div>
<div class="v-acts b-sticky" id="bActs">
  <button class="pri" id="bCheck" disabled>答え合わせ</button>
</div>
<button class="v-abort" id="bAbort">中断する（記録は残りません）</button>`;

  app().innerHTML = shell('', '', body, `${state.idx + 1} / ${state.queue.length}`, null);
  setProgress(state.idx, state.queue.length);

  document.getElementById('bAbort')!.onclick = () => {
    stopTimer();
    void showHome();
  };
  document.getElementById('bClear')!.onclick = () => clearAll();
  document.getElementById('bCheck')!.onclick = () => settle();

  paint();
  startTimer();
}

/** 解答欄と語群を描き直す。**この関数以外から DOM をいじらないこと。** */
function paint(): void {
  const q = state.queue[state.idx];
  const slotsEl = document.getElementById('bSlots')!;
  const poolEl = document.getElementById('bPool')!;

  // 次に埋まる空所（ここだけライムの下線にして、どこに入るかを見せる）
  const nextHole = state.answered ? -1 : state.slots.indexOf(null);

  const parts = q.frame.split('{}');
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    const lit = parts[i];
    if (lit.trim()) html += `<span class="lit">${esc(lit)}</span>`;
    else if (lit) html += ' ';
    if (i < state.slots.length) {
      const pi = state.slots[i];
      html +=
        pi === null
          ? `<span class="hole${i === nextHole ? ' next' : ''}"></span>`
          : `<span class="put" data-slot="${i}">${esc(state.pool[pi].word)}</span>`;
    }
  }
  slotsEl.innerHTML = html;
  slotsEl.classList.toggle('done', state.answered);

  poolEl.innerHTML = state.pool
    .map(
      (p, i) =>
        `<button data-pool="${i}"${p.used ? ' class="used"' : ''}${
          state.answered ? ' disabled' : ''
        }>${esc(p.word)}</button>`,
    )
    .join('');

  if (!state.answered) {
    slotsEl.querySelectorAll<HTMLElement>('.put').forEach((el) => {
      el.onclick = () => takeBack(Number(el.dataset.slot));
    });
    poolEl.querySelectorAll<HTMLElement>('button[data-pool]').forEach((el) => {
      el.onclick = () => place(Number(el.dataset.pool));
    });
  }

  // 全部置くまで「答え合わせ」は押せない。
  // 置き終わった時点で自動で締めると、並べ終わった文を**見直せない**。
  // それでは語順の知識ではなく、最後の1タップの正確さを測ることになる。
  const check = document.getElementById('bCheck') as HTMLButtonElement | null;
  if (check) check.disabled = state.answered || state.slots.some((x) => x === null);

  const clear = document.getElementById('bClear') as HTMLButtonElement | null;
  if (clear) clear.disabled = state.answered || state.slots.every((x) => x === null);
}

/** 語群の語を、いちばん左の空所に置く。締めるのは「答え合わせ」を押したときだけ。 */
function place(poolIdx: number): void {
  if (state.answered) return;
  const p = state.pool[poolIdx];
  if (!p || p.used) return;
  const slot = state.slots.indexOf(null);
  if (slot < 0) return;
  state.slots[slot] = poolIdx;
  p.used = true;
  paint();
}

function takeBack(slot: number): void {
  if (state.answered) return;
  const pi = state.slots[slot];
  if (pi === null) return;
  state.pool[pi].used = false;
  state.slots[slot] = null;
  paint();
}

function clearAll(): void {
  if (state.answered) return;
  state.slots = state.slots.map(() => null);
  state.pool.forEach((p) => (p.used = false));
  paint();
}

/** 現在の並び。空所が残っていれば null（＝不正解）。 */
function currentOrder(): string[] | null {
  if (state.slots.some((s) => s === null)) return null;
  return state.slots.map((s) => state.pool[s!].word);
}

function normalize(words: string[]): string {
  return words.join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 判定して決め手を出す。
 *
 * 正誤はここで出すが**記録に残る正誤はサーバーが付け直す**。
 * ここは即時フィードバックのための表示にすぎない。
 */
function settle(): void {
  if (state.answered) return;
  state.answered = true;
  stopTimer();

  const q = state.queue[state.idx];
  const submitted = currentOrder();
  // 別解も正解にする。1つの語群から意味の同じ文が2通り作れることがあるので、
  // そこを潰して問題を易しくするより、採点側で許すほうがよい。
  // **記録に残る正誤はサーバーが同じ規則で付け直す。**
  const ok =
    !state.timedOut &&
    submitted !== null &&
    (normalize(submitted) === normalize(q.answer) ||
      (q.accepted ?? []).some((alt) => normalize(alt) === normalize(submitted)));
  const elapsed = Math.round(performance.now() - state.qStart);

  state.log.push({
    q,
    submitted,
    ok,
    timed_out: state.timedOut ? 1 : 0,
    elapsed_ms: elapsed,
  });

  paint();
  const slotsEl = document.getElementById('bSlots')!;
  slotsEl.classList.toggle('ng', !ok);

  const mine =
    !ok && submitted
      ? `<div class="mine"><em>あなたの並び</em>${esc(joinSentence(q.frame, submitted))}</div>`
      : !ok && state.timedOut
        ? `<div class="mine"><em>時間切れ</em>最後まで置けませんでした</div>`
        : '';

  // **テスト中は解説を出さない。**
  // 解いている最中に8行の決め手を読ませると、テストではなく教材になる。
  // 手が止まるし、判定の枠が大きくなって「次へ」が画面の外に出る。
  // 決め手は結果画面で、落とした問題だけまとめて読む。
  document.getElementById('bJudge')!.innerHTML = `
<div class="hd ${ok ? 'ok' : 'ng'}">${ok ? '正解' : state.timedOut ? '時間切れ' : '不正解'}</div>
<div class="ans">${esc(q.sentence)}</div>
<div class="ja">${esc(q.ja)}</div>
${mine}`;

  const acts = document.getElementById('bActs')!;
  acts.innerHTML = `<button class="pri" id="bNext">${
    state.idx >= state.queue.length - 1 ? '結果を見る' : '次の問題へ'
  }</button>`;
  document.getElementById('bNext')!.onclick = () => next();
  setProgress(state.idx + 1, state.queue.length);
}

/**
 * frame の空所を並びで埋めて1文にする。誤答を「文の形」で見せるために使う。
 *
 * 語群チップは文頭が丸見えにならないよう小文字で配ってあるので、
 * つないだだけだと小文字始まりの文になる。**先頭を大文字に戻す。**
 * そこが小文字のままだと、語順ではなく大文字小文字を間違えたように見える。
 */
function joinSentence(frame: string, words: string[]): string {
  const parts = frame.split('{}');
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    out += parts[i];
    if (i < words.length) out += words[i];
  }
  const s = out.replace(/\s+([.,?!])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  const m = s.match(/[A-Za-z]/);
  if (!m || m.index === undefined) return s;
  return s.slice(0, m.index) + s[m.index].toUpperCase() + s.slice(m.index + 1);
}

function next(): void {
  if (state.idx >= state.queue.length - 1) {
    void finish();
    return;
  }
  state.idx++;
  renderQuestion();
}

/**
 * その回で落とした問題だけ、その場で解き直す。
 *
 * サーバーに取りに行かない（同じ問題をもう一度出すだけなので）。
 * ただし**語群は混ぜ直す。** 並びをそのまま出すと、位置を覚えているだけで
 * 解けてしまい、解き直しにならない。
 */
function startRetry(): void {
  const wrong = state.log.filter((l) => !l.ok).map((l) => l.q);
  if (!wrong.length) return;

  state.queue = wrong.map((q) => ({ ...q, words: shuffle(q.words) }));
  state.idx = 0;
  state.log = [];
  state.kind = 'retry';
  state.focusType = null;
  state.startedAt = jstNow();
  renderQuestion();
}

// ── 結果 ────────────────────────────────────────────────────────────────────

async function finish(): Promise<void> {
  renderLoading();
  const clientSessionId = uuid();
  try {
    const res = await api<{
      session_id: number;
      total: number;
      correct: number;
      results: { question_id: number; ok: number }[];
    }>('/api/bas/sessions', {
      method: 'POST',
      body: JSON.stringify({
        client_session_id: clientSessionId,
        kind: state.kind,
        focus_type: state.focusType,
        timer_sec: cfg.tmr,
        started_at: state.startedAt,
        answers: state.log.map((l) => ({
          question_id: l.q.id,
          submitted: l.submitted,
          timed_out: l.timed_out,
          elapsed_ms: l.elapsed_ms,
        })),
      }),
    });
    state.lastSessionId = res.session_id;
    // サーバーの採点で上書きする。画面の判定と食い違ったらサーバーが正。
    const okMap = new Map(res.results.map((r) => [r.question_id, r.ok === 1]));
    for (const l of state.log) {
      const v = okMap.get(l.q.id);
      if (v !== undefined) l.ok = v;
    }
    renderResult(res.correct, res.total);
  } catch (e) {
    // 保存に失敗しても結果は見せる。解いた時間を無駄にしない。
    renderResult(
      state.log.filter((l) => l.ok).length,
      state.log.length,
      e instanceof Error ? e.message : '結果の保存に失敗しました',
    );
  }
}

function renderResult(correct: number, total: number, err?: string): void {
  const wrong = state.log.filter((l) => !l.ok);

  // このテストで落とした型を数える。弱点タブの全体集計とは別で、いま何を落としたか。
  const missed = new Map<string, number>();
  for (const l of wrong) for (const c of l.q.types) missed.set(c, (missed.get(c) ?? 0) + 1);
  const missedList = [...missed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  const list = wrong.length
    ? `
<div class="v-list b-flat">
  <h3>落とした問題 <em>${wrong.length}</em></h3>
  <ul>
    ${wrong
      .map(
        (l) => `<li class="b-li">
      <div class="hd"><span class="n">No.${l.q.no}</span>${
        l.timed_out ? '<span class="t">TIME UP</span>' : ''
      }</div>
      <div class="e">${esc(l.q.sentence)}</div>
      ${
        l.submitted
          ? `<div class="m">→ ${esc(joinSentence(l.q.frame, l.submitted))}</div>`
          : ''
      }
      <div class="j">${esc(l.q.ja)}</div>
      <div class="bd">${l.q.types
        .map((c) => `<span class="b-badge"><i>${esc(c)}</i>${esc(typeName(c))}</span>`)
        .join('')}</div>
      <details class="b-why"><summary>決め手を見る</summary>
        <div class="b-steps"><ol>${l.q.steps
          .map((t, i) => `<li><span>${MARU[i] ?? '・'}</span><div>${rich(t)}</div></li>`)
          .join('')}</ol></div>
      </details>
    </li>`,
      )
      .join('')}
  </ul>
</div>`
    : '<p class="v-empty">全問正解です。</p>';

  const missedBox = missedList.length
    ? `
<div class="v-list b-flat">
  <h3>この回で落ちた型</h3>
  <ul>
    ${missedList
      .map(
        ([c, n]) =>
          `<li class="b-li"><div class="e">${esc(c)}　${esc(typeName(c))}</div>
           <div class="j">${n}問で落としています</div></li>`,
      )
      .join('')}
  </ul>
</div>`
    : '';

  const body = `
${err ? `<div class="v-err">${esc(err)}</div>` : ''}
<div class="v-score">
  <b>${correct}/${total}</b>
  <span>正答率 ${total ? Math.round((correct / total) * 100) : 0}%</span>
</div>
${missedBox}
${list}
${
  wrong.length
    ? `<button class="v-go" id="bRetry">間違えた${wrong.length}問を解き直す</button>`
    : ''
}
<button class="${wrong.length ? 'v-ghost' : 'v-go'}" id="bAgain">${
    state.kind === 'retry' ? '新しい問題を解く' : '同じ条件でもう一度'
  }</button>
<button class="v-ghost" id="bHome">ホームへ</button>`;

  app().innerHTML = shell('結果', kindLabel(state.kind, state.focusType), body, '', null);
  setProgress(1, 1);
  const retry = document.getElementById('bRetry');
  if (retry) retry.onclick = () => startRetry();
  document.getElementById('bAgain')!.onclick = () => void startTest();
  document.getElementById('bHome')!.onclick = () => void showHome();
}

function typeName(code: string): string {
  return state.types.find((t) => t.code === code)?.name ?? '';
}

// ── 弱点 ────────────────────────────────────────────────────────────────────

/**
 * 大分類（A〜G）→ 型（A1〜G4）の2階層。
 *
 * 38個の記号をいきなり並べると読めないので、まず7グループで「どこが弱いか」、
 * 開いて「何が弱いか」。**まだ解いていない型は 0% ではなく「未挑戦」と書く。**
 * 0% と書くと、解いていないのに全問落としたように見える。
 */
async function showWeakness(): Promise<void> {
  renderLoading();
  try {
    const res = await api<{ groups: GroupStat[]; types: TypeStat[] }>('/api/bas/weakness');
    renderWeakness(res.groups);
  } catch (e) {
    renderError(e instanceof Error ? e.message : '読み込みに失敗しました');
  }
}

function renderWeakness(groups: GroupStat[]): void {
  const tried = groups.reduce((s, g) => s + g.tried, 0);

  const card = (g: GroupStat) => {
    const open = state.openGroup === g.code;
    const w = g.tried ? (g.ok / g.tried) * 100 : 0;
    return `
<div class="b-grp">
  <button data-grp="${esc(g.code)}">
    <span class="r1">
      <span class="cd">${esc(g.code)}</span>
      <span class="nm">${esc(g.name)}</span>
      <span class="pc${g.tried ? '' : ' zero'}">${g.tried ? `${g.rate}%` : '—'}</span>
    </span>
    <span class="tr"><i class="${w < 70 ? 'low' : ''}" style="width:${w.toFixed(1)}%"></i></span>
    <span class="sub">${
      g.tried ? `${g.tried}問中 ${g.ok}問 正解` : 'まだ解いていません'
    }　／　プールに${g.total}問</span>
  </button>
  ${
    open
      ? `<ul>${g.types
          .map(
            (t) => `<li>
        <span class="cd">${esc(t.code)}</span>
        <span class="nm">${esc(t.name)}</span>
        <span class="pc${t.tried ? (t.rate < 70 ? ' low' : '') : ' zero'}">${
          t.tried ? `${t.rate}%` : '未挑戦'
        }</span>
        <button class="go" data-type="${esc(t.code)}"${t.total ? '' : ' disabled'}>${
          t.tried ? `${t.tried}問中 ${t.ok}問正解` : `プールに${t.total}問`
        }　この型だけ解く</button>
      </li>`,
          )
          .join('')}</ul>`
      : ''
  }
</div>`;
  };

  const body = `
<p class="v-sub">攻略の記号ごとに、どこで落としているかを出しています。${
    tried ? '' : 'まだ解答がないので、テストを解くとここが埋まります。'
  }</p>
${groups.map(card).join('')}
<p class="v-note">
  1つの問題が記号を複数持つので、合計は問題数と一致しません。
  同じ問題を何度解いても、直近の1回だけを数えます。
</p>`;

  app().innerHTML = shell('弱点', '', body, '', 'weak');
  bindNav();

  document.querySelectorAll<HTMLElement>('.b-grp > button[data-grp]').forEach((b) => {
    b.onclick = () => {
      const code = b.dataset.grp!;
      state.openGroup = state.openGroup === code ? null : code;
      renderWeakness(groups);
    };
  });
  document.querySelectorAll<HTMLElement>('.b-grp .go[data-type]').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      cfg.kind = 'type';
      cfg.focusType = b.dataset.type!;
      saveCfg();
      void startTest();
    };
  });
}

// ── 入口 ────────────────────────────────────────────────────────────────────

export async function initBas(): Promise<void> {
  injectStyles();
  loadCfg();
  await showHome();
}
