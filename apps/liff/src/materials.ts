/**
 * LIFF 授業教材ページ（受講生専用）
 *
 * リッチメニューの「授業教材」から開く。授業のあとに講師が公開した教材だけが並ぶ。
 *
 *   https://liff.line.me/{LIFF_ID}?page=materials
 *
 * 誰の教材を出すかは**サーバーが idToken から決める**。こちらから生徒を指定しない。
 * 中身は eijakuniki.com 側の棚にあり、ここはリンクを並べるだけ。
 * 配色・組み方は単語テスト（vocab.ts）と揃えている。同じリッチメニューから飛ぶ2枚が
 * バラバラだと、別のサービスに見えてしまう。
 */

declare const liff: {
  getIDToken(): string | null;
  isInClient(): boolean;
  openWindow(opts: { url: string; external?: boolean }): void;
};

const API_URL = import.meta.env?.VITE_API_URL || 'http://localhost:8787';

interface MaterialFile {
  title: string;
  url: string;
  date: string;
}
interface MaterialSet {
  name: string;
  releasedAt: number;
  files: MaterialFile[];
}

async function api<T>(path: string): Promise<T> {
  const idToken = liff.getIDToken();
  const res = await fetch(`${API_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error || `通信に失敗しました（${res.status}）`);
  return body;
}

// ── スタイル ────────────────────────────────────────────────────────────────
// 変数名と値は vocab.ts と同じ。片方だけ色を変えないこと。

function injectStyles(): void {
  if (document.getElementById('materials-styles')) return;
  const el = document.createElement('style');
  el.id = 'materials-styles';
  el.textContent = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&family=Noto+Sans+JP:wght@400;500;700&display=swap');
:root{
  --bg:#0B0C0E; --surface:#141619; --surface2:#1C1F23;
  --line:#26292E; --line2:#33373D;
  --fg:#F2F3F5; --fg2:#A0A6AF; --fg3:#6B7280;
  --accent:#5BF0C0; --accent2:#0B0C0E;
  --ok:#5BF0C0; --ng:#FF6B6B;
  --r:10px;
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

.m-top{background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:blur(14px);
  border-bottom:1px solid var(--line);padding:11px 16px;display:flex;align-items:center;gap:12px;
  position:sticky;top:0;z-index:5}
.m-top .ttl{font-size:15px;font-weight:700;letter-spacing:-.02em;white-space:nowrap;
  display:flex;align-items:center;gap:8px}
.m-top .ttl::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent);
  box-shadow:0 0 10px var(--accent)}
.m-top .cnt{margin-left:auto;font-family:"JetBrains Mono",monospace;font-size:12.5px;font-weight:500;
  color:var(--fg2);border:1px solid var(--line2);padding:2px 10px;border-radius:99px;white-space:nowrap}

.m-wrap{max-width:860px;margin:0 auto;padding:18px 14px 40px}
h1{font-size:24px;font-weight:800;letter-spacing:-.03em;margin:6px 0 4px}
.m-sub{font-size:13px;color:var(--fg2);margin:0 0 18px}

.m-set{background:var(--surface);border:1px solid var(--line);border-radius:12px;
  margin:0 0 12px;overflow:hidden}
.m-set h3{margin:0;padding:12px 15px;font-size:13.5px;font-weight:600;color:var(--fg2);
  border-bottom:1px solid var(--line);display:flex;align-items:baseline;gap:10px;line-height:1.5}
.m-set h3 .t{flex:1;min-width:0;overflow-wrap:anywhere}
.m-set h3 em{font-family:"JetBrains Mono",monospace;font-size:10.5px;font-style:normal;
  color:var(--fg3);margin-left:auto;white-space:nowrap;flex:none}
.m-set ul{margin:0;padding:0;list-style:none}
.m-set li{border-bottom:1px solid var(--line)}
.m-set li:last-child{border-bottom:none}
.m-set a{display:flex;align-items:center;gap:12px;padding:15px;
  color:var(--fg);text-decoration:none;font-size:15.5px;font-weight:600;letter-spacing:-.015em}
.m-set a .nm{flex:1;min-width:0;overflow-wrap:anywhere;line-height:1.5}
.m-set a:active{background:var(--surface2)}
.m-set .k{font-family:"JetBrains Mono",monospace;font-size:10px;font-weight:500;
  letter-spacing:.06em;color:var(--fg3);border:1px solid var(--line2);
  padding:4px 8px;border-radius:6px;flex:none}
.m-set .go{margin-left:auto;color:var(--fg3);font-size:17px;line-height:1;flex:none}

.m-empty{text-align:center;color:var(--fg2);font-size:14px;padding:56px 16px;line-height:2}
.m-empty b{display:block;color:var(--fg);font-size:16px;font-weight:700;
  letter-spacing:-.02em;margin-bottom:6px}
.m-err{border:1px solid color-mix(in srgb,var(--ng) 45%,transparent);
  background:color-mix(in srgb,var(--ng) 10%,transparent);color:var(--ng);
  border-radius:var(--r);padding:14px;font-size:14px;margin:0 0 12px;white-space:pre-wrap}
.m-note{font-size:12.5px;color:var(--fg3);line-height:1.7;margin:18px 0 0}
`;
  document.head.appendChild(el);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/** 公開した時刻はUTCのミリ秒。生徒には日本時間の日付だけ見せる。 */
function fmt(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts + 9 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
}

/** ファイル名から種類のラベルを作る。棚では「解説ノート」「確認テスト」で揃えている。 */
function kindOf(title: string): string {
  if (/確認テスト|テスト/.test(title)) return 'TEST';
  if (/ノート|解説/.test(title)) return 'NOTE';
  return 'PDF';
}

/** セット名の末尾に付く「（8/9）」は、右肩の日付と重複するので落とす。 */
function trimSetName(name: string): string {
  return name.replace(/[（(]\s*\d{1,2}\s*\/\s*\d{1,2}\s*[)）]\s*$/, '').trim() || name;
}

/**
 * ファイル名は「教材タイトル ＋ 解説ノート／確認テスト」で作られている。
 * セットの見出しに同じ教材タイトルが出ているので、重なる部分を落として短くする。
 * 落とした結果が空になるものは、そのまま出す（手で上げたファイルなど）。
 */
function shortTitle(title: string, setName: string): string {
  const base = trimSetName(setName);
  if (base && title.startsWith(base)) {
    const rest = title.slice(base.length).trim();
    if (rest) return rest;
  }
  return title;
}

export async function initMaterials(): Promise<void> {
  injectStyles();
  const root = document.getElementById('app') || document.body;
  const shell = (inner: string, count = '') =>
    `<div class="m-top"><span class="ttl">授業教材</span>` +
    (count ? `<span class="cnt">${count}</span>` : '') +
    `</div><div class="m-wrap">${inner}</div>`;

  root.innerHTML = shell('<div class="m-empty">読み込んでいます…</div>');

  let data: { linked: boolean; sets: MaterialSet[] };
  try {
    data = await api<{ linked: boolean; sets: MaterialSet[] }>('/api/eijaku/materials');
  } catch (e) {
    root.innerHTML = shell(`<div class="m-err">${esc((e as Error).message)}</div>`);
    return;
  }

  if (!data.sets.length) {
    root.innerHTML = shell(
      '<h1>授業教材</h1>' +
        '<p class="m-sub">授業で使った解説ノートと確認テストが並びます。</p>' +
        '<div class="m-empty"><b>まだ教材はありません</b>' +
        '授業が終わると、ここに追加されます。</div>',
    );
    return;
  }

  const total = data.sets.reduce((n, s) => n + s.files.length, 0);
  const sets = data.sets
    .map((s) => {
      const files = s.files
        .map(
          (f) =>
            `<li><a href="${esc(f.url)}" target="_blank" rel="noopener">` +
            `<span class="k">${kindOf(f.title)}</span>` +
            `<span class="nm">${esc(shortTitle(f.title, s.name))}</span>` +
            `<span class="go">›</span></a></li>`,
        )
        .join('');
      const when = fmt(s.releasedAt);
      return (
        `<div class="m-set"><h3><span class="t">${esc(trimSetName(s.name))}</span>` +
        (when ? `<em>${when}</em>` : '') +
        `</h3><ul>${files}</ul></div>`
      );
    })
    .join('');

  root.innerHTML = shell(
    '<h1>授業教材</h1>' +
      '<p class="m-sub">授業で使った解説ノートと確認テストです。いつでも見返せます。</p>' +
      sets +
      '<p class="m-note">タップするとPDFが開きます。端末に保存しておくと、通信がなくても読めます。</p>',
    `${total} 件`,
  );
}
