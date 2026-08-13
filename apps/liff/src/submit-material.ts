/**
 * LIFF 教材提出ページ（受講生専用）
 *
 * 次の授業で扱ってほしい長文を、生徒が写真かPDFで出す。
 *
 *   https://liff.line.me/{LIFF_ID}?page=submit
 *
 * 誰の提出かは**サーバーが idToken から決める**。名前の入力欄は置かない。
 * 配色・組み方は授業教材（materials.ts）と揃えている。同じリッチメニューから
 * 飛ぶ画面がバラバラだと、別のサービスに見えてしまう。
 */

declare const liff: {
  getIDToken(): string | null;
  isInClient(): boolean;
  closeWindow(): void;
};

const API_URL = import.meta.env?.VITE_API_URL || 'http://localhost:8787';

const MAX_FILES = 10;
const MAX_BYTES = 20 * 1024 * 1024;
/**
 * 端末によっては MIME を空や octet-stream で寄こす（Android × docx で起きる）ので、
 * accept には拡張子も並べる。最終判定はサーバー側（resolveType）。
 */
const ACCEPT = [
  'image/*',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
  '.pdf',
  '.docx',
  '.doc',
  '.txt',
  '.md',
].join(',');

/** 受け取れる拡張子。MIME が当てにならない端末のために、こちら側でも見る。 */
const ALLOWED_EXT = ['png', 'jpg', 'jpeg', 'webp', 'heic', 'heif', 'pdf', 'docx', 'doc', 'txt', 'md'];

/** 選んだファイルはここに溜める。input の FileList は追加選択で上書きされるので直接使わない。 */
let picked: File[] = [];

function injectStyles(): void {
  if (document.getElementById('submit-material-styles')) return;
  const el = document.createElement('style');
  el.id = 'submit-material-styles';
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

.s-top{background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:blur(14px);
  border-bottom:1px solid var(--line);padding:11px 16px;display:flex;align-items:center;gap:12px;
  position:sticky;top:0;z-index:5}
.s-top .ttl{font-size:15px;font-weight:700;letter-spacing:-.02em;white-space:nowrap;
  display:flex;align-items:center;gap:8px}
.s-top .ttl::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent);
  box-shadow:0 0 10px var(--accent)}
.s-top .cnt{margin-left:auto;font-family:"JetBrains Mono",monospace;font-size:12.5px;font-weight:500;
  color:var(--fg2);border:1px solid var(--line2);padding:2px 10px;border-radius:99px;white-space:nowrap}

.s-wrap{max-width:860px;margin:0 auto;padding:18px 14px 40px}
h1{font-size:24px;font-weight:800;letter-spacing:-.03em;margin:6px 0 4px}
.s-sub{font-size:13px;color:var(--fg2);margin:0 0 18px}

.s-drop{background:var(--surface);border:1.5px dashed var(--line2);border-radius:12px;
  padding:28px 16px;text-align:center;cursor:pointer;transition:border-color .15s,background .15s}
.s-drop:active{background:var(--surface2);border-color:var(--accent)}
.s-drop b{display:block;font-size:15.5px;font-weight:700;letter-spacing:-.02em;margin-bottom:4px}
.s-drop span{font-size:12.5px;color:var(--fg3);line-height:1.7}
input[type=file]{display:none}

.s-list{list-style:none;margin:12px 0 0;padding:0;
  background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.s-list:empty{display:none}
.s-list li{display:flex;align-items:center;gap:12px;padding:13px 15px;
  border-bottom:1px solid var(--line);font-size:14.5px;font-weight:600;letter-spacing:-.015em}
.s-list li:last-child{border-bottom:none}
.s-list .k{font-family:"JetBrains Mono",monospace;font-size:10px;font-weight:500;
  letter-spacing:.06em;color:var(--fg3);border:1px solid var(--line2);
  padding:4px 8px;border-radius:6px;flex:none}
.s-list .nm{flex:1;min-width:0;overflow-wrap:anywhere;line-height:1.5}
.s-list .sz{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--fg3);flex:none}
.s-list .rm{border:none;background:transparent;color:var(--fg3);font-size:20px;line-height:1;
  padding:0 2px;cursor:pointer;flex:none;font-family:inherit}
.s-list .rm:active{color:var(--ng)}

.s-field{margin:18px 0 0}
.s-field label{display:block;font-size:13px;font-weight:600;color:var(--fg2);margin-bottom:7px}
textarea{width:100%;min-height:96px;resize:vertical;padding:13px;
  background:var(--surface);color:var(--fg);border:1px solid var(--line);border-radius:var(--r);
  font-family:inherit;font-size:15px;line-height:1.7;outline:none;transition:border-color .15s}
textarea:focus{border-color:var(--accent)}
textarea::placeholder{color:var(--fg3)}

.s-send{width:100%;margin:20px 0 0;padding:15px;border:none;border-radius:var(--r);
  background:var(--accent);color:var(--accent2);font-family:inherit;
  font-size:16px;font-weight:800;letter-spacing:-.02em;cursor:pointer;transition:opacity .15s}
.s-send:active{opacity:.85}
.s-send:disabled{background:var(--surface2);color:var(--fg3);cursor:not-allowed}

.s-err{border:1px solid color-mix(in srgb,var(--ng) 45%,transparent);
  background:color-mix(in srgb,var(--ng) 10%,transparent);color:var(--ng);
  border-radius:var(--r);padding:14px;font-size:14px;margin:12px 0 0;white-space:pre-wrap}
.s-note{font-size:12.5px;color:var(--fg3);line-height:1.7;margin:18px 0 0}

.s-done{text-align:center;color:var(--fg2);font-size:14px;padding:56px 16px;line-height:2}
.s-done .ic{width:60px;height:60px;border-radius:50%;background:var(--accent);color:var(--accent2);
  font-size:30px;line-height:60px;margin:0 auto 16px}
.s-done b{display:block;color:var(--fg);font-size:18px;font-weight:800;
  letter-spacing:-.02em;margin-bottom:6px}
.s-close{margin:26px auto 0;display:block;padding:13px 30px;border-radius:var(--r);
  border:1px solid var(--line2);background:transparent;color:var(--fg);
  font-family:inherit;font-size:15px;font-weight:700;cursor:pointer}
.s-close:active{background:var(--surface2)}
`;
  document.head.appendChild(el);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function extOf(f: File): string {
  return (f.name.split('.').pop() ?? '').toLowerCase();
}

function kindOf(f: File): string {
  const ext = extOf(f);
  if (f.type === 'application/pdf' || ext === 'pdf') return 'PDF';
  if (ext === 'docx' || ext === 'doc' || f.type.includes('word')) return 'DOC';
  if (ext === 'txt' || ext === 'md' || f.type.startsWith('text/')) return 'TXT';
  return 'IMG';
}

function isAccepted(f: File): boolean {
  return f.type.startsWith('image/') || ALLOWED_EXT.includes(extOf(f));
}

function sizeOf(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

export async function initSubmitMaterial(): Promise<void> {
  injectStyles();
  const root = document.getElementById('app') || document.body;

  picked = [];
  // 選び直しのたびに全体を描き直すので、入力途中のメモはここに退避しておく
  let keptNote = '';

  const shell = (inner: string, count = '') =>
    `<div class="s-top"><span class="ttl">教材を出す</span>` +
    (count ? `<span class="cnt">${count}</span>` : '') +
    `</div><div class="s-wrap">${inner}</div>`;

  function render(): void {
    root.innerHTML = shell(
      '<h1>教材を出す</h1>' +
        '<p class="s-sub">次の授業で扱ってほしい長文を送ってください。解説ノートと確認テストを作っておきます。</p>' +
        '<div class="s-drop" id="drop">' +
        '<b>ファイルを選ぶ</b>' +
        '<span>写真・PDF・Word（docx）どれでも大丈夫です<br>' +
        `問題集のページを撮った写真でもOK<br>${MAX_FILES}点まで／1点20MBまで</span>` +
        '</div>' +
        `<input type="file" id="file" accept="${ACCEPT}" multiple>` +
        '<ul class="s-list" id="list"></ul>' +
        '<div class="s-field">' +
        '<label for="note">伝えたいこと（任意）</label>' +
        '<textarea id="note" placeholder="例：設問3がまったく分かりませんでした。第2段落の途中から何を言っているのか見失います。"></textarea>' +
        '</div>' +
        '<div id="err"></div>' +
        '<button class="s-send" id="send" disabled>提出する</button>' +
        '<p class="s-note">写真で送るときは、ページ全体が入るように撮ってください。' +
        '文字が切れていると解説が作れません。<br>' +
        'PDFやWordがあるときは、写真よりそちらのほうが正確に読み取れます。</p>',
      picked.length ? `${picked.length} 点` : '',
    );

    const fileInput = document.getElementById('file') as HTMLInputElement;
    const drop = document.getElementById('drop') as HTMLDivElement;
    const list = document.getElementById('list') as HTMLUListElement;
    const send = document.getElementById('send') as HTMLButtonElement;
    const err = document.getElementById('err') as HTMLDivElement;
    const note = document.getElementById('note') as HTMLTextAreaElement;

    // 再描画で入力中のメモが消えないよう、退避した値を戻す
    note.value = keptNote;
    note.addEventListener('input', () => {
      keptNote = note.value;
    });

    drop.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', () => {
      const incoming = Array.from(fileInput.files ?? []);
      const rejected: string[] = [];
      for (const f of incoming) {
        if (picked.length >= MAX_FILES) {
          rejected.push(`${f.name}（${MAX_FILES}点を超えます）`);
          continue;
        }
        if (f.size > MAX_BYTES) {
          rejected.push(`${f.name}（20MBを超えています）`);
          continue;
        }
        if (!isAccepted(f)) {
          rejected.push(`${f.name}（この形式は出せません）`);
          continue;
        }
        picked.push(f);
      }
      // input を空に戻す。同じファイルを選び直したときに change が飛ばなくなるため。
      fileInput.value = '';
      render();
      if (rejected.length) {
        const e = document.getElementById('err') as HTMLDivElement;
        e.innerHTML = `<div class="s-err">次のファイルは追加できませんでした：\n${esc(rejected.join('\n'))}</div>`;
      }
    });

    list.innerHTML = picked
      .map(
        (f, i) =>
          `<li><span class="k">${kindOf(f)}</span>` +
          `<span class="nm">${esc(f.name || `無題${i + 1}`)}</span>` +
          `<span class="sz">${sizeOf(f.size)}</span>` +
          `<button class="rm" data-i="${i}" aria-label="削除">×</button></li>`,
      )
      .join('');

    list.querySelectorAll<HTMLButtonElement>('.rm').forEach((btn) => {
      btn.addEventListener('click', () => {
        picked.splice(Number(btn.dataset.i), 1);
        render();
      });
    });

    send.disabled = picked.length === 0;
    send.addEventListener('click', async () => {
      send.disabled = true;
      send.textContent = '送っています…';
      err.innerHTML = '';

      const fd = new FormData();
      for (const f of picked) fd.append('files', f);
      if (note.value.trim()) fd.append('note', note.value.trim());

      try {
        const idToken = liff.getIDToken();
        const res = await fetch(`${API_URL}/api/eijaku/submissions`, {
          method: 'POST',
          // Content-Type は指定しない。multipart の boundary はブラウザに付けさせる。
          headers: idToken ? { Authorization: `Bearer ${idToken}` } : {},
          body: fd,
        });
        const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
        if (!res.ok || !body.success) throw new Error(body.error || `送信に失敗しました（${res.status}）`);
        done();
      } catch (e) {
        err.innerHTML = `<div class="s-err">${esc((e as Error).message)}</div>`;
        send.disabled = false;
        send.textContent = '提出する';
      }
    });
  }

  function done(): void {
    picked = [];
    keptNote = '';
    root.innerHTML = shell(
      '<div class="s-done"><div class="ic">✓</div>' +
        '<b>提出しました</b>' +
        '受け取りました。授業までに目を通しておきます。<br>そのまま閉じて大丈夫です。' +
        '</div>' +
        '<button class="s-close" id="close">閉じる</button>',
    );
    document.getElementById('close')?.addEventListener('click', () => {
      if (liff.isInClient()) liff.closeWindow();
    });
  }

  render();
}
