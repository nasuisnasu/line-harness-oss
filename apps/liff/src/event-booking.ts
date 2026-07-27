/**
 * LIFF Event Booking — week-view consultation booking flow.
 *
 * Mounted via `?page=event&slug=xxx`.
 *
 * Steps:
 * 1. Fetch /api/public/events/:slug for event + consultation config + form
 * 2. Render a week view (7 days × time-slot grid) of available slots
 *    pulled from /api/public/events/:slug/slots?from=&to=
 * 3. Tap slot → if event has a form, render the form fields → confirm
 *    → POST to /api/public/events/:slug/book
 * 4. Show success card (LINE app confirmation message is sent server-side)
 *
 * The CSS already in apps/liff/index.html (.booking-page / .slot-btn /
 * .confirm-card / .success-card) is reused; week-specific layout is added
 * inline below.
 */

declare const liff: {
  init(config: { liffId: string }): Promise<void>;
  isLoggedIn(): boolean;
  login(opts?: { redirectUri?: string }): void;
  getProfile(): Promise<{ userId: string; displayName: string; pictureUrl?: string }>;
  isInClient(): boolean;
  closeWindow(): void;
};

const API_URL = import.meta.env?.VITE_API_URL || 'http://localhost:8787';

// 有料イベントの予約券（決済で発行）。決済ページ→サンクス→?ticket= で渡ってくる。
let bookingTicket = '';
const ticketQS = () => (bookingTicket ? `&ticket=${encodeURIComponent(bookingTicket)}` : '');
/** 当選タグゲートの判定はサーバ側で lineUserId を見るので、slots にも渡す。 */
const uidQS = () =>
  state.profile?.userId ? `&lineUserId=${encodeURIComponent(state.profile.userId)}` : '';

interface FormField {
  name: string;
  label: string;
  type: 'text' | 'email' | 'tel' | 'number' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'date';
  required?: boolean;
  options?: string[];
  placeholder?: string;
}

interface EventDef {
  id: string;
  name: string;
  description: string | null;
  eventType: 'consultation' | 'seminar';
  slug: string;
  recruitmentPaused?: boolean;
  consultationConfig: {
    durationMinutes: number;
    calendarViewMode: 'week' | 'month';
    advanceMaxDays: number;
  } | null;
  /** Inline booking form attached to the event (independent from /forms). */
  bookingForm: {
    fields: FormField[];
    submitLabel?: string | null;
  } | null;
}

interface Slot {
  start: string;
  end: string;
  available: boolean;
}

interface State {
  event: EventDef | null;
  weekStart: Date;
  slots: Slot[];
  selectedSlot: Slot | null;
  profile: { userId: string; displayName: string; pictureUrl?: string } | null;
  formData: Record<string, unknown>;
  loading: boolean;
  submitting: boolean;
  error: string;
}

const state: State = {
  event: null,
  weekStart: startOfWeek(new Date()),
  slots: [],
  selectedSlot: null,
  profile: null,
  formData: {},
  loading: false,
  submitting: false,
  error: '',
};

function escapeHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfWeek(d: Date): Date {
  // Sunday-based, JST. Reset to local midnight to keep arithmetic simple.
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const dow = x.getDay(); // 0=Sun..6=Sat
  x.setDate(x.getDate() - dow);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

async function loadEvent(slug: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/public/events/${encodeURIComponent(slug)}`);
  const json = (await res.json()) as { success: boolean; data?: EventDef; error?: string };
  if (!json.success || !json.data) throw new Error(json.error ?? 'イベントが見つかりません');
  state.event = json.data;
  // Initialize formData with empty values for each field
  if (json.data.bookingForm) {
    for (const f of json.data.bookingForm.fields) {
      state.formData[f.name] = f.type === 'checkbox' ? [] : '';
    }
  }
}

async function loadWeekSlots(): Promise<void> {
  if (!state.event) return;
  const from = ymd(state.weekStart);
  const to = ymd(addDays(state.weekStart, 6));
  state.loading = true;
  render();
  try {
    const res = await fetch(`${API_URL}/api/public/events/${encodeURIComponent(state.event.slug)}/slots?from=${from}&to=${to}${ticketQS()}${uidQS()}`);
    const json = (await res.json()) as { success: boolean; data?: { slots: Slot[]; paymentRequired?: boolean; tagRequired?: boolean }; error?: string };
    if (!json.success || !json.data) throw new Error(json.error ?? '空き枠の取得に失敗');
    if (json.data.paymentRequired) {
      state.slots = [];
      state.error = 'この予約には事前のお支払いが必要です。決済ページからお申し込みください。';
      return;
    }
    // 当選タグが無い＝選考を通っていない。「空きがありません」ではなく理由を出す。
    if (json.data.tagRequired) {
      state.slots = [];
      state.error = 'この枠は、応募のうえ選考を通過した方のみご予約いただけます。';
      return;
    }
    state.slots = json.data.slots;
  } catch (e) {
    state.error = e instanceof Error ? e.message : 'エラー';
  } finally {
    state.loading = false;
    render();
  }
}

function groupSlotsByDay(): Map<string, Slot[]> {
  const map = new Map<string, Slot[]>();
  for (let i = 0; i < 7; i++) {
    map.set(ymd(addDays(state.weekStart, i)), []);
  }
  for (const s of state.slots) {
    const d = new Date(s.start);
    const k = ymd(d);
    const arr = map.get(k);
    if (arr) arr.push(s);
  }
  return map;
}

function render(): void {
  const app = document.getElementById('app');
  if (!app) return;
  if (!state.event) {
    app.innerHTML = `<div class="form-page"><div class="card" style="text-align:center;padding:40px 20px;"><div class="loading-spinner"></div><p style="margin-top:12px;color:#718096;">読み込み中...</p></div></div>`;
    return;
  }
  if (state.error) {
    app.innerHTML = `<div class="form-page"><div class="card" style="text-align:center;padding:40px 20px;"><p class="error">${escapeHtml(state.error)}</p></div></div>`;
    return;
  }
  // 募集停止中：カレンダー描画せずメッセージ表示
  if (state.event.recruitmentPaused) {
    app.innerHTML = `
      <div class="form-page">
        <div class="card" style="text-align:center;padding:48px 24px;">
          <div style="width:64px;height:64px;border-radius:50%;background:#fef3c7;color:#b45309;display:flex;align-items:center;justify-content:center;font-size:32px;margin:0 auto 16px;">⏸</div>
          <h2 style="font-size:18px;font-weight:700;color:#111827;margin:0 0 12px;">${escapeHtml(state.event.name)}</h2>
          <p style="font-size:15px;font-weight:600;color:#92400e;margin:0 0 8px;">予約可能な枠がありません</p>
          <p style="font-size:13px;color:#6b7280;line-height:1.7;">現在、新規の申込み受付を一時停止しています。<br>再開時期は公式LINEからお知らせします。</p>
        </div>
      </div>
    `;
    return;
  }
  if (state.selectedSlot) {
    renderConfirm(app);
    return;
  }
  renderWeek(app);
}

function renderWeek(app: HTMLElement): void {
  const ev = state.event!;
  const cfg = ev.consultationConfig!;
  const todayMs = new Date().setHours(0, 0, 0, 0);
  const maxMs = todayMs + cfg.advanceMaxDays * 86400_000;
  const canPrev = state.weekStart.getTime() > todayMs;
  const canNext = addDays(state.weekStart, 7).getTime() <= maxMs;

  // Build a (date, time) grid: rows = sorted union of HH:MM across the week,
  // columns = 7 days. Each cell looks up the slot for that intersection and
  // renders ○ / ✕ / blank.
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) dates.push(ymd(addDays(state.weekStart, i)));

  const slotMap = new Map<string, Slot>(); // key: `${date}|${HH:MM}`
  const timeSet = new Set<string>();
  for (const s of state.slots) {
    const d = new Date(s.start);
    const dateKey = ymd(d);
    const timeKey = fmtTime(s.start);
    timeSet.add(timeKey);
    slotMap.set(`${dateKey}|${timeKey}`, s);
  }
  const times = Array.from(timeSet).sort();

  // Compact date: weekday letter on top, big day number below. Month is
  // already shown in the week-range title so we don't repeat "5/" in every
  // header cell — that's what made it feel cramped.
  const headerCells = dates.map((dateStr) => {
    const d = new Date(dateStr + 'T00:00:00');
    const dow = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
    const cls = d.getDay() === 0 ? 'sun' : d.getDay() === 6 ? 'sat' : '';
    return `<th class="ev-th ${cls}"><div class="ev-th-dow">${dow}</div><div class="ev-th-dom">${d.getDate()}</div></th>`;
  }).join('');

  const rowsHtml = times.length === 0
    ? `<tr><td colspan="${dates.length + 1}" class="ev-empty">この週は空き枠がありません</td></tr>`
    : times.map((t) => {
        const cells = dates.map((dateStr) => {
          const slot = slotMap.get(`${dateStr}|${t}`);
          if (!slot) return `<td class="ev-cell ev-cell-none">—</td>`;
          if (!slot.available) return `<td class="ev-cell ev-cell-x">✕</td>`;
          return `<td class="ev-cell ev-cell-o"><button type="button" class="ev-cell-btn" data-start="${escapeHtml(slot.start)}" data-end="${escapeHtml(slot.end)}">○</button></td>`;
        }).join('');
        return `<tr><td class="ev-time">${t}</td>${cells}</tr>`;
      }).join('');

  const previewBanner = state.profile?.userId === '__preview__'
    ? `<div style="background:#fef3c7;border:1px solid #f59e0b;color:#92400e;padding:8px 12px;border-radius:8px;font-size:12px;text-align:center;margin-bottom:12px;">📋 プレビューモード — 実際の予約は確定されません</div>`
    : '';

  // No-slots hint: when the current week has zero available bookable slots
  // but a next week exists, prompt the user to navigate forward.
  const availableCount = state.slots.filter((s) => s.available).length;
  const showNextWeekHint = !state.loading && availableCount === 0 && canNext;
  const nextWeekHint = showNextWeekHint
    ? `<div style="background:linear-gradient(135deg,#FFF4E0 0%,#FFEDD5 100%);border:1px solid #F4B860;color:#92400E;padding:10px 14px;border-radius:8px;font-size:12.5px;font-weight:600;text-align:center;margin-bottom:12px;line-height:1.65;letter-spacing:0.02em;">この週は予約枠がありません。<br>右上の <strong style="color:#B45309;">›</strong> で<strong style="color:#B45309;">次の週</strong>もご確認ください。</div>`
    : '';

  app.innerHTML = `
    <style>
      @keyframes calNextPulse {
        0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(244,184,96,0.6); }
        50% { transform: scale(1.08); box-shadow: 0 0 0 6px rgba(244,184,96,0); }
      }
    </style>
    <div class="form-page">
      ${previewBanner}
      <div class="form-header">
        <h1>${escapeHtml(ev.name)}</h1>
        ${ev.description ? `<p class="form-description">${escapeHtml(ev.description)}</p>` : ''}
        <p class="form-description" style="margin-top:8px;font-size:12px;">所要時間: ${cfg.durationMinutes}分</p>
      </div>
      ${nextWeekHint}
      <div class="ev-week">
        <div class="ev-week-nav">
          <button type="button" class="cal-nav" id="prevWeek" ${!canPrev ? 'disabled' : ''}>‹</button>
          <span class="cal-title">${state.weekStart.getMonth() + 1}/${state.weekStart.getDate()}〜${addDays(state.weekStart, 6).getMonth() + 1}/${addDays(state.weekStart, 6).getDate()}</span>
          <button type="button" class="cal-nav" id="nextWeek" ${!canNext ? 'disabled' : ''} ${showNextWeekHint ? `style="background:#F4B860;color:#fff;animation:calNextPulse 1.4s ease-in-out infinite;"` : ''}>›</button>
        </div>
        ${state.loading
          ? `<div style="text-align:center;padding:24px;"><div class="loading-spinner"></div></div>`
          : `<div class="ev-grid-wrap">
              <table class="ev-grid">
                <thead><tr><th class="ev-th-time"></th>${headerCells}</tr></thead>
                <tbody>${rowsHtml}</tbody>
              </table>
            </div>`}
      </div>
    </div>
  `;

  document.getElementById('prevWeek')?.addEventListener('click', async () => {
    state.weekStart = addDays(state.weekStart, -7);
    await loadWeekSlots();
  });
  document.getElementById('nextWeek')?.addEventListener('click', async () => {
    state.weekStart = addDays(state.weekStart, 7);
    await loadWeekSlots();
  });
  document.querySelectorAll<HTMLButtonElement>('.ev-cell-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedSlot = { start: btn.dataset.start!, end: btn.dataset.end!, available: true };
      render();
    });
  });
}

function renderConfirm(app: HTMLElement): void {
  const ev = state.event!;
  const slot = state.selectedSlot!;
  const start = new Date(slot.start);
  const dt = `${start.getFullYear()}/${String(start.getMonth() + 1).padStart(2, '0')}/${String(start.getDate()).padStart(2, '0')} ${fmtTime(slot.start)} - ${fmtTime(slot.end)}`;

  const submitLabel = ev.bookingForm?.submitLabel?.trim() || '予約を確定する';
  const previewBanner = state.profile?.userId === '__preview__'
    ? `<div style="background:#fef3c7;border:1px solid #f59e0b;color:#92400e;padding:8px 12px;border-radius:8px;font-size:12px;text-align:center;margin-bottom:12px;">📋 プレビューモード — 実際の予約は確定されません</div>`
    : '';

  // Two stacked cards: 予約内容（読み取り専用）と 申込情報（フォーム）。
  // Same .form-body / .form-field styles as the form LIFF so spacing and
  // typography stay consistent.
  const formCard = ev.bookingForm
    ? `<div class="form-body" style="margin-top:12px;">
        <h2 style="font-size:14px;font-weight:700;color:#333;margin-bottom:12px;">申込情報</h2>
        ${ev.bookingForm.fields.map((f) => renderField(f)).join('')}
      </div>`
    : '';

  app.innerHTML = `
    <div class="form-page">
      ${previewBanner}
      <div class="form-header">
        <h1>予約内容の確認</h1>
      </div>
      <div class="confirm-card">
        <h2 style="font-size:14px;font-weight:700;color:#333;margin-bottom:12px;">予約内容</h2>
        <div class="confirm-details">
          <div class="confirm-row"><span class="confirm-label">プログラム</span><span class="confirm-value">${escapeHtml(ev.name)}</span></div>
          <div class="confirm-row"><span class="confirm-label">日時</span><span class="confirm-value">${dt}</span></div>
        </div>
      </div>
      ${formCard}
      <div style="margin-top:16px;">
        ${state.error ? `<p class="form-error" style="text-align:center;margin-bottom:8px;">${escapeHtml(state.error)}</p>` : ''}
        <button type="button" class="book-btn" id="confirmBtn" ${state.submitting ? 'disabled' : ''}>${state.submitting ? '送信中...' : escapeHtml(submitLabel)}</button>
        <button type="button" class="close-btn" id="backBtn" style="margin-top:12px;">枠を選び直す</button>
      </div>
    </div>
  `;

  document.getElementById('backBtn')?.addEventListener('click', () => {
    state.selectedSlot = null;
    state.error = '';
    render();
  });
  document.getElementById('confirmBtn')?.addEventListener('click', submit);
  attachFormListeners();
}

function renderField(f: FormField): string {
  const reqMark = f.required ? '<span class="required-mark">*</span>' : '';
  const placeholder = f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : '';
  if (f.type === 'textarea') {
    return `<div class="form-field"><label class="form-label">${escapeHtml(f.label)}${reqMark}</label><textarea class="form-textarea" data-field="${escapeHtml(f.name)}"${placeholder}></textarea></div>`;
  }
  // For radio / checkbox, inline a free-text input directly inside the
  // "その他" option's label so the relationship is visually obvious. For
  // select, a select element can't host an inline child input — we fall
  // back to a separate (hidden until needed) text field below the dropdown.
  const renderOption = (o: string, type: 'radio' | 'checkbox'): string => {
    const cls = type === 'radio' ? 'radio-label' : 'checkbox-label';
    const inputAttrs = type === 'radio'
      ? `type="radio" name="${escapeHtml(f.name)}" value="${escapeHtml(o)}" data-field="${escapeHtml(f.name)}"`
      : `type="checkbox" value="${escapeHtml(o)}" data-checkbox-field="${escapeHtml(f.name)}"`;
    if (o === 'その他') {
      return `<label class="${cls}"><input ${inputAttrs} /><span>その他:</span><input type="text" class="ev-other-inline" data-other-text="${escapeHtml(f.name)}" placeholder="ご記入ください" /></label>`;
    }
    return `<label class="${cls}"><input ${inputAttrs} />${escapeHtml(o)}</label>`;
  };

  if (f.type === 'select') {
    const opts = (f.options ?? []).map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
    return `<div class="form-field"><label class="form-label">${escapeHtml(f.label)}${reqMark}</label><select class="form-select" data-field="${escapeHtml(f.name)}"><option value="">選択してください</option>${opts}</select></div>`;
  }
  if (f.type === 'radio') {
    const opts = (f.options ?? []).map(o => renderOption(o, 'radio')).join('');
    return `<div class="form-field"><label class="form-label">${escapeHtml(f.label)}${reqMark}</label><div class="radio-group">${opts}</div></div>`;
  }
  if (f.type === 'checkbox') {
    const opts = (f.options ?? []).map(o => renderOption(o, 'checkbox')).join('');
    return `<div class="form-field"><label class="form-label">${escapeHtml(f.label)}${reqMark}</label><div class="checkbox-group">${opts}</div></div>`;
  }
  const inputType = f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : f.type === 'number' ? 'number' : 'text';
  return `<div class="form-field"><label class="form-label">${escapeHtml(f.label)}${reqMark}</label><input type="${inputType}" class="form-input" data-field="${escapeHtml(f.name)}"${placeholder} /></div>`;
}

function attachFormListeners(): void {
  // Track free-text inputs tied to "その他" options. We re-evaluate the
  // visibility / value on every change so multi-step toggles stay in sync.
  const otherInputs = new Map<string, HTMLInputElement>();
  document.querySelectorAll<HTMLInputElement>('[data-other-text]').forEach((el) => {
    otherInputs.set(el.dataset.otherText!, el);
    el.addEventListener('input', () => {
      // Re-write the field's stored value to fold the free text in.
      const name = el.dataset.otherText!;
      reapplyOther(name);
    });
  });

  function reapplyOther(name: string): void {
    const otherEl = otherInputs.get(name);
    if (!otherEl) return;
    // Inline inputs live inside the option label and should always render —
    // typing only matters when the option is actually selected. Trailing
    // ones (select dropdowns) toggle visibility based on the chosen value.
    const isInline = otherEl.classList.contains('ev-other-inline');
    const cur = state.formData[name];
    const otherText = otherEl.value.trim();

    if (typeof cur === 'string') {
      if (cur === 'その他' || cur.startsWith('その他: ')) {
        if (!isInline) otherEl.style.display = '';
        state.formData[name] = otherText ? `その他: ${otherText}` : 'その他';
      } else {
        if (!isInline) otherEl.style.display = 'none';
      }
      return;
    }
    if (Array.isArray(cur)) {
      const hasOther = cur.some((v) => v === 'その他' || v.startsWith('その他: '));
      if (hasOther) {
        if (!isInline) otherEl.style.display = '';
        const replaced = cur.map((v) => (v === 'その他' || v.startsWith('その他: ')) ? (otherText ? `その他: ${otherText}` : 'その他') : v);
        state.formData[name] = replaced;
      } else {
        if (!isInline) otherEl.style.display = 'none';
      }
    }
  }

  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-field]').forEach((el) => {
    el.addEventListener('input', () => {
      const name = el.dataset.field!;
      if ((el as HTMLInputElement).type === 'radio') {
        if ((el as HTMLInputElement).checked) state.formData[name] = el.value;
      } else {
        state.formData[name] = el.value;
      }
      // Auto-grow textareas so the visible height tracks the typed content
      // — replaces the manual resize handle with something native-looking.
      if (el.tagName === 'TEXTAREA') {
        el.style.height = 'auto';
        el.style.height = `${(el as HTMLTextAreaElement).scrollHeight}px`;
      }
      reapplyOther(name);
    });
    if (el.tagName === 'TEXTAREA') {
      // Initial sizing in case there's pre-filled content.
      el.style.height = 'auto';
      el.style.height = `${(el as HTMLTextAreaElement).scrollHeight}px`;
    }
  });
  document.querySelectorAll<HTMLInputElement>('[data-checkbox-field]').forEach((el) => {
    el.addEventListener('change', () => {
      const name = el.dataset.checkboxField!;
      const cur = (state.formData[name] as string[] | undefined) ?? [];
      // Strip any prior "その他: ..." entries so we don't double-add.
      const stripped = cur.filter((v) => !(v === 'その他' || v.startsWith('その他: ')));
      const willBe = el.checked ? [...cur, el.value] : cur.filter((v) => v !== el.value);
      // For non-その他 boxes, just update normally.
      if (el.value !== 'その他') {
        state.formData[name] = willBe;
      } else {
        // The "その他" box itself toggled. Use stripped as base, optionally add.
        state.formData[name] = el.checked ? [...stripped.filter((v) => v !== 'その他'), 'その他'] : stripped;
      }
      reapplyOther(name);
    });
  });
}

async function submit(): Promise<void> {
  if (!state.event || !state.selectedSlot || !state.profile) return;
  if (state.profile.userId === '__preview__') {
    state.error = 'プレビューモードのため、予約は確定できません';
    render();
    return;
  }
  // Validate required fields if form present
  if (state.event.bookingForm) {
    for (const f of state.event.bookingForm.fields) {
      if (f.required) {
        const v = state.formData[f.name];
        const empty = v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
        if (empty) {
          state.error = `「${f.label}」は必須です`;
          render();
          return;
        }
      }
    }
  }
  state.submitting = true;
  state.error = '';
  render();
  try {
    const res = await fetch(`${API_URL}/api/public/events/${encodeURIComponent(state.event.slug)}/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineUserId: state.profile.userId,
        displayName: state.profile.displayName,
        pictureUrl: state.profile.pictureUrl,
        startAt: state.selectedSlot.start,
        formData: state.event.bookingForm ? state.formData : undefined,
        ticket: bookingTicket || undefined,
      }),
    });
    const json = (await res.json()) as { success: boolean; error?: string };
    if (!json.success) throw new Error(json.error ?? '予約に失敗しました');
    renderSuccess();
  } catch (e) {
    state.error = e instanceof Error ? e.message : 'エラー';
    state.submitting = false;
    render();
  }
}

function renderSuccess(): void {
  const app = document.getElementById('app');
  if (!app) return;
  const slot = state.selectedSlot!;
  const start = new Date(slot.start);
  const dt = `${start.getFullYear()}/${String(start.getMonth() + 1).padStart(2, '0')}/${String(start.getDate()).padStart(2, '0')} ${fmtTime(slot.start)}`;
  app.innerHTML = `
    <div class="form-page">
      <div class="success-card">
        <div class="success-icon">✓</div>
        <h2>予約が確定しました</h2>
        <p class="success-message">${escapeHtml(state.event!.name)}<br>${dt}<br><br>確認メッセージをLINEで送信しました。</p>
        <button class="close-btn" id="closeBtn">閉じる</button>
      </div>
    </div>
  `;
  document.getElementById('closeBtn')?.addEventListener('click', () => {
    if (liff.isInClient()) liff.closeWindow();
    else window.location.href = '/';
  });
}

export async function initEventBooking(slug: string | null, ticket?: string | null): Promise<void> {
  if (!slug) {
    state.error = 'slugが指定されていません';
    render();
    return;
  }
  bookingTicket = (ticket ?? '').trim();
  const isPreview = new URLSearchParams(window.location.search).get('preview') === '1';
  if (isPreview) {
    // Stub profile so the booking form can render and the operator can
    // walk through the flow in a regular browser. We block the final
    // submit so a preview click doesn't create a real booking.
    state.profile = { userId: '__preview__', displayName: 'プレビューユーザー' };
  } else {
    try {
      state.profile = await liff.getProfile();
    } catch (e) {
      console.error('getProfile failed:', e);
    }
  }
  try {
    await loadEvent(slug);
    await loadWeekSlots();
  } catch (e) {
    state.error = e instanceof Error ? e.message : 'エラー';
    render();
  }
}
