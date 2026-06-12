/**
 * LINE Harness LIFF — The single entry point
 *
 * This URL IS the friend-add URL. Every user enters through here.
 *
 * Flow:
 *   LIFF URL → LINE Login (auto in LINE app) → UUID issued
 *   → friendship check → not friend? show add button → friend added → Webhook → scenario enroll
 *   → already friend? → show completion
 *
 * Query params:
 *   ?ref=xxx     — attribution tracking (which LP/campaign)
 *   ?redirect=x  — redirect after linking (for wrapped URLs)
 *   ?page=book   — booking page (calendar slot picker)
 */

import { initBooking } from './booking.js';
import { initForm } from './form.js';
import { initEventBooking } from './event-booking.js';
import { initSendTemplate } from './send-template.js';
import { initEijaku } from './eijaku.js';

declare const liff: {
  init(config: { liffId: string }): Promise<void>;
  isLoggedIn(): boolean;
  login(opts?: { redirectUri?: string }): void;
  getProfile(): Promise<{ userId: string; displayName: string; pictureUrl?: string; statusMessage?: string }>;
  getIDToken(): string | null;
  getDecodedIDToken(): { sub: string; name?: string; email?: string; picture?: string } | null;
  getFriendship(): Promise<{ friendFlag: boolean }>;
  isInClient(): boolean;
  openWindow(opts: { url: string; external?: boolean }): void;
  closeWindow(): void;
};

const _rawParams = new URLSearchParams(window.location.search);
const _liffState = _rawParams.get('liff.state') || '';
const _stateParams = new URLSearchParams(_liffState.startsWith('?') ? _liffState.slice(1) : _liffState);
const LIFF_ID = _stateParams.get('liffId') || _rawParams.get('liffId') || import.meta.env?.VITE_LIFF_ID || '';
const API_URL = import.meta.env?.VITE_API_URL || 'http://localhost:8787';
const UUID_STORAGE_KEY = 'lh_uuid';
const _LIFF_BOT_MAP: Record<string, string> = {
  '2009821004-brTkmVVK': '@513qujqi',  // 大学受験攻略
  '2006855304-UfNPHFOn': '@893nrbyp',  // 元英弱ニキ
  '2009506707-tX5TQVsB': '@009rqkeq',  // 元英弱ニキ@受講生専用
};
const BOT_BASIC_ID = _stateParams.get('botId') || _rawParams.get('botId') || _LIFF_BOT_MAP[LIFF_ID] || import.meta.env?.VITE_BOT_BASIC_ID || '';

function apiCall(path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
}

function getPage(): string | null {
  const path = window.location.pathname.replace(/^\/+/, '');
  if (path === 'book') return 'book';
  const params = new URLSearchParams(window.location.search);
  return params.get('page');
}

// Snapshot the URL params synchronously at module load. liff.init() can
// rewrite or strip the `liff.state` parameter, so any later read could
// return null even though the deep-link originally carried `ref`.
// Mirror the liffId/botId extraction at the top of this file.
const _LIFF_STATE_RAW = _rawParams.get('liff.state') ?? '';
const _LIFF_STATE_PARAMS = new URLSearchParams(
  _LIFF_STATE_RAW.startsWith('?') ? _LIFF_STATE_RAW.slice(1) : _LIFF_STATE_RAW,
);
function _snapshotParam(name: string): string | null {
  const direct = _rawParams.get(name);
  if (direct) return direct;
  const fromState = _LIFF_STATE_PARAMS.get(name);
  if (fromState) return fromState;
  // LIFF SDK sometimes rewrites the URL to a hash route after init —
  // peek into window.location.hash too as a last-resort fallback.
  const hash = window.location.hash || '';
  const hashIdx = hash.indexOf('?');
  if (hashIdx >= 0) {
    const hashParams = new URLSearchParams(hash.slice(hashIdx + 1));
    const fromHash = hashParams.get(name);
    if (fromHash) return fromHash;
  }
  return null;
}
const _SNAPSHOT_REF = _snapshotParam('ref');
const _SNAPSHOT_REDIRECT = _snapshotParam('redirect');

function getRedirectUrl(): string | null {
  return _SNAPSHOT_REDIRECT;
}

function getRef(): string | null {
  return _SNAPSHOT_REF;
}

function getSavedUuid(): string | null {
  try {
    return localStorage.getItem(UUID_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveUuid(uuid: string): void {
  try {
    localStorage.setItem(UUID_STORAGE_KEY, uuid);
  } catch {
    // silent fail
  }
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── UI States ──────────────────────────────────────────

function showFriendAdd(profile: { displayName: string; pictureUrl?: string }) {
  const container = document.getElementById('app')!;
  const friendAddUrl = BOT_BASIC_ID
    ? `https://line.me/R/ti/p/${BOT_BASIC_ID}`
    : '#';

  container.innerHTML = `
    <div class="card">
      <div class="profile">
        ${profile.pictureUrl ? `<img src="${profile.pictureUrl}" alt="" />` : ''}
        <p class="name">${escapeHtml(profile.displayName)} さん</p>
      </div>
      <p class="message">まずは友だち追加をお願いします</p>
      <a href="${friendAddUrl}" class="add-friend-btn" id="addFriendBtn">
        友だち追加して始める
      </a>
      <p class="sub-message">追加後、この画面に戻ってきてください</p>
    </div>
  `;

  // 友だち追加後に戻ってきたら自動で再チェック
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      try {
        const { friendFlag } = await liff.getFriendship();
        if (friendFlag) {
          showCompletion(profile, false);
        }
      } catch {
        // ignore
      }
    }
  });
}

function showCompletion(profile: { displayName: string; pictureUrl?: string }, isRecovery: boolean) {
  const container = document.getElementById('app')!;
  container.innerHTML = `
    <div class="card">
      <div class="check-icon">✓</div>
      <h2>登録完了！</h2>
      <div class="profile">
        ${profile.pictureUrl ? `<img src="${profile.pictureUrl}" alt="" />` : ''}
        <p class="name">${escapeHtml(profile.displayName)} さん</p>
      </div>
      <p class="message">
        登録完了！<br>
        あと5秒で画面が切り替わります...
      </p>
    </div>
  `;

  // LINE内ブラウザならトーク画面を開いて閉じる
  if (liff.isInClient()) {
    setTimeout(() => {
      try {
        liff.openWindow({ url: `https://line.me/ti/p/${BOT_BASIC_ID}`, external: false });
      } catch { /* ignore */ }
      try { liff.closeWindow(); } catch { /* ignore */ }
    }, 5000);
  }
}

function showOpenInLineApp() {
  // Build the LIFF URL pointing back to the same page so tapping the button
  // reopens it in the LINE app. We preserve the current path query so the
  // page (form / event / send-template etc.) lands correctly.
  const search = window.location.search.startsWith('?')
    ? window.location.search.slice(1)
    : window.location.search;
  const lineAppUrl = `https://liff.line.me/${LIFF_ID}${search ? '?' + search : ''}`;
  // line:// スキーム経由のフォールバック。新規LIFFは Universal Link
  // 反映が遅れることがあるので、まず line:// で深いリンクを試して、
  // それが失敗したら https://liff.line.me/ にフォールバックする。
  const lineSchemeUrl = `line://app/${LIFF_ID}${search ? '?' + search : ''}`;
  const friendAddUrl = BOT_BASIC_ID ? `https://line.me/R/ti/p/${BOT_BASIC_ID}` : '';
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#f9fafb;">
      <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px 28px;max-width:400px;text-align:center;font-family:'Noto Sans JP','Hiragino Kaku Gothic ProN',sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.04);">
        <div style="width:56px;height:56px;margin:0 auto 16px;border-radius:50%;background:#dcfce7;display:flex;align-items:center;justify-content:center;font-size:28px;">📱</div>
        <h1 style="font-size:18px;font-weight:700;color:#111827;margin:0 0 12px;letter-spacing:0.02em;">LINEアプリで開いてください</h1>
        <p style="font-size:13px;color:#6b7280;line-height:1.7;margin:0 0 22px;">
          このページはLINEアプリ内で動作します。<br>
          下のボタンをタップして、LINEアプリで開き直してください。
        </p>
        <a href="${lineAppUrl}" id="openLineBtn" style="display:block;width:100%;padding:14px;background:#06C755;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;font-size:15px;letter-spacing:0.04em;">
          LINEアプリで開く
        </a>
        ${friendAddUrl ? `
          <p style="font-size:12px;color:#9ca3af;margin:14px 0 8px;">うまく開かない場合：</p>
          <a href="${friendAddUrl}" style="display:block;width:100%;padding:12px;background:#fff;color:#06C755;text-decoration:none;border-radius:6px;font-weight:600;font-size:13px;border:1px solid #06C755;">
            先に公式LINEを友だち追加する
          </a>
        ` : ''}
        <p style="font-size:11px;color:#9ca3af;line-height:1.6;margin:18px 0 0;">
          ※ LINEアプリがインストールされている必要があります
        </p>
      </div>
    </div>
  `;
  // タップ時に line:// → 1.5s 後フォールバックで https://liff.line.me/
  const btn = document.getElementById('openLineBtn') as HTMLAnchorElement | null;
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      // line:// で試行
      window.location.href = lineSchemeUrl;
      // フォールバック
      setTimeout(() => { window.location.href = lineAppUrl; }, 1500);
    });
  }
}

function showError(message: string) {
  const container = document.getElementById('app')!;
  container.innerHTML = `
    <div class="card">
      <h2>エラー</h2>
      <p class="error">${escapeHtml(message)}</p>
    </div>
  `;
}

// ─── Core Flow ──────────────────────────────────────────

async function linkAndAddFlow() {
  const redirectUrl = getRedirectUrl();
  const ref = getRef();

  try {
    const existingUuid = getSavedUuid();

    // Get profile, ID token, and friendship status in parallel
    const [profile, rawIdToken, friendship] = await Promise.all([
      liff.getProfile(),
      Promise.resolve(liff.getIDToken()),
      liff.getFriendship(),
    ]);

    // 1. UUID linking (always, regardless of friendship)
    const linkPromise = apiCall('/api/liff/link', {
      method: 'POST',
      body: JSON.stringify({
        idToken: rawIdToken,
        displayName: profile.displayName,
        existingUuid: existingUuid,
        ref: ref,
        alreadyFriend: friendship.friendFlag,
        liffId: LIFF_ID,
        // Debug payload — lets us see exactly what the LIFF SDK left
        // behind on window.location after init. Safe to ship: it's
        // already user-controllable URL state, no secrets.
        _debug: {
          href: window.location.href,
          search: window.location.search,
          hash: window.location.hash,
        },
      }),
    }).then(async (res) => {
      if (res.ok) {
        const data = await res.json() as { success: boolean; data?: { userId?: string } };
        if (data?.data?.userId) {
          saveUuid(data.data.userId);
        }
      }
      return res;
    }).catch(() => {
      // Silent fail — UUID linking is best-effort
    });

    // 2. Attribution tracking
    if (ref) {
      apiCall('/api/affiliates/click', {
        method: 'POST',
        body: JSON.stringify({ code: ref, url: window.location.href }),
      }).catch(() => {});
    }

    // 3. Redirect flow (for wrapped URLs)
    if (redirectUrl) {
      await Promise.race([
        linkPromise,
        new Promise((r) => setTimeout(r, 500)),
      ]);
      window.location.href = redirectUrl;
      return;
    }

    // 4. Wait for UUID linking to complete
    await linkPromise;

    // 5. Friendship check — the key decision point
    if (!friendship.friendFlag) {
      // Not a friend yet → show friend-add button
      showFriendAdd(profile);
    } else {
      // Already a friend → all done
      showCompletion(profile, !!existingUuid);
    }

  } catch (err) {
    if (redirectUrl) {
      window.location.href = redirectUrl;
    } else {
      showError(err instanceof Error ? err.message : 'エラーが発生しました');
    }
  }
}

// ─── Entry Point ────────────────────────────────────────

async function main() {
  // Diagnostic ping — fires before any LIFF work so we can confirm the
  // bundle loaded and what URL params landed on this page even when
  // liff.init / login fail or redirect away.
  try {
    fetch(`${API_URL}/api/liff/diagnostic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        href: window.location.href,
        search: window.location.search,
        hash: window.location.hash,
        liffId: LIFF_ID,
        snapshotRef: _SNAPSHOT_REF,
        userAgent: navigator.userAgent,
      }),
    }).catch(() => {/* ignore */});
  } catch { /* ignore */ }

  // Preview mode lets the operator open the LIFF page in a regular browser
  // (without going through line.me) to see how it looks. We skip liff.init
  // / login and the page code falls back to a placeholder profile.
  const previewParams = new URLSearchParams(window.location.search);
  const isPreview = previewParams.get('preview') === '1';

  try {
    if (!isPreview) {
      await liff.init({ liffId: LIFF_ID });

      if (!liff.isLoggedIn()) {
        // Safari (and other ITP browsers) strips the LINE login session cookie,
        // causing liff.login() → callback → liff.init() → still not logged in →
        // infinite loop. Detect external browser and show "Open in LINE" instead.
        if (!liff.isInClient()) {
          showOpenInLineApp();
          return;
        }
        liff.login({ redirectUri: window.location.href });
        return;
      }
    }

    const page = getPage();
    if (page === 'book') {
      await initBooking();
    } else if (page === 'event') {
      const params = new URLSearchParams(window.location.search);
      const slug = params.get('slug');
      await initEventBooking(slug);
    } else if (page === 'form') {
      const params = new URLSearchParams(window.location.search);
      const formId = params.get('id');
      await initForm(formId);
    } else if (page === 'send-template') {
      const params = new URLSearchParams(window.location.search);
      const templateId = params.get('id');
      await initSendTemplate(templateId);
    } else if (page === 'eijaku' || page === 'eijaku-report' || page === 'eijaku-test') {
      const params = new URLSearchParams(window.location.search);
      const formId = params.get('id');
      await initEijaku(formId);
    } else {
      await linkAndAddFlow();
    }
  } catch (err) {
    showError(err instanceof Error ? err.message : 'LIFF初期化エラー');
  }
}

main();
