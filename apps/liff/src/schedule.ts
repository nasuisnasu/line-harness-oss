/**
 * LIFF 営業カレンダー（読み取り専用）
 *
 * 生徒がリッチメニューから開く。先生の休業日を月カレンダーで確認できる。
 * データは公開エンドポイントから取得（ログイン不要）。
 *
 * URL: ?page=schedule&lineAccountId=xxx&liffId=xxx
 */

const API_URL = import.meta.env?.VITE_API_URL || 'http://localhost:8787';

interface ScheduleData {
  closedWeekdays: number[];
  closedDates: string[];
  notice: string | null;
}

interface ScheduleState {
  year: number;
  month: number; // 0-indexed
  data: ScheduleData;
  loading: boolean;
}

const state: ScheduleState = {
  year: new Date().getFullYear(),
  month: new Date().getMonth(),
  data: { closedWeekdays: [], closedDates: [], notice: null },
  loading: true,
};

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getApp(): HTMLElement {
  return document.getElementById('app')!;
}

function dateToString(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isClosed(year: number, month: number, day: number): boolean {
  const dateStr = dateToString(year, month, day);
  if (state.data.closedDates.includes(dateStr)) return true;
  const weekday = new Date(year, month, day).getDay();
  return state.data.closedWeekdays.includes(weekday);
}

function isToday(year: number, month: number, day: number): boolean {
  const now = new Date();
  return now.getFullYear() === year && now.getMonth() === month && now.getDate() === day;
}

const STYLE = `
  <style>
    .sch-wrap { padding: 16px; max-width: 480px; margin: 0 auto; }
    .sch-title { font-size: 18px; font-weight: 700; text-align: center; margin: 4px 0 12px; color: #1f2937; }
    .cal-day.closed {
      background: #fee2e2;
      color: #b91c1c;
      font-weight: 700;
      border-radius: 8px;
    }
    .cal-day.closed::after {
      content: '休';
      display: block;
      font-size: 9px;
      line-height: 1;
      margin-top: 1px;
    }
    .sch-notice {
      margin-top: 16px;
      background: #fffbeb;
      border: 1px solid #fde68a;
      color: #92400e;
      border-radius: 8px;
      padding: 12px 14px;
      font-size: 13px;
      line-height: 1.7;
      white-space: pre-wrap;
    }
    .sch-legend { display: flex; gap: 16px; justify-content: center; margin-top: 12px; font-size: 12px; color: #6b7280; }
    .sch-legend .chip { display: inline-block; width: 14px; height: 14px; border-radius: 4px; vertical-align: -2px; margin-right: 4px; }
    .sch-legend .chip.closed { background: #fee2e2; border: 1px solid #fca5a5; }
  </style>
`;

function render(): void {
  const app = getApp();
  const { year, month, loading } = state;
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];

  if (loading) {
    app.innerHTML = `${STYLE}<div class="sch-wrap"><p style="text-align:center;color:#9ca3af;padding:40px 0;">読み込み中…</p></div>`;
    return;
  }

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay();

  let cells = '';
  for (let i = 0; i < firstDay; i++) cells += '<span class="cal-day empty"></span>';
  for (let day = 1; day <= daysInMonth; day++) {
    const wd = new Date(year, month, day).getDay();
    const classes = [
      'cal-day',
      isClosed(year, month, day) ? 'closed' : 'active',
      isToday(year, month, day) ? 'today' : '',
      wd === 0 ? 'sun' : '',
      wd === 6 ? 'sat' : '',
    ].filter(Boolean).join(' ');
    cells += `<span class="${classes}">${day}</span>`;
  }

  const noticeHtml = state.data.notice
    ? `<div class="sch-notice">${escapeHtml(state.data.notice)}</div>`
    : '';

  app.innerHTML = `
    ${STYLE}
    <div class="sch-wrap">
      <div class="sch-title">営業カレンダー</div>
      <div class="booking-calendar">
        <div class="calendar-header">
          <button class="cal-nav" data-action="prev-month">&lt;</button>
          <span class="cal-title">${year}年${month + 1}月</span>
          <button class="cal-nav" data-action="next-month">&gt;</button>
        </div>
        <div class="cal-weekdays">
          ${weekdays.map((d, i) => `<span class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${d}</span>`).join('')}
        </div>
        <div class="cal-days">${cells}</div>
      </div>
      <div class="sch-legend"><span><span class="chip closed"></span>休業日</span></div>
      ${noticeHtml}
    </div>
  `;

  app.querySelector('[data-action="prev-month"]')?.addEventListener('click', () => {
    if (state.month === 0) { state.month = 11; state.year -= 1; } else { state.month -= 1; }
    render();
  });
  app.querySelector('[data-action="next-month"]')?.addEventListener('click', () => {
    if (state.month === 11) { state.month = 0; state.year += 1; } else { state.month += 1; }
    render();
  });
}

export async function initSchedule(lineAccountId: string | null): Promise<void> {
  render();
  if (!lineAccountId) {
    state.loading = false;
    getApp().innerHTML = `${STYLE}<div class="sch-wrap"><p style="text-align:center;color:#ef4444;padding:40px 0;">アカウント情報が取得できませんでした。</p></div>`;
    return;
  }
  try {
    const res = await fetch(`${API_URL}/api/public/accounts/${encodeURIComponent(lineAccountId)}/business-calendar`);
    const json = await res.json() as { success: boolean; data?: ScheduleData };
    if (json.success && json.data) {
      state.data = {
        closedWeekdays: Array.isArray(json.data.closedWeekdays) ? json.data.closedWeekdays : [],
        closedDates: Array.isArray(json.data.closedDates) ? json.data.closedDates : [],
        notice: json.data.notice ?? null,
      };
    }
  } catch {
    /* ネットワークエラーでも空カレンダーを表示する */
  } finally {
    state.loading = false;
    render();
  }
}
