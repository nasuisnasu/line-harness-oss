/**
 * LIFF Eijaku-Niki Page — Daily reports and confirmation tests
 *
 * Shared entry for the 英弱ニキ workspace. Renders one of two flows depending
 * on the form's `formType`:
 *   - daily_report → notebook-style submission UI
 *   - test         → quiz UI with immediate grading & pass/fail screen
 *
 * URL formats:
 *   https://liff.line.me/{LIFF_ID}?page=eijaku&id={FORM_ID}
 *   https://liff.line.me/{LIFF_ID}?page=eijaku-report&id={FORM_ID}  (alias)
 *   https://liff.line.me/{LIFF_ID}?page=eijaku-test&id={FORM_ID}    (alias)
 *
 * Backend reuses /api/forms/:id and /api/forms/:id/submit — see
 * apps/worker/src/routes/forms.ts. The submit response now includes a
 * `grade` block when form_type='test'.
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
const UUID_STORAGE_KEY = 'lh_uuid';

interface FormField {
  name: string;
  label: string;
  type: 'text' | 'email' | 'tel' | 'number' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'date';
  required?: boolean;
  options?: string[];
  placeholder?: string;
  /** Optional per-question hint shown under the label (eg. "10点満点で") */
  hint?: string;
}

interface FormDef {
  id: string;
  name: string;
  displayName?: string | null;
  description: string | null;
  fields: FormField[];
  submitLabel?: string | null;
  isActive: boolean;
  formType: 'generic' | 'daily_report' | 'test';
  passingScore: number | null;
  /**
   * Only present on demo JSON files (apps/liff/public/demo-forms/*.json).
   * The real /api/forms/:id endpoint strips correctAnswers from the response.
   */
  correctAnswers?: Record<string, string | string[]> | null;
}

interface GradeDetail {
  name: string;
  correct: boolean;
  expected: unknown;
  actual: unknown;
}

interface GradeResult {
  score: number;
  maxScore: number;
  passed: boolean | null;
  details: GradeDetail[];
}

const state = {
  formDef: null as FormDef | null,
  profile: null as { userId: string; displayName: string; pictureUrl?: string } | null,
  friendId: null as string | null,
  submitting: false,
};

// ── helpers ─────────────────────────────────────────────────────────────────

function getApp(): HTMLElement {
  return document.getElementById('app')!;
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function api(path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
}

function injectStyles(): void {
  if (document.getElementById('eijaku-styles')) return;
  const s = document.createElement('style');
  s.id = 'eijaku-styles';
  // Notebook / study-journal palette: warm cream + indigo + orange accent.
  // Distinct from the LINE-green generic form so 英弱ニキ feels like its own brand.
  s.textContent = `
    body { background: #fdf9f0; }
    .ej-page { max-width: 480px; margin: 0 auto; padding: 16px 12px 40px; }
    .ej-card { background: #fff; border-radius: 14px; padding: 22px 20px;
               box-shadow: 0 1px 3px rgba(20, 30, 60, 0.07);
               border: 1px solid rgba(20, 30, 60, 0.06); }
    .ej-header { text-align: center; margin-bottom: 16px; }
    .ej-tag { display: inline-block; font-size: 11px; font-weight: 700;
              padding: 3px 10px; border-radius: 999px; letter-spacing: 0.05em;
              background: #1e2a4a; color: #fff; margin-bottom: 10px; }
    .ej-tag.report { background: #ea6a2a; }
    .ej-tag.test   { background: #1e2a4a; }
    .ej-title { font-size: 19px; font-weight: 700; color: #1e2a4a; margin: 0 0 6px; }
    .ej-desc  { font-size: 13px; color: #6b6555; line-height: 1.65;
                white-space: pre-wrap; text-align: left; margin-top: 8px; }
    .ej-profile { display: flex; align-items: center; justify-content: center;
                  gap: 8px; margin-top: 12px; font-size: 13px; color: #6b6555; }
    .ej-profile img { width: 28px; height: 28px; border-radius: 50%; }

    .ej-field { margin-bottom: 22px; }
    .ej-label { display: block; font-size: 14px; font-weight: 700; color: #1e2a4a;
                margin-bottom: 4px; }
    .ej-hint  { font-size: 12px; color: #8a8273; margin-bottom: 8px; }
    .ej-required { color: #d84a18; margin-left: 4px; }

    .ej-q-num { display: inline-block; min-width: 22px; padding: 1px 7px;
                background: #1e2a4a; color: #fff; font-size: 11px;
                border-radius: 4px; margin-right: 6px; font-weight: 700;
                vertical-align: 1px; }

    .ej-input, .ej-textarea, .ej-select {
      width: 100%; padding: 12px 13px; border: 1.5px solid #e5dfd0;
      border-radius: 9px; font-size: 15px; font-family: inherit;
      background: #fffdf6; color: #1e2a4a; box-sizing: border-box;
      transition: border-color 0.15s, background 0.15s;
      -webkit-appearance: none;
    }
    .ej-input:focus, .ej-textarea:focus, .ej-select:focus {
      outline: none; border-color: #ea6a2a; background: #fff;
    }
    .ej-textarea { resize: vertical; min-height: 110px; }
    .ej-select {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23666' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 12px center;
    }
    .ej-radio, .ej-check { display: flex; flex-direction: column; gap: 8px; }
    .ej-opt {
      display: flex; align-items: center; gap: 10px; padding: 12px 14px;
      background: #fffdf6; border: 1.5px solid #e5dfd0; border-radius: 9px;
      font-size: 14px; color: #1e2a4a; cursor: pointer;
      transition: all 0.15s;
    }
    .ej-opt:has(input:checked) { border-color: #ea6a2a; background: #fff5ec; }
    .ej-opt input { accent-color: #ea6a2a; width: 18px; height: 18px; }

    .ej-submit {
      width: 100%; padding: 15px; border: none; border-radius: 10px;
      background: #1e2a4a; color: #fff; font-size: 16px; font-weight: 700;
      cursor: pointer; font-family: inherit; transition: opacity 0.15s;
      margin-top: 4px;
    }
    .ej-submit:active { opacity: 0.85; }
    .ej-submit:disabled { background: #b6b3aa; cursor: not-allowed; }
    .ej-error { color: #d84a18; font-size: 13px; margin-top: 6px;
                text-align: center; font-weight: 600; }

    /* Result screen (test) */
    .ej-result-banner {
      text-align: center; padding: 32px 16px 24px;
      border-radius: 14px; margin-bottom: 16px;
      background: linear-gradient(180deg, #ea6a2a 0%, #d85a1a 100%);
      color: #fff;
    }
    .ej-result-banner.pass { background: linear-gradient(180deg, #2e7d4f 0%, #1e6840 100%); }
    .ej-result-banner.fail { background: linear-gradient(180deg, #1e2a4a 0%, #141d36 100%); }
    .ej-result-icon { font-size: 44px; line-height: 1; margin-bottom: 8px; }
    .ej-result-title { font-size: 20px; font-weight: 700; margin: 0; }
    .ej-result-score { font-size: 32px; font-weight: 700; margin: 8px 0 0;
                        font-variant-numeric: tabular-nums; }
    .ej-result-pct { font-size: 14px; opacity: 0.85; }

    .ej-detail-list { list-style: none; padding: 0; margin: 0; }
    .ej-detail-item { display: flex; gap: 10px; padding: 10px 0;
                      border-bottom: 1px dashed #e5dfd0; font-size: 13px; }
    .ej-detail-item:last-child { border-bottom: none; }
    .ej-mark { flex: 0 0 22px; height: 22px; border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                font-size: 13px; font-weight: 700; color: #fff; }
    .ej-mark.ok { background: #2e7d4f; }
    .ej-mark.ng { background: #d84a18; }
    .ej-detail-body { flex: 1; color: #1e2a4a; }
    .ej-detail-q { font-weight: 600; margin-bottom: 2px; }
    .ej-detail-ans { font-size: 12px; color: #6b6555; }

    .ej-close {
      width: 100%; padding: 14px; margin-top: 14px;
      background: transparent; color: #1e2a4a;
      border: 1.5px solid #1e2a4a; border-radius: 10px;
      font-size: 15px; font-weight: 700; font-family: inherit;
      cursor: pointer;
    }
    .ej-close:active { background: #f4efe0; }

    .ej-loading { text-align: center; padding: 60px 20px; color: #8a8273; }
    .ej-loading .spinner {
      width: 32px; height: 32px; border: 3px solid #e5dfd0;
      border-top-color: #ea6a2a; border-radius: 50%;
      animation: ej-spin 0.8s linear infinite;
      margin: 0 auto 12px;
    }
    @keyframes ej-spin { to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(s);
}

// ── rendering ───────────────────────────────────────────────────────────────

function renderLoading() {
  getApp().innerHTML = `
    <div class="ej-page">
      <div class="ej-card ej-loading">
        <div class="spinner"></div>
        <div>読み込み中...</div>
      </div>
    </div>
  `;
}

function renderError(message: string) {
  getApp().innerHTML = `
    <div class="ej-page">
      <div class="ej-card">
        <h2 style="color:#d84a18;font-size:17px;margin:0 0 8px;text-align:center;">エラー</h2>
        <p style="color:#6b6555;font-size:14px;text-align:center;line-height:1.6;">${escapeHtml(message)}</p>
      </div>
    </div>
  `;
}

function renderField(field: FormField, index: number, isTest: boolean): string {
  const reqMark = field.required ? '<span class="ej-required">*</span>' : '';
  const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : '';
  const required = field.required ? ' required' : '';
  const hint = field.hint
    ? `<div class="ej-hint">${escapeHtml(field.hint)}</div>`
    : '';
  // Tests get question numbers
  const labelText = isTest
    ? `<span class="ej-q-num">Q${index + 1}</span>${escapeHtml(field.label)}`
    : escapeHtml(field.label);

  let input = '';
  switch (field.type) {
    case 'textarea':
      input = `<textarea name="${escapeHtml(field.name)}" id="f-${escapeHtml(field.name)}"
                class="ej-textarea" rows="4"${placeholder}${required}></textarea>`;
      break;
    case 'select': {
      const opts = (field.options ?? [])
        .map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`)
        .join('');
      input = `<select name="${escapeHtml(field.name)}" id="f-${escapeHtml(field.name)}"
                class="ej-select"${required}>
                  <option value="">選択してください</option>${opts}
                </select>`;
      break;
    }
    case 'radio': {
      const rs = (field.options ?? [])
        .map(
          (o) =>
            `<label class="ej-opt">
              <input type="radio" name="${escapeHtml(field.name)}" value="${escapeHtml(o)}"${required} />
              <span>${escapeHtml(o)}</span>
            </label>`,
        )
        .join('');
      input = `<div class="ej-radio">${rs}</div>`;
      break;
    }
    case 'checkbox': {
      const cs = (field.options ?? [])
        .map(
          (o) =>
            `<label class="ej-opt">
              <input type="checkbox" name="${escapeHtml(field.name)}" value="${escapeHtml(o)}" />
              <span>${escapeHtml(o)}</span>
            </label>`,
        )
        .join('');
      input = `<div class="ej-check">${cs}</div>`;
      break;
    }
    default:
      input = `<input type="${escapeHtml(field.type)}" name="${escapeHtml(field.name)}"
                id="f-${escapeHtml(field.name)}" class="ej-input"${placeholder}${required} />`;
  }

  return `
    <div class="ej-field">
      <label class="ej-label" for="f-${escapeHtml(field.name)}">${labelText}${reqMark}</label>
      ${hint}
      ${input}
    </div>
  `;
}

function renderForm(): void {
  const { formDef, profile } = state;
  if (!formDef) return;

  injectStyles();

  const isTest = formDef.formType === 'test';
  const isReport = formDef.formType === 'daily_report';

  const tagLabel = isTest ? '確認テスト' : isReport ? '今日の日報' : 'フォーム';
  const tagClass = isTest ? 'test' : isReport ? 'report' : '';

  const submitLabel =
    formDef.submitLabel?.trim() ||
    (isTest ? '採点する' : isReport ? '提出する' : '送信する');

  const profileHtml = profile?.pictureUrl
    ? `<div class="ej-profile">
        <img src="${profile.pictureUrl}" alt="" />
        <span>${escapeHtml(profile.displayName)} さん</span>
      </div>`
    : '';

  const fieldsHtml = formDef.fields.map((f, i) => renderField(f, i, isTest)).join('');

  getApp().innerHTML = `
    <div class="ej-page">
      <div class="ej-header">
        <span class="ej-tag ${tagClass}">${escapeHtml(tagLabel)}</span>
        <h1 class="ej-title">${escapeHtml(formDef.displayName?.trim() || formDef.name)}</h1>
        ${formDef.description ? `<p class="ej-desc">${escapeHtml(formDef.description)}</p>` : ''}
        ${profileHtml}
      </div>
      <form id="ej-form" class="ej-card" novalidate>
        ${fieldsHtml}
        <button type="submit" class="ej-submit" id="ej-submit-btn">${escapeHtml(submitLabel)}</button>
      </form>
    </div>
  `;

  document.getElementById('ej-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    void submit();
  });
}

function renderTestResult(grade: GradeResult): void {
  const { formDef } = state;
  if (!formDef) return;

  const pct = grade.maxScore > 0 ? Math.round((grade.score / grade.maxScore) * 100) : 0;
  const fieldMap = new Map(formDef.fields.map((f) => [f.name, f]));
  const passed = grade.passed;

  const bannerClass = passed === true ? 'pass' : passed === false ? 'fail' : '';
  const icon = passed === true ? '🎉' : passed === false ? '📚' : '✓';
  const title =
    passed === true ? '合格！' : passed === false ? 'もう一歩' : '提出完了';

  const detailHtml = grade.details
    .map((d) => {
      const field = fieldMap.get(d.name);
      const label = field?.label ?? d.name;
      const expectedStr = Array.isArray(d.expected) ? d.expected.join(' / ') : String(d.expected ?? '');
      const actualStr = Array.isArray(d.actual) ? d.actual.join(' / ') : String(d.actual ?? '（無回答）');
      return `
        <li class="ej-detail-item">
          <span class="ej-mark ${d.correct ? 'ok' : 'ng'}">${d.correct ? '◯' : '×'}</span>
          <div class="ej-detail-body">
            <div class="ej-detail-q">${escapeHtml(label)}</div>
            ${d.correct
              ? `<div class="ej-detail-ans">あなたの回答：${escapeHtml(actualStr)}</div>`
              : `<div class="ej-detail-ans">あなたの回答：${escapeHtml(actualStr)}<br>正解：${escapeHtml(expectedStr)}</div>`}
          </div>
        </li>
      `;
    })
    .join('');

  getApp().innerHTML = `
    <div class="ej-page">
      <div class="ej-result-banner ${bannerClass}">
        <div class="ej-result-icon">${icon}</div>
        <p class="ej-result-title">${title}</p>
        <div class="ej-result-score">${grade.score} / ${grade.maxScore}</div>
        <div class="ej-result-pct">正答率 ${pct}%${
          formDef.passingScore !== null ? `（合格ライン ${formDef.passingScore}%）` : ''
        }</div>
      </div>
      <div class="ej-card">
        <h3 style="font-size:14px;color:#1e2a4a;margin:0 0 10px;">問題別の結果</h3>
        <ul class="ej-detail-list">${detailHtml}</ul>
      </div>
      <button class="ej-close" id="ej-close-btn">閉じる</button>
    </div>
  `;

  document.getElementById('ej-close-btn')?.addEventListener('click', () => {
    if (liff.isInClient()) {
      try { liff.closeWindow(); } catch { /* ignore */ }
    } else {
      window.close();
    }
  });
}

function renderReportSuccess(): void {
  getApp().innerHTML = `
    <div class="ej-page">
      <div class="ej-result-banner pass">
        <div class="ej-result-icon">📓</div>
        <p class="ej-result-title">今日もお疲れさま！</p>
        <div class="ej-result-pct" style="margin-top:8px;">日報を受け取りました</div>
      </div>
      <button class="ej-close" id="ej-close-btn">閉じる</button>
    </div>
  `;
  document.getElementById('ej-close-btn')?.addEventListener('click', () => {
    if (liff.isInClient()) {
      try { liff.closeWindow(); } catch { /* ignore */ }
    } else {
      window.close();
    }
  });
  if (liff.isInClient()) {
    setTimeout(() => {
      try { liff.closeWindow(); } catch { /* ignore */ }
    }, 4000);
  }
}

// ── submit ───────────────────────────────────────────────────────────────────

function collectData(): Record<string, unknown> {
  const { formDef } = state;
  if (!formDef) return {};
  const result: Record<string, unknown> = {};
  for (const field of formDef.fields) {
    if (field.type === 'checkbox') {
      const checked = Array.from(
        document.querySelectorAll<HTMLInputElement>(`input[name="${field.name}"]:checked`),
      ).map((el) => el.value);
      result[field.name] = checked;
    } else if (field.type === 'radio') {
      const el = document.querySelector<HTMLInputElement>(`input[name="${field.name}"]:checked`);
      result[field.name] = el?.value ?? '';
    } else {
      const el = document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        `[name="${field.name}"]`,
      );
      result[field.name] = el?.value ?? '';
    }
  }
  return result;
}

function validate(): string | null {
  const { formDef } = state;
  if (!formDef) return null;
  for (const f of formDef.fields) {
    if (!f.required) continue;
    if (f.type === 'checkbox') {
      const checked = document.querySelectorAll<HTMLInputElement>(`input[name="${f.name}"]:checked`);
      if (checked.length === 0) return `${f.label} は必須です`;
    } else if (f.type === 'radio') {
      const el = document.querySelector<HTMLInputElement>(`input[name="${f.name}"]:checked`);
      if (!el) return `${f.label} は必須です`;
    } else {
      const el = document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        `[name="${f.name}"]`,
      );
      if (!el || !el.value.trim()) return `${f.label} は必須です`;
    }
  }
  return null;
}

async function submit(): Promise<void> {
  if (state.submitting || !state.formDef) return;

  const err = validate();
  if (err) {
    showErrorMessage(err);
    return;
  }

  state.submitting = true;
  const btn = document.getElementById('ej-submit-btn') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '送信中...';
  }

  const isPreview = new URLSearchParams(window.location.search).get('preview') === '1';
  const isDemo = new URLSearchParams(window.location.search).get('demo') === '1';

  try {
    const data = collectData();

    // Demo / preview short-circuit: don't call the worker, grade locally so the
    // operator can rehearse the UX without provisioning a real form.
    if (isDemo || isPreview) {
      if (state.formDef.formType === 'test') {
        const grade = gradeLocally(state.formDef, data);
        renderTestResult(grade);
      } else {
        renderReportSuccess();
      }
      return;
    }

    const body: Record<string, unknown> = { data };
    if (state.profile?.userId) body.lineUserId = state.profile.userId;
    if (state.friendId) body.friendId = state.friendId;

    const res = await api(`/api/forms/${state.formDef.id}/submit`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const e = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(e?.error ?? '送信に失敗しました');
    }

    const json = (await res.json()) as {
      success: boolean;
      data?: { grade?: GradeResult | null };
    };

    const grade = json.data?.grade ?? null;
    if (state.formDef.formType === 'test' && grade) {
      renderTestResult(grade);
    } else {
      renderReportSuccess();
    }
  } catch (e) {
    state.submitting = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent =
        state.formDef.submitLabel?.trim() ||
        (state.formDef.formType === 'test' ? '採点する' : '提出する');
    }
    showErrorMessage(e instanceof Error ? e.message : '送信に失敗しました');
  }
}

/** Client-side mirror of packages/db/src/forms.ts → gradeSubmission().
 *  Only used in demo / preview mode where there's no worker to call. */
function gradeLocally(form: FormDef, data: Record<string, unknown>): GradeResult {
  const correct = form.correctAnswers ?? {};
  const details: GradeResult['details'] = [];
  let score = 0;
  let maxScore = 0;
  for (const [name, expected] of Object.entries(correct)) {
    maxScore++;
    const actual = data[name];
    const isCorrect = compareAnswer(expected, actual);
    if (isCorrect) score++;
    details.push({ name, correct: isCorrect, expected, actual });
  }
  let passed: boolean | null = null;
  if (form.passingScore !== null && maxScore > 0) {
    passed = (score / maxScore) * 100 >= form.passingScore;
  }
  return { score, maxScore, passed, details };
}

function compareAnswer(expected: string | string[], actual: unknown): boolean {
  if (Array.isArray(expected)) {
    if (Array.isArray(actual)) {
      const a = new Set(expected.map(String));
      const b = new Set(actual.map(String));
      if (a.size !== b.size) return false;
      for (const v of a) if (!b.has(v)) return false;
      return true;
    }
    return expected.map(String).includes(String(actual ?? ''));
  }
  return String(actual ?? '') === String(expected);
}

function showErrorMessage(message: string): void {
  const existing = document.querySelector('.ej-error');
  if (existing) existing.remove();
  const el = document.createElement('p');
  el.className = 'ej-error';
  el.textContent = message;
  const btn = document.getElementById('ej-submit-btn');
  btn?.parentElement?.insertBefore(el, btn);
}

// ── entry point ─────────────────────────────────────────────────────────────

export async function initEijaku(formId: string | null): Promise<void> {
  injectStyles();

  if (!formId) {
    renderError('フォームIDが指定されていません');
    return;
  }

  renderLoading();

  // Preview mode: skip every LIFF SDK call. The SDK isn't initialized when
  // ?preview=1, so liff.getProfile() would hang forever and the screen would
  // stay on "読み込み中..." indefinitely.
  const isPreview = new URLSearchParams(window.location.search).get('preview') === '1';
  const isDemo = new URLSearchParams(window.location.search).get('demo') === '1';

  try {
    if (isPreview) {
      state.profile = {
        userId: 'preview-user',
        displayName: 'プレビュー太郎',
        pictureUrl: undefined,
      };
    } else {
      state.profile = await liff.getProfile();
    }

    let formDef: FormDef;

    if (isDemo) {
      // Bundled-sample fallback so we can inspect the UI offline before any
      // form exists in the DB. Drop a JSON next to index.html and we'll fetch it.
      const sampleRes = await fetch(`/demo-forms/${formId}.json`);
      if (!sampleRes.ok) {
        renderError(`サンプル /demo-forms/${formId}.json が見つかりません`);
        return;
      }
      formDef = await sampleRes.json();
    } else {
      const res = await api(`/api/forms/${formId}`);
      if (!res.ok) {
        renderError(res.status === 404 ? 'フォームが見つかりません' : 'フォームの読み込みに失敗しました');
        return;
      }
      const json = (await res.json()) as { success: boolean; data?: FormDef };
      if (!json.success || !json.data) {
        renderError('フォームの読み込みに失敗しました');
        return;
      }
      if (!json.data.isActive) {
        renderError('このフォームは現在受付を停止しています');
        return;
      }
      formDef = json.data;
    }

    try {
      state.friendId = localStorage.getItem(UUID_STORAGE_KEY);
    } catch { /* silent */ }

    // Best-effort UUID linking — only meaningful in real LIFF context.
    if (!isPreview && !isDemo) {
      const idToken = liff.getIDToken();
      if (idToken) {
        api('/api/liff/link', {
          method: 'POST',
          body: JSON.stringify({
            idToken,
            displayName: state.profile.displayName,
            existingUuid: state.friendId,
          }),
        })
          .then(async (linkRes) => {
            if (linkRes.ok) {
              const j = (await linkRes.json()) as { success: boolean; data?: { userId?: string } };
              if (j.data?.userId) {
                try {
                  localStorage.setItem(UUID_STORAGE_KEY, j.data.userId);
                  state.friendId = j.data.userId;
                } catch { /* silent */ }
              }
            }
          })
          .catch(() => { /* silent */ });
      }
    }

    state.formDef = formDef;
    renderForm();
  } catch (e) {
    renderError(e instanceof Error ? e.message : 'エラーが発生しました');
  }
}
