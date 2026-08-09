/**
 * LIFF 授業教材ページ（受講生専用）
 *
 * リッチメニューの「教材リスト」から開く。授業のあとに講師が公開した教材だけが並ぶ。
 *
 *   https://liff.line.me/{LIFF_ID}?page=materials
 *
 * 誰の教材を出すかは**サーバーが idToken から決める**。こちらから生徒を指定しない。
 * 中身は eijakuniki.com 側の棚にあり、ここはリンクを並べるだけ。
 * 配色は配られるPDF（紙色＋ラピス）に合わせている。
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

function injectStyles(): void {
  if (document.getElementById('materials-styles')) return;
  const el = document.createElement('style');
  el.id = 'materials-styles';
  el.textContent = `
@import url('https://fonts.googleapis.com/css2?family=Shippori+Mincho+B1:wght@600&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap');
:root{
  --paper:#F1F0EA; --card:#FBFAF6; --ink:#1C1E22; --ink2:#4A4F58; --ink3:#787E88;
  --lapis:#26406E; --rule:#D6D4CA;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
     font-family:"Zen Kaku Gothic New",-apple-system,"Hiragino Sans",sans-serif;
     line-height:1.8;-webkit-text-size-adjust:100%}
.mw{max-width:560px;margin:0 auto;padding:22px 18px 64px}
.mh{border-bottom:2px solid var(--ink);padding-bottom:14px;margin-bottom:22px}
.mh h1{font-family:"Shippori Mincho B1",serif;font-size:21px;font-weight:600;margin:0}
.mh p{margin:4px 0 0;font-size:13px;color:var(--ink2)}
.set{background:var(--card);border:1px solid var(--rule);margin:0 0 16px}
.set > h2{margin:0;background:var(--lapis);color:#fff;font-size:14px;font-weight:500;
          padding:9px 14px;line-height:1.55}
.set > h2 span{display:block;font-size:11px;opacity:.78;font-weight:400}
.set ul{list-style:none;margin:0;padding:0}
.set li{border-bottom:1px dotted var(--rule)}
.set li:last-child{border-bottom:none}
.set a{display:flex;align-items:center;gap:10px;padding:14px;
       color:var(--ink);text-decoration:none;font-size:15px;font-weight:500}
.set a:active{background:#F4F2EA}
.set .ic{flex:none;width:34px;height:34px;border-radius:6px;background:#F3ECD9;
         color:#9C7A21;display:flex;align-items:center;justify-content:center;
         font-size:10px;font-weight:700;letter-spacing:.04em}
.set .go{margin-left:auto;color:var(--ink3);font-size:18px;line-height:1}
.msg{text-align:center;color:var(--ink2);font-size:14px;padding:52px 20px;line-height:2}
.msg b{display:block;color:var(--ink);font-size:16px;margin-bottom:6px}
.err{border-left:3px solid #B3261E;background:#fff;padding:12px 14px;
     font-size:14px;color:#B3261E;margin:16px 0}
`;
  document.head.appendChild(el);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function fmt(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts + 9 * 3600 * 1000); // JST
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

export async function initMaterials(): Promise<void> {
  injectStyles();
  const root = document.getElementById('app') || document.body;
  root.innerHTML = '<div class="mw"><div class="msg">読み込んでいます…</div></div>';

  let data: { linked: boolean; sets: MaterialSet[] };
  try {
    data = await api<{ linked: boolean; sets: MaterialSet[] }>('/api/eijaku/materials');
  } catch (e) {
    root.innerHTML =
      `<div class="mw"><div class="err">${esc((e as Error).message)}</div></div>`;
    return;
  }

  const head =
    '<div class="mh"><h1>授業教材</h1>' +
    '<p>授業で使った解説ノートと確認テストです。いつでも見返せます。</p></div>';

  if (!data.sets.length) {
    root.innerHTML =
      `<div class="mw">${head}<div class="msg"><b>まだ教材はありません</b>` +
      '授業が終わると、ここに解説ノートと確認テストが並びます。</div></div>';
    return;
  }

  const sets = data.sets
    .map((s) => {
      const files = s.files
        .map((f) => {
          const label = /確認テスト/.test(f.title) ? 'テスト' : 'ノート';
          return (
            `<li><a href="${esc(f.url)}" target="_blank" rel="noopener">` +
            `<span class="ic">${label}</span>${esc(f.title)}<span class="go">›</span></a></li>`
          );
        })
        .join('');
      const when = fmt(s.releasedAt);
      return (
        `<div class="set"><h2>${esc(s.name)}` +
        (when ? `<span>${when}に公開</span>` : '') +
        `</h2><ul>${files}</ul></div>`
      );
    })
    .join('');

  root.innerHTML = `<div class="mw">${head}${sets}</div>`;
}
