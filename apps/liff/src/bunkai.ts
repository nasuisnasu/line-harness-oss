/**
 * LIFF 古文の品詞分解チェッカー（受講生専用）
 *
 *   https://liff.line.me/{LIFF_ID}?page=bunkai&liffId={LIFF_ID}
 *
 * 生徒が古文を入れると、品詞分解・文法事項・判断の根拠・訳のニュアンスが出る。
 * **自分で分解したものと突き合わせて使う道具**なので、答えを出すだけでなく
 * 「なぜそう判断したか」を必ず並べて見せる。
 *
 * 配色・組み方は単語テスト（vocab.ts）／文法テスト（grammar.ts）と揃える。
 * 同じリッチメニューから飛ぶ画面がバラバラだと別のサービスに見える。
 * 共通の CSS は test-style.ts。**片方だけ色やサイズを変えないこと。**
 *
 * ★ 他のテストと違い、1回ごとに費用がかかる（サーバーが Claude を叩く）。
 *   画面にも残り回数を出して、生徒が「無限に押せるもの」だと思わないようにする。
 */

import { injectTestStyles } from './test-style.js';

declare const liff: {
  getIDToken(): string | null;
  isInClient(): boolean;
};

const API_URL = import.meta.env?.VITE_API_URL || 'http://localhost:8787';

/** デプロイの取り違えを画面から見分けるための刻印。deploy のたびに上げる。 */
const BUILD = '2026-08-30a';

// ── 型（サーバーの PARSE_SCHEMA と対応。片方だけ変えないこと） ──────────────

interface Morpheme {
  surface: string;
  base: string;
  pos: string;
  detail: string;
  conjugation: string;
  reason: string;
  uncertain: boolean;
}
interface GrammarPoint {
  name: string;
  target: string;
  explanation: string;
}
interface ParseResult {
  is_kobun: boolean;
  note: string;
  morphemes: Morpheme[];
  grammar_points: GrammarPoint[];
  translation: string;
  translation_notes: Array<{ target: string; note: string }>;
}
interface ParseResponse {
  parse_id: number | null;
  text: string;
  result: ParseResult;
  cached: boolean;
  remaining?: number;
}
interface Quota {
  limit: number;
  used: number;
  remaining: number;
  max_chars: number;
}
interface HistoryItem {
  parse_id: number;
  text: string;
  created_at: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const idToken = liff.getIDToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      ...(init?.headers || {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error || `通信に失敗しました（${res.status}）`);
  return body;
}

// ── スタイル ────────────────────────────────────────────────────────────────
// 共通の CSS（test-style.ts）を入れたうえで、このページのぶんだけ足す。

function injectStyles(): void {
  if (document.getElementById('bunkai-page-styles')) return;
  const el = document.createElement('style');
  el.id = 'bunkai-page-styles';
  el.textContent = `
.b-in{width:100%;min-height:104px;background:var(--surface);color:var(--fg);
  border:1px solid var(--line2);border-radius:var(--r);padding:13px 14px;
  font-family:"Noto Sans JP",-apple-system,"Hiragino Sans",serif;
  font-size:17px;line-height:1.9;resize:vertical;outline:none}
.b-in:focus{border-color:var(--lime)}
.b-in::placeholder{color:var(--fg3)}
.b-meta{display:flex;align-items:center;gap:10px;margin:8px 0 14px;font-size:12.5px;color:var(--fg3)}
.b-meta .over{color:var(--ng)}
.b-meta .rest{margin-left:auto}

/* 分解の1語。横並びの表にしない。スマホの幅では必ず折れて読めなくなる。
   1語 = 1ブロックにして、根拠を語の真下に置く。 */
.b-m{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);
  padding:12px 14px;margin-bottom:8px}
.b-m.unsure{border-color:#5A4B1E}
.b-m .hd{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px}
.b-m .sf{font-size:21px;font-weight:700;letter-spacing:.01em;
  font-family:"Noto Sans JP",-apple-system,"Hiragino Sans",serif}
.b-m .rd{font-size:12px;color:var(--fg3)}
.b-m .bs{font-size:12px;color:var(--fg3);margin-left:auto}
.b-tags{display:flex;flex-wrap:wrap;gap:5px;margin:9px 0 0}
.b-tag{font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:99px;
  border:1px solid var(--line2);color:var(--fg2);white-space:nowrap}
.b-tag.pos{border-color:var(--lime);color:var(--lime)}
.b-tag.cj{border-color:var(--blue);color:var(--blue)}
/* 根拠。ここがこのツールの中身なので、他より読みやすく組む。 */
.b-why{margin:10px 0 0;padding:9px 11px;background:var(--surface2);border-radius:8px;
  font-size:13.5px;line-height:1.8;color:var(--fg2)}
.b-why b{color:var(--fg);font-weight:600}
.b-flag{display:inline-block;font-size:11px;font-weight:700;color:#E8C15A;margin-left:6px}

.b-sec{margin:26px 0 0}
.b-sec > h2{font-size:13px;font-weight:700;letter-spacing:.06em;color:var(--fg3);
  margin:0 0 10px;text-transform:none}
.b-gp{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--accent);
  border-radius:var(--r);padding:12px 14px;margin-bottom:8px}
.b-gp .nm{font-size:15px;font-weight:700;margin:0 0 2px}
.b-gp .tg{font-size:12.5px;color:var(--lime);margin:0 0 7px;
  font-family:"Noto Sans JP",-apple-system,"Hiragino Sans",serif}
.b-gp .ex{font-size:13.5px;line-height:1.85;color:var(--fg2);margin:0}

.b-tr{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);
  padding:14px 15px;font-size:16px;line-height:1.95;
  font-family:"Noto Sans JP",-apple-system,"Hiragino Sans",serif}
.b-nt{border-top:1px solid var(--line);margin-top:12px;padding-top:11px}
.b-nt:first-child{border-top:0;margin-top:0;padding-top:0}
.b-nt .tg{font-size:12.5px;font-weight:700;color:var(--lime);margin:0 0 3px;}
.b-nt .nt{font-size:13.5px;line-height:1.8;color:var(--fg2);margin:0}

.b-src{background:var(--surface2);border-radius:var(--r);padding:12px 14px;margin:0 0 18px;
  font-size:17px;line-height:1.95;
  font-family:"Noto Sans JP",-apple-system,"Hiragino Sans",serif}

.b-hist{margin:28px 0 0}
.b-hist button{display:block;width:100%;text-align:left;background:var(--surface);
  border:1px solid var(--line);border-radius:var(--r);padding:11px 13px;margin-bottom:6px;
  color:var(--fg2);font-size:14px;line-height:1.6;cursor:pointer;
  font-family:"Noto Sans JP",-apple-system,"Hiragino Sans",serif;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.b-hist button:active{background:var(--surface2)}

.b-err{background:color-mix(in srgb,var(--ng) 12%,var(--surface));border:1px solid var(--ng);
  border-radius:var(--r);padding:12px 14px;color:var(--fg);font-size:14px;line-height:1.7;margin:0 0 16px}
.b-wait{text-align:center;padding:40px 16px;color:var(--fg2);font-size:14px;line-height:1.9}
.b-wait .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--lime);
  margin:0 3px;animation:bdot 1.2s infinite ease-in-out}
.b-wait .dot:nth-child(2){animation-delay:.15s}
.b-wait .dot:nth-child(3){animation-delay:.3s}
@keyframes bdot{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-4px)}}
.b-build{text-align:center;color:var(--fg3);font-size:11px;margin:32px 0 0}
`;
  document.head.appendChild(el);
}

// ── 小道具 ──────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]!,
  );
}

/** 改行を <br> に。本文は縦の切れ目が意味を持つので潰さない。 */
function nl2br(s: string): string {
  return esc(s).replace(/\n/g, '<br>');
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ── 描画 ────────────────────────────────────────────────────────────────────

function morphemeHtml(m: Morpheme): string {
  const tags = [
    m.pos ? `<span class="b-tag pos">${esc(m.pos)}</span>` : '',
    m.conjugation ? `<span class="b-tag cj">${esc(m.conjugation)}</span>` : '',
    m.detail ? `<span class="b-tag">${esc(m.detail)}</span>` : '',
  ]
    .filter(Boolean)
    .join('');

  return `
<div class="b-m${m.uncertain ? ' unsure' : ''}">
  <div class="hd">
    <span class="sf">${esc(m.surface)}</span>
    ${m.base ? `<span class="bs">基本形 ${esc(m.base)}</span>` : ''}
  </div>
  ${tags ? `<div class="b-tags">${tags}</div>` : ''}
  ${
    m.reason
      ? `<p class="b-why"><b>なぜ</b> ${esc(m.reason)}${
          m.uncertain ? '<span class="b-flag">要確認</span>' : ''
        }</p>`
      : ''
  }
</div>`;
}

function resultHtml(data: ParseResponse): string {
  const r = data.result;

  if (!r.is_kobun) {
    return `<div class="b-err">${esc(r.note || '古文として分解できませんでした')}</div>`;
  }

  const morphemes = r.morphemes.map(morphemeHtml).join('');

  const points = r.grammar_points.length
    ? `<div class="b-sec">
         <h2>使われている文法事項</h2>
         ${r.grammar_points
           .map(
             (g) => `<div class="b-gp">
               <p class="nm">${esc(g.name)}</p>
               ${g.target ? `<p class="tg">${esc(g.target)}</p>` : ''}
               <p class="ex">${esc(g.explanation)}</p>
             </div>`,
           )
           .join('')}
       </div>`
    : '';

  const notes = r.translation_notes.length
    ? `<div class="b-sec">
         <h2>訳すときのニュアンス</h2>
         <div class="b-tr">
           ${r.translation_notes
             .map(
               (n) => `<div class="b-nt">
                 <p class="tg">${esc(n.target)}</p>
                 <p class="nt">${esc(n.note)}</p>
               </div>`,
             )
             .join('')}
         </div>
       </div>`
    : '';

  return `
<div class="b-src">${nl2br(data.text)}</div>
<div class="b-sec"><h2>品詞分解</h2>${morphemes}</div>
${points}
${
  r.translation
    ? `<div class="b-sec"><h2>現代語訳</h2><div class="b-tr">${nl2br(r.translation)}</div></div>`
    : ''
}
${notes}`;
}

// ── 本体 ────────────────────────────────────────────────────────────────────

export async function initBunkai(): Promise<void> {
  injectTestStyles('bunkai-styles');
  injectStyles();

  const app = document.getElementById('app');
  if (!app) return;

  let quota: Quota = { limit: 20, used: 0, remaining: 20, max_chars: 300 };
  let history: HistoryItem[] = [];
  let busy = false;

  // 残り回数と履歴は無くても本体は使えるので、失敗しても画面は出す。
  await Promise.all([
    api<{ quota?: Quota } & Quota>('/api/bunkai/quota')
      .then((q) => {
        quota = { limit: q.limit, used: q.used, remaining: q.remaining, max_chars: q.max_chars };
      })
      .catch(() => {}),
    api<{ items: HistoryItem[] }>('/api/bunkai/history')
      .then((h) => {
        history = h.items || [];
      })
      .catch(() => {}),
  ]);

  function shell(): void {
    app!.innerHTML = `
<div class="v-top">
  <div class="ttl">古文 品詞分解</div>
  <div class="cnt" id="b-quota">残り ${quota.remaining}/${quota.limit}</div>
</div>
<div class="v-wrap">
  <h1>品詞分解して確かめる</h1>
  <p class="v-sub">自分で分解してから貼ると、どこがズレているかが見えます</p>

  <textarea class="b-in" id="b-text" placeholder="例）今は昔、竹取の翁といふ者ありけり。"></textarea>
  <div class="b-meta">
    <span id="b-count">0 / ${quota.max_chars}</span>
    <span class="rest">一文ずつが正確です</span>
  </div>
  <button class="v-go" id="b-go">分解する</button>

  <div id="b-out"></div>

  ${
    history.length
      ? `<div class="b-hist">
           <div class="b-sec"><h2>調べた文</h2>
             ${history
               .map(
                 (h) =>
                   `<button data-id="${h.parse_id}">${fmtDate(h.created_at)}　${esc(
                     h.text.slice(0, 40),
                   )}${h.text.length > 40 ? '…' : ''}</button>`,
               )
               .join('')}
           </div>
         </div>`
      : ''
  }
  <p class="b-build">build ${BUILD}</p>
</div>`;

    const ta = document.getElementById('b-text') as HTMLTextAreaElement;
    const cnt = document.getElementById('b-count')!;
    ta.addEventListener('input', () => {
      const n = ta.value.trim().length;
      cnt.textContent = `${n} / ${quota.max_chars}`;
      cnt.className = n > quota.max_chars ? 'over' : '';
    });

    document.getElementById('b-go')!.addEventListener('click', () => run(ta.value));

    document.querySelectorAll<HTMLButtonElement>('.b-hist button').forEach((btn) => {
      btn.addEventListener('click', () => openSaved(Number(btn.dataset.id)));
    });
  }

  function setQuota(remaining: number | undefined): void {
    if (remaining === undefined) return;
    quota.remaining = remaining;
    const el = document.getElementById('b-quota');
    if (el) el.textContent = `残り ${remaining}/${quota.limit}`;
  }

  function show(html: string): void {
    const out = document.getElementById('b-out');
    if (out) out.innerHTML = html;
  }

  function waiting(): void {
    // 分解には十数秒かかる。**押したのに何も起きない時間**を作らないこと。
    // 生徒が二度押しして、そのぶん課金されるのがいちばん避けたい。
    show(`<div class="b-wait">
      <div><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
      分解しています<br><span style="color:var(--fg3);font-size:12.5px">15秒ほどかかります</span>
    </div>`);
  }

  function lock(on: boolean): void {
    busy = on;
    const go = document.getElementById('b-go') as HTMLButtonElement | null;
    if (go) {
      go.disabled = on;
      go.textContent = on ? '分解中…' : '分解する';
    }
  }

  async function run(raw: string): Promise<void> {
    if (busy) return;
    const text = raw.trim();
    if (!text) {
      show('<div class="b-err">古文を入力してください</div>');
      return;
    }
    if (text.length > quota.max_chars) {
      show(
        `<div class="b-err">${quota.max_chars}文字までです（いまは${text.length}文字）。一文ずつ区切って調べてください</div>`,
      );
      return;
    }

    lock(true);
    waiting();
    try {
      const data = await api<ParseResponse>('/api/bunkai/parse', {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      show(resultHtml(data));
      setQuota(data.remaining);
      document.getElementById('b-out')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      show(`<div class="b-err">${esc(err instanceof Error ? err.message : '失敗しました')}</div>`);
    } finally {
      lock(false);
    }
  }

  async function openSaved(id: number): Promise<void> {
    if (busy) return;
    lock(true);
    waiting();
    try {
      const data = await api<ParseResponse>(`/api/bunkai/parses/${id}`);
      show(resultHtml(data));
      const ta = document.getElementById('b-text') as HTMLTextAreaElement | null;
      if (ta) ta.value = data.text;
      document.getElementById('b-out')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      show(`<div class="b-err">${esc(err instanceof Error ? err.message : '失敗しました')}</div>`);
    } finally {
      lock(false);
    }
  }

  shell();
}
