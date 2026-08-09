/**
 * LIFF 単語テスト（受講生専用）
 *
 * URL: https://liff.line.me/{LIFF_ID}?page=vocab
 *
 * ホーム → 設定 → 出題 → 結果 → 記録 の5画面。
 * 出題まわりのロジックとデザインは vocab-test.html から移植している。
 *
 * 仕様の正本は `.company/英弱ニキ/lms/vocab/`。とくに次を守ること。
 *   - 習得率はホームの最上段（このツールを開く理由がそれなので）
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
}

interface Dashboard {
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

type Kind = 'normal' | 'review' | 'retry';

// ── 状態 ────────────────────────────────────────────────────────────────────

const cfg = {
  bookId: 0,
  from: 1,
  to: 20,
  lim: 20,
  fmt: 'choice' as 'choice' | 'recall',
  dir: 'ej' as 'ej' | 'je',
  ord: 'seq' as 'seq' | 'rnd',
  tmr: 0,
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
:root{
  --bg:#0B0C0E; --surface:#141619; --surface2:#1C1F23;
  --line:#26292E; --line2:#33373D;
  --fg:#F2F3F5; --fg2:#A0A6AF; --fg3:#6B7280;
  --accent:#5BF0C0; --accent2:#0B0C0E;
  --ok:#5BF0C0; --ng:#FF6B6B;
  --q:26px; --a:21px; --r:10px;
}
@media (prefers-color-scheme: light){
  :root{
    --bg:#FAFAFA; --surface:#FFFFFF; --surface2:#F4F5F6;
    --line:#E4E6E9; --line2:#D3D6DA;
    --fg:#0B0C0E; --fg2:#5B6169; --fg3:#8B919A;
    --accent:#0FA37F; --accent2:#FFFFFF;
    --ok:#0FA37F; --ng:#E03131;
  }
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--fg);
  font-family:"Inter","Noto Sans JP",-apple-system,"Hiragino Sans",sans-serif;
  font-size:16px;line-height:1.75;letter-spacing:-.005em;
  font-feature-settings:"palt" 1;-webkit-font-smoothing:antialiased}
button,input{font-family:inherit;font-size:inherit}
.v-top{background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:blur(14px);
  border-bottom:1px solid var(--line);padding:11px 16px;display:flex;align-items:center;gap:12px;
  position:sticky;top:0;z-index:5}
.v-top .ttl{font-size:15px;font-weight:700;letter-spacing:-.02em;white-space:nowrap;
  display:flex;align-items:center;gap:8px}
.v-top .ttl::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent);
  box-shadow:0 0 10px var(--accent)}
.v-top .rng{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--fg3);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.v-top .cnt{margin-left:auto;font-family:"JetBrains Mono",monospace;font-size:12.5px;font-weight:500;
  color:var(--fg2);border:1px solid var(--line2);padding:2px 10px;border-radius:99px;white-space:nowrap}
.v-bar{height:2px;background:var(--line)}
.v-bar i{display:block;height:100%;background:var(--accent);width:0;
  transition:width .25s cubic-bezier(.4,0,.2,1);box-shadow:0 0 12px var(--accent)}
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
.v-chip.on{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent);
  color:var(--accent);font-weight:600}
.v-chip:active{transform:scale(.97)}
.v-go{width:100%;margin-top:8px;padding:16px;border:none;background:var(--accent);color:var(--accent2);
  font-size:16px;font-weight:700;border-radius:10px;cursor:pointer;letter-spacing:-.01em}
.v-go:active{transform:scale(.99)}
.v-go:disabled{background:var(--line2);color:var(--fg3);cursor:default}
.v-ghost{width:100%;margin-top:8px;padding:14px;border:1px solid var(--line2);background:var(--surface2);
  color:var(--fg);font-size:15px;font-weight:600;border-radius:10px;cursor:pointer}
.v-ghost:active{transform:scale(.99)}
.v-books{display:flex;flex-wrap:wrap;gap:8px}
.v-book{border:1px solid var(--line2);background:var(--surface2);color:var(--fg2);
  padding:10px 14px;border-radius:10px;cursor:pointer;font-size:14px;font-weight:500;
  text-align:left;line-height:1.35}
.v-book.on{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent);
  color:var(--accent);font-weight:600}
.v-book em{display:block;font-family:"JetBrains Mono",monospace;font-size:10.5px;
  font-style:normal;color:var(--fg3);margin-top:2px;letter-spacing:.03em}
.v-book.on em{color:color-mix(in srgb,var(--accent) 72%,var(--fg3))}

/* ── 習得率 ── */
.v-mastery{border:1px solid var(--line);background:var(--surface);border-radius:14px;
  padding:18px 16px;margin:0 0 12px}
.v-mastery .nm{font-size:13.5px;color:var(--fg2);font-weight:600;margin-bottom:8px}
.v-mastery .big{display:flex;align-items:baseline;gap:12px}
.v-mastery .big b{font-family:"JetBrains Mono",monospace;font-size:40px;font-weight:700;
  color:var(--accent);line-height:1;letter-spacing:-.03em}
.v-mastery .big span{font-family:"JetBrains Mono",monospace;font-size:13px;color:var(--fg2)}
.v-mbar{height:8px;background:var(--surface2);border:1px solid var(--line2);border-radius:99px;
  margin:14px 0 8px;overflow:hidden;display:flex}
.v-mbar i{display:block;height:100%;background:var(--accent);box-shadow:0 0 10px var(--accent)}
.v-mbar u{display:block;height:100%;background:color-mix(in srgb,var(--ng) 30%,transparent)}
.v-mlegend{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--fg3);letter-spacing:.02em}

.v-lead{border:1px solid var(--line);background:var(--surface);border-radius:14px;
  padding:16px;margin:0 0 12px}
.v-lead .cap{font-size:13px;color:var(--fg2);margin-bottom:6px}
.v-lead .n{font-family:"JetBrains Mono",monospace;font-size:32px;font-weight:700;
  color:var(--fg);line-height:1.1;letter-spacing:-.03em}
.v-lead .n em{font-style:normal;font-size:14px;color:var(--fg2);margin-left:4px}

.v-spark{display:block;width:100%;height:52px;margin:8px 0 4px}
.v-stats{display:flex;gap:10px;flex-wrap:wrap}
.v-stat{flex:1;min-width:92px;border:1px solid var(--line);background:var(--surface);
  border-radius:var(--r);padding:13px 14px}
.v-stat b{display:block;font-family:"JetBrains Mono",monospace;font-size:32px;font-weight:700;
  line-height:1.1;letter-spacing:-.03em}
.v-stat span{font-size:11.5px;color:var(--fg3)}

.v-list{background:var(--surface);border:1px solid var(--line);border-radius:12px;
  margin:0 0 12px;overflow:hidden}
.v-list h3{margin:0;padding:12px 15px;font-size:13px;font-weight:600;color:var(--fg2);
  border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px}
.v-list h3 em{font-family:"JetBrains Mono",monospace;font-size:10.5px;font-style:normal;
  color:var(--ng);border:1px solid color-mix(in srgb,var(--ng) 45%,transparent);
  padding:2px 9px;border-radius:99px}
.v-list h3.o em{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 45%,transparent)}
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

/* ── 出題 ── */
.v-stage{background:var(--surface);border:1px solid var(--line);border-radius:14px;
  padding:32px 20px;margin:0 0 12px;text-align:center;position:relative;overflow:hidden}
.v-stage::before{content:"";position:absolute;inset:0 0 auto 0;height:1px;
  background:linear-gradient(90deg,transparent,var(--accent),transparent);opacity:.55}
.v-tbar{position:absolute;top:0;left:0;right:0;height:3px;background:var(--line)}
.v-tbar i{display:block;height:100%;width:100%;background:var(--accent);
  transform-origin:left center;box-shadow:0 0 10px var(--accent);transition:background .2s}
.v-tbar.warn i{background:var(--ng);box-shadow:0 0 10px var(--ng)}
.v-tbar b{position:absolute;right:10px;top:9px;font-family:"JetBrains Mono",monospace;
  font-size:11px;font-weight:500;color:var(--fg3)}
.v-tbar.warn b{color:var(--ng)}
.v-qno{font-family:"JetBrains Mono",monospace;font-size:10.5px;letter-spacing:.2em;color:var(--fg3);
  font-weight:500;margin-bottom:14px}
.v-qword{font-size:var(--q);font-weight:700;line-height:1.35;letter-spacing:-.025em;word-break:break-word}
.v-reveal{margin-top:20px;padding-top:18px;border-top:1px solid var(--line)}
.v-aword{font-size:var(--a);font-weight:600;color:var(--accent);line-height:1.5}
.v-opts{display:grid;gap:8px;margin:20px 0 0}
.v-opt{display:flex;align-items:center;gap:12px;padding:14px;border:1px solid var(--line2);
  background:var(--surface2);color:var(--fg);border-radius:10px;cursor:pointer;
  text-align:left;font-size:16px;font-weight:500;transition:.14s;width:100%}
.v-opt .k{font-family:"JetBrains Mono",monospace;font-size:11px;font-weight:500;color:var(--fg3);
  border:1px solid var(--line2);width:23px;height:23px;border-radius:6px;display:flex;
  align-items:center;justify-content:center;flex:none}
.v-opt.ok{border-color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent);color:var(--ok)}
.v-opt.ok .k{border-color:var(--ok);color:var(--ok)}
.v-opt.ng{border-color:var(--ng);background:color-mix(in srgb,var(--ng) 12%,transparent);color:var(--ng)}
.v-opt.ng .k{border-color:var(--ng);color:var(--ng)}
.v-acts{display:flex;gap:8px;flex-wrap:wrap}
.v-acts button{flex:1;min-width:120px;padding:14px;border-radius:10px;cursor:pointer;
  font-size:15.5px;font-weight:600;border:1px solid var(--line2);
  background:var(--surface2);color:var(--fg)}
.v-acts button:active{transform:scale(.99)}
.v-acts .pri{background:var(--accent);border-color:var(--accent);color:var(--accent2);font-weight:700}
.v-acts .yes{border-color:color-mix(in srgb,var(--ok) 45%,transparent);color:var(--ok)}
.v-acts .no2{border-color:color-mix(in srgb,var(--ng) 45%,transparent);color:var(--ng)}
.v-abort{display:block;margin:16px auto 0;background:none;border:none;color:var(--fg3);
  font-size:12.5px;text-decoration:underline;cursor:pointer}

/* ── 結果 ── */
.v-score{display:flex;align-items:baseline;gap:14px;background:var(--surface);
  border:1px solid var(--line);border-radius:14px;padding:20px;margin:0 0 12px}
.v-score b{font-family:"JetBrains Mono",monospace;font-size:38px;font-weight:700;
  color:var(--accent);line-height:1;letter-spacing:-.03em}
.v-score span{font-size:13px;color:var(--fg2);font-family:"JetBrains Mono",monospace}
.v-delta{font-family:"JetBrains Mono",monospace;font-size:14px;color:var(--fg2)}
.v-delta b{color:var(--accent);font-size:20px;font-weight:700}
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
.v-blk .tr i{display:block;height:100%;background:var(--accent)}
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

function shell(title: string, sub: string, body: string, count = ''): string {
  return `
<div class="v-top">
  <span class="ttl">単語テスト</span>
  <span class="rng">${esc(sub)}</span>
  ${count ? `<span class="cnt">${esc(count)}</span>` : ''}
</div>
<div class="v-bar"><i id="vProg"></i></div>
<div class="v-wrap">${title ? `<h1>${esc(title)}</h1>` : ''}${body}</div>`;
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

function sparkline(rates: number[]): string {
  if (rates.length < 2) return '';
  const w = 300;
  const h = 52;
  const pad = 4;
  const step = (w - pad * 2) / (rates.length - 1);
  const pts = rates.map((r, i) => [pad + i * step, h - pad - r * (h - pad * 2)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return `<svg class="v-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.5" fill="var(--accent)"/>
  </svg>`;
}

function masteryCard(b: DashboardBook): string {
  const mastered = b.total ? (b.mastered / b.total) * 100 : 0;
  const unmastered = b.total ? (b.unmastered / b.total) * 100 : 0;
  return `
<div class="v-mastery">
  <div class="nm">${esc(b.name)}</div>
  <div class="big"><b>${pct(b.rate)}</b><span>${b.mastered} / ${b.total}</span></div>
  <div class="v-mbar">
    <i style="width:${mastered.toFixed(2)}%"></i><u style="width:${unmastered.toFixed(2)}%"></u>
  </div>
  <div class="v-mlegend">未習得 ${b.unmastered} ／ 未挑戦 ${b.untried}</div>
</div>`;
}

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

  const top = d.books[0];
  if (top && !cfg.bookId) cfg.bookId = top.id;

  const hasHistory = d.totals.sessions > 0;

  // 復習キュー
  const reviewBlock = top
    ? `<div class="v-lead">
         <div class="cap">まだ覚えてない語</div>
         <div class="n">${top.review_count}<em>語</em></div>
         <button class="v-go" id="vReview" ${top.review_count ? '' : 'disabled'}>
           ${top.review_count ? 'まとめて復習する' : 'いまのところありません'}
         </button>
       </div>`
    : '';

  // 最近の正答率 — 3セッション未満は数字を出さない
  const trendBlock = d.recent.enough
    ? `<div class="v-card">
         <span class="lg">最近の正答率</span>
         ${sparkline(d.recent.sessions.map((s) => s.rate))}
         <div class="v-mlegend">直近 ${d.recent.sessions.length} 回　最新 ${
           d.recent.latest_rate === null ? '—' : pct(d.recent.latest_rate)
         }</div>
       </div>`
    : `<div class="v-card">
         <span class="lg">最近の正答率</span>
         <p class="v-hint" style="margin:0">あと ${d.recent.needed} 回でグラフが出ます。</p>
       </div>`;

  const weakBlock = d.weak_words.length
    ? `<div class="v-list">
         <h3>よく間違える語</h3>
         <ul>${d.weak_words
           .map(
             (w) => `<li><span class="n">${no3(w.no)}</span><span class="e">${esc(w.en)}<span class="x">×${
               w.wrong
             }/${w.asked}</span></span><span class="j">${esc(w.ja)}</span></li>`,
           )
           .join('')}</ul>
       </div>`
    : '';

  const totalsBlock = hasHistory
    ? `<div class="v-stats">
         <div class="v-stat"><b>${d.totals.answers}</b><span>解いた問題</span></div>
         <div class="v-stat"><b>${d.totals.days}</b><span>学習日数</span></div>
         <div class="v-stat"><b>${d.totals.sessions}</b><span>実施回数</span></div>
       </div>`
    : '';

  const body = hasHistory
    ? d.books.filter((b) => b.mastered || b.unmastered || b.id === cfg.bookId).map(masteryCard).join('') +
      reviewBlock +
      '<button class="v-ghost" id="vStart">テストを始める</button>' +
      '<button class="v-ghost" id="vRecords">記録を見る</button>' +
      trendBlock +
      weakBlock +
      totalsBlock
    : // 空の状態。「記録がありません」で終わらせず、次にやることを出す。
      `<div class="v-lead">
         <div class="cap">はじめまして</div>
         <div class="n" style="font-size:20px;font-family:inherit;font-weight:700">まずは20語やってみましょう</div>
       </div>
       <button class="v-go" id="vStart">テストを始める</button>`;

  app().innerHTML = shell('', state.books.find((b) => b.id === cfg.bookId)?.name ?? '', body);

  const bind = (id: string, fn: () => void) => {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  };
  bind('vStart', () => renderSetup());
  bind('vRecords', () => void showRecords());
  bind('vReview', () => void startReview());
}

// ── 設定 ────────────────────────────────────────────────────────────────────

function renderSetup(): void {
  const book = state.books.find((b) => b.id === cfg.bookId) || state.books[0];
  if (!book) return;
  cfg.bookId = book.id;
  if (cfg.to > book.max_no) {
    cfg.from = 1;
    cfg.to = Math.min(20, book.max_no);
    cfg.lim = cfg.to;
  }

  const chip = (group: string, v: string, label: string, on: boolean) =>
    `<button class="v-chip${on ? ' on' : ''}" data-g="${group}" data-v="${v}">${esc(label)}</button>`;

  const sectionChips = book.sections
    .map((s) => `<button class="v-chip" data-sec="${s.from}-${s.to}">${esc(s.name.split(' ')[0] || s.name)}</button>`)
    .join('');

  const body = `
<div class="v-card">
  <span class="lg">Book</span>
  <div class="v-books">
    ${state.books
      .map(
        (b) =>
          `<button class="v-book${b.id === cfg.bookId ? ' on' : ''}" data-book="${b.id}">${esc(
            b.name,
          )}<em>${b.count} 語</em></button>`,
      )
      .join('')}
  </div>
</div>

<div class="v-card">
  <span class="lg">Range</span>
  <div class="v-row">
    <input class="v-num" id="vFrom" type="number" inputmode="numeric" min="1" max="${book.max_no}" value="${cfg.from}">
    <span class="v-hint">〜</span>
    <input class="v-num" id="vTo" type="number" inputmode="numeric" min="1" max="${book.max_no}" value="${cfg.to}">
    <span class="v-hint">番</span>
  </div>
  ${sectionChips ? `<div class="v-row" style="margin-top:10px">${sectionChips}</div>` : ''}
  <div class="v-row" style="margin-top:12px">
    <span class="v-hint">出題数</span>
    <input class="v-num" id="vLim" type="number" inputmode="numeric" min="1" max="100" value="${cfg.lim}">
    <span class="v-hint">問（最大100）</span>
  </div>
  <p class="v-hint" id="vRangeMastery" style="margin:12px 0 0"></p>
</div>

<div class="v-card">
  <span class="lg">Format</span>
  <div class="v-row">
    ${chip('fmt', 'choice', '4択', cfg.fmt === 'choice')}
    ${chip('fmt', 'recall', '意味を答える', cfg.fmt === 'recall')}
  </div>
  <div class="v-row" style="margin-top:10px">
    ${chip('dir', 'ej', '英 → 日', cfg.dir === 'ej')}
    ${chip('dir', 'je', '日 → 英', cfg.dir === 'je')}
  </div>
  <div class="v-row" style="margin-top:10px">
    ${chip('ord', 'seq', '番号順', cfg.ord === 'seq')}
    ${chip('ord', 'rnd', 'ランダム', cfg.ord === 'rnd')}
  </div>
</div>

<div class="v-card">
  <span class="lg">Timer</span>
  <div class="v-row">
    ${[0, 3, 5, 10, 15]
      .map((s) => chip('tmr', String(s), s ? `${s}秒` : 'なし', cfg.tmr === s))
      .join('')}
  </div>
</div>

<p class="v-err v-hide" id="vMsg"></p>
<button class="v-go" id="vBegin">はじめる</button>
<button class="v-ghost" id="vBack">ホームに戻る</button>`;

  app().innerHTML = shell('', book.name, body);

  document.querySelectorAll<HTMLElement>('.v-book').forEach((b) => {
    b.onclick = () => {
      cfg.bookId = Number(b.dataset.book);
      renderSetup();
    };
  });
  document.querySelectorAll<HTMLElement>('.v-chip[data-g]').forEach((b) => {
    b.onclick = () => {
      const g = b.dataset.g!;
      document.querySelectorAll<HTMLElement>(`.v-chip[data-g="${g}"]`).forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      if (g === 'tmr') cfg.tmr = Number(b.dataset.v);
      else if (g === 'fmt') cfg.fmt = b.dataset.v as 'choice' | 'recall';
      else if (g === 'dir') cfg.dir = b.dataset.v as 'ej' | 'je';
      else if (g === 'ord') cfg.ord = b.dataset.v as 'seq' | 'rnd';
    };
  });
  document.querySelectorAll<HTMLElement>('.v-chip[data-sec]').forEach((b) => {
    b.onclick = () => {
      const [f, t] = b.dataset.sec!.split('-').map(Number);
      (document.getElementById('vFrom') as HTMLInputElement).value = String(f);
      (document.getElementById('vTo') as HTMLInputElement).value = String(t);
      syncRange();
    };
  });

  const syncRange = () => {
    const f = Number((document.getElementById('vFrom') as HTMLInputElement).value) || 1;
    const t = Number((document.getElementById('vTo') as HTMLInputElement).value) || 1;
    cfg.from = Math.min(f, t);
    cfg.to = Math.max(f, t);
    const span = cfg.to - cfg.from + 1;
    const lim = document.getElementById('vLim') as HTMLInputElement;
    lim.value = String(Math.min(span, 100));
    cfg.lim = Number(lim.value);
    showRangeMastery();
  };
  (document.getElementById('vFrom') as HTMLInputElement).oninput = syncRange;
  (document.getElementById('vTo') as HTMLInputElement).oninput = syncRange;
  (document.getElementById('vLim') as HTMLInputElement).oninput = (e) => {
    cfg.lim = Number((e.target as HTMLInputElement).value) || 1;
  };

  document.getElementById('vBack')!.onclick = () => void showHome();
  document.getElementById('vBegin')!.onclick = () => void startNormal();
  showRangeMastery();
}

/** 範囲を選んだ時点で「その範囲の習得率」を出す。どこをやるかの判断材料になる。 */
function showRangeMastery(): void {
  const el = document.getElementById('vRangeMastery');
  if (!el || !state.dashboard) return;
  const b = state.dashboard.books.find((x) => x.id === cfg.bookId);
  if (!b || (!b.mastered && !b.unmastered)) {
    el.textContent = '';
    return;
  }
  el.textContent = `この単語帳の習得率 ${pct(b.rate)}（${b.mastered}/${b.total}）`;
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
      say('その範囲に語がありません。');
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

async function startReview(): Promise<void> {
  renderLoading();
  try {
    const res = await api<{ words: Word[] }>(`/api/vocab/review?book_id=${cfg.bookId}&limit=20`);
    if (!res.words.length) {
      await showHome();
      return;
    }
    state.decoys = [];
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
  }
  document.getElementById('vReveal')?.classList.remove('v-hide');
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
  <div class="v-opts${cfg.fmt === 'choice' ? '' : ' v-hide'}" id="vOpts"></div>
</div>
<div class="v-acts" id="vActs"></div>
<button class="v-abort" id="vAbort">中断する（記録は残りません）</button>`;

  app().innerHTML = shell('', '', body, `${state.idx + 1} / ${state.queue.length}`);
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

function renderChoice(w: Word, askEn: boolean): void {
  // ダミーは同じテストで出す語から作る。足りないぶんだけサーバーが補ってくれている。
  const others = state.pool.filter((x) => x.id !== w.id);
  const fallback = state.decoys.filter((x) => x.id !== w.id);
  const picked = shuffle(others.length >= 3 ? others : [...others, ...fallback]).slice(0, 3);
  const choices = shuffle([w, ...picked]);

  const opts = document.getElementById('vOpts')!;
  opts.innerHTML = choices
    .map(
      (c, i) =>
        `<button class="v-opt" data-id="${c.id}"><span class="k">${i + 1}</span><span>${esc(
          askEn ? c.ja : c.en,
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
  document.getElementById('vReveal')!.classList.remove('v-hide');
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
    // 習得率が変わったのでホームのキャッシュを捨てる
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

  const delta = r
    ? `<div class="v-card">
         <span class="lg">習得率</span>
         <div class="v-delta">${pct(r.mastery.before)} → <b>${pct(r.mastery.after)}</b>
           <span style="color:var(--fg3)">（${r.mastery.mastered}/${r.mastery.total}）</span></div>
         ${
           r.range_mastery
             ? `<div class="v-delta" style="margin-top:6px;font-size:12.5px">この範囲 ${pct(
                 r.range_mastery.before,
               )} → ${pct(r.range_mastery.after)}</div>`
             : ''
         }
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
${listBlock('できなかった', ng, false)}
${listBlock('できた', ok, true)}
<p class="v-hint" style="margin:0 0 8px">コピーは単語帳の番号順に並びます。</p>
<div class="v-cp">
  <button id="vCp1">できなかった語</button>
  <button id="vCp2">できた語</button>
  <button id="vCp3">結果を全部</button>
</div>
${ng.length ? '<button class="v-go" id="vAgain">できなかった語だけ、もう一度</button>' : ''}
<button class="v-ghost" id="vHome">ホームに戻る</button>`;

  app().innerHTML = shell('', '', body);
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
    ? `<div class="v-list"><h3>よく間違える語</h3>
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

  const body =
    (rec.sessions.length ? '' : '<p class="v-empty">まだ記録がありません。</p>') +
    history +
    weak +
    sections +
    (rec.sessions.length ? formats : '') +
    '<button class="v-ghost" id="vHome">ホームに戻る</button>';

  app().innerHTML = shell('', '記録', body);
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
