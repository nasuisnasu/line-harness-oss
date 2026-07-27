import { jstNow } from './utils.js';

export interface BusinessCalendar {
  lineAccountId: string;
  /** 毎週の固定休 (0=日〜6=土) */
  closedWeekdays: number[];
  /** 単発の休業日 ('YYYY-MM-DD') */
  closedDates: string[];
  /** 学生向け注意書き */
  notice: string | null;
  updatedAt: string;
}

interface BusinessCalendarRow {
  line_account_id: string;
  closed_weekdays: string;
  closed_dates: string;
  notice: string | null;
  updated_at: string;
}

function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function rowToCalendar(row: BusinessCalendarRow): BusinessCalendar {
  return {
    lineAccountId: row.line_account_id,
    closedWeekdays: parseJsonArray(row.closed_weekdays).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
    closedDates: parseJsonArray(row.closed_dates).map(String),
    notice: row.notice ?? null,
    updatedAt: row.updated_at,
  };
}

/** 設定が無ければ空のデフォルトを返す。 */
export async function getBusinessCalendar(db: D1Database, lineAccountId: string): Promise<BusinessCalendar> {
  const row = await db
    .prepare(`SELECT * FROM business_calendar WHERE line_account_id = ?`)
    .bind(lineAccountId)
    .first<BusinessCalendarRow>();
  if (!row) {
    return { lineAccountId, closedWeekdays: [], closedDates: [], notice: null, updatedAt: '' };
  }
  return rowToCalendar(row);
}

export interface UpsertBusinessCalendarInput {
  closedWeekdays?: number[];
  closedDates?: string[];
  notice?: string | null;
}

export async function upsertBusinessCalendar(
  db: D1Database,
  lineAccountId: string,
  input: UpsertBusinessCalendarInput,
): Promise<BusinessCalendar> {
  const current = await getBusinessCalendar(db, lineAccountId);
  const closedWeekdays = input.closedWeekdays ?? current.closedWeekdays;
  const closedDates = input.closedDates ?? current.closedDates;
  const notice = 'notice' in input ? (input.notice ?? null) : current.notice;
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO business_calendar (line_account_id, closed_weekdays, closed_dates, notice, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(line_account_id) DO UPDATE SET
         closed_weekdays = excluded.closed_weekdays,
         closed_dates = excluded.closed_dates,
         notice = excluded.notice,
         updated_at = excluded.updated_at`,
    )
    .bind(
      lineAccountId,
      JSON.stringify(closedWeekdays),
      JSON.stringify(closedDates),
      notice,
      now,
    )
    .run();

  return { lineAccountId, closedWeekdays, closedDates, notice, updatedAt: now };
}
