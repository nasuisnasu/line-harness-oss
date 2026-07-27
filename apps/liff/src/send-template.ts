/**
 * Send-template page — `?page=send-template&id={template_id}`
 *
 * Used by external archive pages: clicking a button opens this LIFF page
 * which sends the specified template to the current LINE user, then
 * shows a confirmation and closes (or invites them back to the LINE chat).
 */

declare const liff: {
  getIDToken(): string | null;
  closeWindow(): void;
  id?: string;
};

const API_URL = import.meta.env?.VITE_API_URL || 'http://localhost:8787';

function apiCall(path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
}

function getApp(): HTMLElement {
  return document.getElementById('app')!;
}

interface SendResp {
  success: boolean;
  data?: { templateName?: string };
  error?: string;
}

export async function initSendTemplate(templateId: string | null): Promise<void> {
  const app = getApp();
  if (!templateId) {
    renderError('テンプレートIDが指定されていません');
    return;
  }

  renderLoading();

  try {
    const idToken = liff.getIDToken();
    if (!idToken) {
      renderError('LINEログインが必要です');
      return;
    }

    const res = await apiCall('/api/liff/send-template', {
      method: 'POST',
      body: JSON.stringify({
        idToken,
        templateId,
        liffId: liff.id ?? undefined,
      }),
    });

    const json = (await res.json()) as SendResp;
    if (!res.ok || !json.success) {
      renderError(json.error ?? '送信に失敗しました');
      return;
    }

    renderSuccess(json.data?.templateName ?? 'メッセージ');
  } catch (err) {
    renderError(err instanceof Error ? err.message : '送信に失敗しました');
  }

  function renderLoading(): void {
    app.innerHTML = `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#f9fafb;">
        <div style="text-align:center;font-family:'Noto Sans JP',sans-serif;color:#6b7280;font-size:14px;">
          メッセージを送信しています...
        </div>
      </div>
    `;
  }

  function renderSuccess(templateName: string): void {
    app.innerHTML = `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#f9fafb;">
        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px 28px;max-width:380px;text-align:center;font-family:'Noto Sans JP',sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.04);">
          <div style="width:56px;height:56px;margin:0 auto 16px;border-radius:50%;background:#dcfce7;display:flex;align-items:center;justify-content:center;font-size:28px;color:#16a34a;">✓</div>
          <h1 style="font-size:18px;font-weight:700;color:#111827;margin:0 0 12px;letter-spacing:0.02em;">LINEに送信しました</h1>
          <p style="font-size:13px;color:#6b7280;line-height:1.7;margin:0 0 20px;">「${escapeHtml(templateName)}」のメッセージをLINEに送りました。<br>LINEのトーク画面でご確認ください。</p>
          <button id="btn-close" style="width:100%;padding:12px;background:#06C755;color:#fff;border:none;border-radius:6px;font-weight:600;font-size:14px;cursor:pointer;font-family:inherit;">LINEを開く</button>
        </div>
      </div>
    `;
    const btn = document.getElementById('btn-close');
    if (btn) {
      btn.addEventListener('click', () => {
        try {
          liff.closeWindow();
        } catch {
          window.close();
        }
      });
    }
  }

  function renderError(msg: string): void {
    app.innerHTML = `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#f9fafb;">
        <div style="background:#fff;border:1px solid #fecaca;border-radius:12px;padding:32px 28px;max-width:380px;text-align:center;font-family:'Noto Sans JP',sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.04);">
          <div style="width:56px;height:56px;margin:0 auto 16px;border-radius:50%;background:#fee2e2;display:flex;align-items:center;justify-content:center;font-size:24px;color:#dc2626;">!</div>
          <h1 style="font-size:16px;font-weight:700;color:#111827;margin:0 0 12px;">送信できませんでした</h1>
          <p style="font-size:13px;color:#6b7280;line-height:1.7;margin:0 0 20px;">${escapeHtml(msg)}</p>
          <p style="font-size:11px;color:#9ca3af;line-height:1.6;margin:0;">先にLINEで友達追加してから、もう一度お試しください。</p>
        </div>
      </div>
    `;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
