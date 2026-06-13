import { Hono } from 'hono';
import {
  jstNow,
  getLineAccountById,
  addTagToFriend,
  enrollFriendInScenario,
  getFriendByLineUserId,
  upsertFriend,
  upsertChatOnMessage,
} from '@line-crm/db';
import { GoogleCalendarClient } from '../services/google-calendar.js';
import { getServiceAccountAccessToken } from '../services/google-sa-auth.js';
import { notifyEventBooked } from '../services/discord-notify.js';
import { LineClient } from '@line-crm/line-sdk';
import type { Env } from '../index.js';

/**
 * Events: calendar-booking and seminar wrappers.
 *
 * Currently only `consultation` is implemented. The shape is split into:
 *   - events                       (parent: name / slug / type / active)
 *   - event_consultation_configs   (slot rules, GCal binding, completion actions)
 *   - calendar_bookings.app_event_id (back-reference from each booking)
 *
 * Public endpoints under /api/public/events/* are allow-listed in the auth
 * middleware so a LIFF user without an API key can fetch the booking page.
 *
 * Slot calculation runs locally (business hours x duration x buffers) and
 * subtracts both the GCal freeBusy result and existing app_bookings to
 * produce a list of free starts. The same window is checked twice on
 * booking creation to defend against double-booking races.
 */
const events = new Hono<Env>();

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

interface DbEvent {
  id: string;
  line_account_id: string | null;
  name: string;
  description: string | null;
  event_type: 'consultation' | 'seminar';
  slug: string;
  is_active: number;
  recruitment_paused: number;
  funnel_role: 'top' | 'mid' | null;
  event_format: 'seminar' | 'individual' | null;
  created_at: string;
  updated_at: string;
}

interface DbConsultationConfig {
  event_id: string;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  advance_min_hours: number;
  advance_max_days: number;
  calendar_view_mode: 'week' | 'month';
  business_hours_json: string;
  blackout_dates_json: string;
  google_calendar_connection_id: string | null;
  form_id: string | null;
  on_complete_tag_id: string | null;
  on_complete_scenario_id: string | null;
  zoom_url: string | null;
  reminder_day_before: number;
  reminder_day_before_at: string;
  reminder_hour_before: number;
  reminder_hour_before_minutes: number;
  reminder_day_before_message: string | null;
  reminder_hour_before_message: string | null;
  confirmation_message: string | null;
  slot_interval_minutes: number;
  booking_form_fields_json: string;
  booking_form_submit_label: string | null;
  available_until_date: string | null;
}

type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

interface BusinessHours {
  [k: string]: [string, string] | null;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function serializeEvent(row: DbEvent) {
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    name: row.name,
    description: row.description,
    eventType: row.event_type,
    slug: row.slug,
    isActive: !!row.is_active,
    recruitmentPaused: !!row.recruitment_paused,
    funnelRole: row.funnel_role ?? null,
    eventFormat: row.event_format ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeConsultationConfig(row: DbConsultationConfig) {
  return {
    eventId: row.event_id,
    durationMinutes: row.duration_minutes,
    bufferBeforeMinutes: row.buffer_before_minutes,
    bufferAfterMinutes: row.buffer_after_minutes,
    advanceMinHours: row.advance_min_hours,
    advanceMaxDays: row.advance_max_days,
    calendarViewMode: row.calendar_view_mode,
    businessHours: JSON.parse(row.business_hours_json) as BusinessHours,
    blackoutDates: JSON.parse(row.blackout_dates_json) as string[],
    googleCalendarConnectionId: row.google_calendar_connection_id,
    formId: row.form_id,
    onCompleteTagId: row.on_complete_tag_id,
    onCompleteScenarioId: row.on_complete_scenario_id,
    zoomUrl: row.zoom_url,
    reminderDayBefore: !!row.reminder_day_before,
    reminderDayBeforeAt: row.reminder_day_before_at,
    reminderHourBefore: !!row.reminder_hour_before,
    reminderHourBeforeMinutes: row.reminder_hour_before_minutes,
    reminderDayBeforeMessage: row.reminder_day_before_message,
    reminderHourBeforeMessage: row.reminder_hour_before_message,
    confirmationMessage: row.confirmation_message,
    slotIntervalMinutes: row.slot_interval_minutes,
    bookingFormFields: JSON.parse(row.booking_form_fields_json || '[]') as unknown[],
    bookingFormSubmitLabel: row.booking_form_submit_label,
    availableUntilDate: row.available_until_date,
  };
}

function jstDateOnly(d: Date): string {
  // YYYY-MM-DD in JST. We add 9h to UTC then read UTC fields, mirroring
  // the rest of the codebase.
  const jst = new Date(d.getTime() + 9 * 60 * 60_000);
  return jst.toISOString().slice(0, 10);
}

function weekdayKey(d: Date): Weekday {
  const jst = new Date(d.getTime() + 9 * 60 * 60_000);
  // 0=Sun ... 6=Sat in UTC after the +9 shift
  const dow = jst.getUTCDay();
  return (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as Weekday[])[dow];
}

function jstDateAt(dateStr: string, hhmm: string): Date {
  // Treat dateStr (YYYY-MM-DD) and hhmm as JST wall-clock, return a Date
  // whose UTC ms equals that JST instant.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const t = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m || !t) throw new Error('invalid date/time');
  const y = parseInt(m[1]!, 10);
  const mo = parseInt(m[2]!, 10) - 1;
  const d = parseInt(m[3]!, 10);
  const hh = parseInt(t[1]!, 10);
  const mm = parseInt(t[2]!, 10);
  // JST is UTC+9
  return new Date(Date.UTC(y, mo, d, hh - 9, mm, 0, 0));
}

function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Resolves an access_token for a calendar connection, abstracting whether
 * the row stores a long-lived OAuth access_token or relies on the global
 * Service Account secret (auth_type='service_account').
 */
async function resolveCalendarAccessToken(
  conn: { auth_type: string; access_token: string | null },
  saJson: string | undefined,
): Promise<string | null> {
  if (conn.auth_type === 'service_account') {
    if (!saJson) {
      console.error('Service account auth requested but GOOGLE_SA_JSON env not set');
      return null;
    }
    try {
      return await getServiceAccountAccessToken(saJson);
    } catch (e) {
      console.error('SA token fetch failed:', e);
      return null;
    }
  }
  return conn.access_token;
}

async function getEventBySlug(db: D1Database, slug: string): Promise<DbEvent | null> {
  return db.prepare(`SELECT * FROM events WHERE slug = ?`).bind(slug).first<DbEvent>();
}

async function getConsultationConfig(db: D1Database, eventId: string): Promise<DbConsultationConfig | null> {
  return db.prepare(`SELECT * FROM event_consultation_configs WHERE event_id = ?`).bind(eventId).first<DbConsultationConfig>();
}

// ──────────────────────────────────────────────────────────────────────────
// Admin: Events CRUD
// ──────────────────────────────────────────────────────────────────────────

events.get('/api/events', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    const stmt = lineAccountId
      ? c.env.DB.prepare(`SELECT * FROM events WHERE line_account_id = ? ORDER BY created_at DESC`).bind(lineAccountId)
      : c.env.DB.prepare(`SELECT * FROM events ORDER BY created_at DESC`);
    const result = await stmt.all<DbEvent>();
    return c.json({ success: true, data: result.results.map(serializeEvent) });
  } catch (err) {
    console.error('GET /api/events error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

events.get('/api/events/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const row = await c.env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first<DbEvent>();
    if (!row) return c.json({ success: false, error: 'Not found' }, 404);
    const config = await getConsultationConfig(c.env.DB, id);
    return c.json({
      success: true,
      data: {
        ...serializeEvent(row),
        consultationConfig: config ? serializeConsultationConfig(config) : null,
      },
    });
  } catch (err) {
    console.error('GET /api/events/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

events.post('/api/events', async (c) => {
  try {
    const body = await c.req.json<{
      name: string;
      description?: string | null;
      eventType: 'consultation' | 'seminar';
      slug: string;
      isActive?: boolean;
    }>();
    if (!body.name || !body.eventType || !body.slug) {
      return c.json({ success: false, error: 'name, eventType, slug are required' }, 400);
    }
    if (!/^[a-z0-9-]+$/i.test(body.slug)) {
      return c.json({ success: false, error: 'slug は英数字とハイフンのみ' }, 400);
    }
    const lineAccountId = c.req.query('lineAccountId') ?? null;
    const id = crypto.randomUUID();
    const now = jstNow();

    try {
      await c.env.DB
        .prepare(`INSERT INTO events (id, line_account_id, name, description, event_type, slug, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, lineAccountId, body.name, body.description ?? null, body.eventType, body.slug, body.isActive === false ? 0 : 1, now, now)
        .run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE')) return c.json({ success: false, error: 'このslugは既に使われています' }, 400);
      throw err;
    }

    if (body.eventType === 'consultation') {
      // Bootstrap a default config row so the edit screen can render.
      await c.env.DB
        .prepare(`INSERT INTO event_consultation_configs (event_id) VALUES (?)`)
        .bind(id)
        .run();
    }

    const created = await c.env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first<DbEvent>();
    return c.json({ success: true, data: serializeEvent(created!) }, 201);
  } catch (err) {
    console.error('POST /api/events error:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, 500);
  }
});

events.put('/api/events/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      name?: string;
      description?: string | null;
      slug?: string;
      isActive?: boolean;
      recruitmentPaused?: boolean;
      funnelRole?: 'top' | 'mid' | null;
      eventFormat?: 'seminar' | 'individual' | null;
      consultationConfig?: Partial<{
        durationMinutes: number;
        bufferBeforeMinutes: number;
        bufferAfterMinutes: number;
        advanceMinHours: number;
        advanceMaxDays: number;
        calendarViewMode: 'week' | 'month';
        businessHours: BusinessHours;
        blackoutDates: string[];
        googleCalendarConnectionId: string | null;
        formId: string | null;
        onCompleteTagId: string | null;
        onCompleteScenarioId: string | null;
        zoomUrl: string | null;
        reminderDayBefore: boolean;
        reminderDayBeforeAt: string;
        reminderHourBefore: boolean;
        reminderHourBeforeMinutes: number;
        reminderDayBeforeMessage: string | null;
        reminderHourBeforeMessage: string | null;
        confirmationMessage: string | null;
        slotIntervalMinutes: number;
        bookingFormFields: unknown[];
        bookingFormSubmitLabel: string | null;
        availableUntilDate: string | null;
      }>;
    }>();

    const sets: string[] = [];
    const vals: unknown[] = [];
    if (body.name !== undefined) { sets.push('name = ?'); vals.push(body.name); }
    if ('description' in body) { sets.push('description = ?'); vals.push(body.description ?? null); }
    if (body.slug !== undefined) { sets.push('slug = ?'); vals.push(body.slug); }
    if (body.isActive !== undefined) { sets.push('is_active = ?'); vals.push(body.isActive ? 1 : 0); }
    if (body.recruitmentPaused !== undefined) { sets.push('recruitment_paused = ?'); vals.push(body.recruitmentPaused ? 1 : 0); }
    if ('funnelRole' in body) { sets.push('funnel_role = ?'); vals.push(body.funnelRole ?? null); }
    if ('eventFormat' in body) { sets.push('event_format = ?'); vals.push(body.eventFormat ?? null); }
    if (sets.length > 0) {
      sets.push('updated_at = ?');
      vals.push(jstNow());
      vals.push(id);
      await c.env.DB.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
    }

    if (body.consultationConfig) {
      const cfg = body.consultationConfig;
      const cSets: string[] = [];
      const cVals: unknown[] = [];
      if (cfg.durationMinutes !== undefined) { cSets.push('duration_minutes = ?'); cVals.push(cfg.durationMinutes); }
      if (cfg.bufferBeforeMinutes !== undefined) { cSets.push('buffer_before_minutes = ?'); cVals.push(cfg.bufferBeforeMinutes); }
      if (cfg.bufferAfterMinutes !== undefined) { cSets.push('buffer_after_minutes = ?'); cVals.push(cfg.bufferAfterMinutes); }
      if (cfg.advanceMinHours !== undefined) { cSets.push('advance_min_hours = ?'); cVals.push(cfg.advanceMinHours); }
      if (cfg.advanceMaxDays !== undefined) { cSets.push('advance_max_days = ?'); cVals.push(cfg.advanceMaxDays); }
      if (cfg.calendarViewMode !== undefined) { cSets.push('calendar_view_mode = ?'); cVals.push(cfg.calendarViewMode); }
      if (cfg.businessHours !== undefined) { cSets.push('business_hours_json = ?'); cVals.push(JSON.stringify(cfg.businessHours)); }
      if (cfg.blackoutDates !== undefined) { cSets.push('blackout_dates_json = ?'); cVals.push(JSON.stringify(cfg.blackoutDates)); }
      if ('googleCalendarConnectionId' in cfg) { cSets.push('google_calendar_connection_id = ?'); cVals.push(cfg.googleCalendarConnectionId ?? null); }
      if ('formId' in cfg) { cSets.push('form_id = ?'); cVals.push(cfg.formId ?? null); }
      if ('onCompleteTagId' in cfg) { cSets.push('on_complete_tag_id = ?'); cVals.push(cfg.onCompleteTagId ?? null); }
      if ('onCompleteScenarioId' in cfg) { cSets.push('on_complete_scenario_id = ?'); cVals.push(cfg.onCompleteScenarioId ?? null); }
      if ('zoomUrl' in cfg) { cSets.push('zoom_url = ?'); cVals.push(cfg.zoomUrl ?? null); }
      if (cfg.reminderDayBefore !== undefined) { cSets.push('reminder_day_before = ?'); cVals.push(cfg.reminderDayBefore ? 1 : 0); }
      if (cfg.reminderDayBeforeAt !== undefined) { cSets.push('reminder_day_before_at = ?'); cVals.push(cfg.reminderDayBeforeAt); }
      if (cfg.reminderHourBefore !== undefined) { cSets.push('reminder_hour_before = ?'); cVals.push(cfg.reminderHourBefore ? 1 : 0); }
      if (cfg.reminderHourBeforeMinutes !== undefined) { cSets.push('reminder_hour_before_minutes = ?'); cVals.push(cfg.reminderHourBeforeMinutes); }
      if ('reminderDayBeforeMessage' in cfg) { cSets.push('reminder_day_before_message = ?'); cVals.push(cfg.reminderDayBeforeMessage ?? null); }
      if ('reminderHourBeforeMessage' in cfg) { cSets.push('reminder_hour_before_message = ?'); cVals.push(cfg.reminderHourBeforeMessage ?? null); }
      if ('confirmationMessage' in cfg) { cSets.push('confirmation_message = ?'); cVals.push(cfg.confirmationMessage ?? null); }
      if (cfg.slotIntervalMinutes !== undefined) { cSets.push('slot_interval_minutes = ?'); cVals.push(cfg.slotIntervalMinutes); }
      if (cfg.bookingFormFields !== undefined) { cSets.push('booking_form_fields_json = ?'); cVals.push(JSON.stringify(cfg.bookingFormFields)); }
      if ('bookingFormSubmitLabel' in cfg) { cSets.push('booking_form_submit_label = ?'); cVals.push(cfg.bookingFormSubmitLabel ?? null); }
      if ('availableUntilDate' in cfg) { cSets.push('available_until_date = ?'); cVals.push(cfg.availableUntilDate ?? null); }
      if (cSets.length > 0) {
        cSets.push('updated_at = ?');
        cVals.push(jstNow());
        cVals.push(id);
        // INSERT-OR-UPDATE: configs row may not exist for legacy events.
        const existing = await getConsultationConfig(c.env.DB, id);
        if (!existing) {
          await c.env.DB.prepare(`INSERT INTO event_consultation_configs (event_id) VALUES (?)`).bind(id).run();
        }
        await c.env.DB.prepare(`UPDATE event_consultation_configs SET ${cSets.join(', ')} WHERE event_id = ?`).bind(...cVals).run();
      }
    }

    const updated = await c.env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first<DbEvent>();
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    const config = await getConsultationConfig(c.env.DB, id);
    return c.json({
      success: true,
      data: {
        ...serializeEvent(updated),
        consultationConfig: config ? serializeConsultationConfig(config) : null,
      },
    });
  } catch (err) {
    console.error('PUT /api/events/:id error:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, 500);
  }
});

events.delete('/api/events/:id', async (c) => {
  try {
    await c.env.DB.prepare(`DELETE FROM events WHERE id = ?`).bind(c.req.param('id')).run();
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/events/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Admin: Bookings list + cancel
// ──────────────────────────────────────────────────────────────────────────

events.get('/api/events/:id/bookings', async (c) => {
  try {
    const id = c.req.param('id');
    const result = await c.env.DB
      .prepare(
        `SELECT b.*, f.display_name AS friend_display_name, f.line_user_id AS friend_line_user_id
         FROM calendar_bookings b
         LEFT JOIN friends f ON f.id = b.friend_id
         WHERE b.app_event_id = ?
         ORDER BY b.start_at ASC`,
      )
      .bind(id)
      .all<{
        id: string;
        connection_id: string;
        friend_id: string | null;
        friend_display_name: string | null;
        friend_line_user_id: string | null;
        event_id: string | null;
        title: string;
        start_at: string;
        end_at: string;
        status: string;
        metadata: string | null;
        created_at: string;
      }>();
    return c.json({
      success: true,
      data: result.results.map((r) => ({
        id: r.id,
        connectionId: r.connection_id,
        friendId: r.friend_id,
        friendDisplayName: r.friend_display_name,
        friendLineUserId: r.friend_line_user_id,
        gcalEventId: r.event_id,
        title: r.title,
        startAt: r.start_at,
        endAt: r.end_at,
        status: r.status,
        metadata: r.metadata ? JSON.parse(r.metadata) : null,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/events/:id/bookings error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

events.post('/api/event-bookings/:bookingId/cancel', async (c) => {
  try {
    const bookingId = c.req.param('bookingId');
    const booking = await c.env.DB
      .prepare(`SELECT * FROM calendar_bookings WHERE id = ?`)
      .bind(bookingId)
      .first<{
        id: string;
        connection_id: string;
        event_id: string | null;
        status: string;
      }>();
    if (!booking) return c.json({ success: false, error: 'Not found' }, 404);

    // Tear down the GCal event so the operator's calendar reflects the cancel.
    if (booking.event_id) {
      try {
        const conn = await c.env.DB
          .prepare(`SELECT * FROM google_calendar_connections WHERE id = ?`)
          .bind(booking.connection_id)
          .first<{ calendar_id: string; access_token: string | null; auth_type: string }>();
        if (conn) {
          const token = await resolveCalendarAccessToken(conn, c.env.GOOGLE_SA_JSON);
          if (token) {
            const gcal = new GoogleCalendarClient({ calendarId: conn.calendar_id, accessToken: token });
            await gcal.deleteEvent(booking.event_id);
          }
        }
      } catch (e) {
        console.error('GCal delete during cancel failed (continuing):', e);
      }
    }

    await c.env.DB
      .prepare(`UPDATE calendar_bookings SET status = 'cancelled', updated_at = ? WHERE id = ?`)
      .bind(jstNow(), bookingId)
      .run();
    return c.json({ success: true, data: { id: bookingId, status: 'cancelled' } });
  } catch (err) {
    console.error('POST /api/event-bookings/:bookingId/cancel error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Public (LIFF): event info + slot search + book
// ──────────────────────────────────────────────────────────────────────────

events.get('/api/public/events/:slug', async (c) => {
  try {
    const slug = c.req.param('slug');
    const event = await getEventBySlug(c.env.DB, slug);
    if (!event || !event.is_active) return c.json({ success: false, error: 'Event not found' }, 404);
    const config = event.event_type === 'consultation' ? await getConsultationConfig(c.env.DB, event.id) : null;

    // Event-specific booking form lives directly on the consultation config
    // now (booking_form_fields_json). The legacy form_id link is ignored
    // here so events stop pulling from the global Forms tab.
    let bookingForm: { fields: unknown[]; submitLabel: string | null } | null = null;
    if (config) {
      const fields = JSON.parse(config.booking_form_fields_json || '[]') as unknown[];
      if (fields.length > 0) {
        bookingForm = { fields, submitLabel: config.booking_form_submit_label };
      }
    }

    return c.json({
      success: true,
      data: {
        id: event.id,
        name: event.name,
        description: event.description,
        eventType: event.event_type,
        slug: event.slug,
        recruitmentPaused: !!event.recruitment_paused,
        consultationConfig: config ? serializeConsultationConfig(config) : null,
        bookingForm,
      },
    });
  } catch (err) {
    console.error('GET /api/public/events/:slug error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

events.get('/api/public/events/:slug/slots', async (c) => {
  try {
    const slug = c.req.param('slug');
    const event = await getEventBySlug(c.env.DB, slug);
    if (!event || !event.is_active || event.event_type !== 'consultation') {
      return c.json({ success: false, error: 'Event not found' }, 404);
    }
    // 募集停止中はスロット生成をスキップして空配列＋フラグを返す
    if (event.recruitment_paused) {
      return c.json({ success: true, data: { slots: [], recruitmentPaused: true } });
    }
    const config = await getConsultationConfig(c.env.DB, event.id);
    if (!config) return c.json({ success: false, error: 'Config missing' }, 500);

    const fromStr = c.req.query('from');
    const toStr = c.req.query('to');
    if (!fromStr || !toStr) return c.json({ success: false, error: 'from / to required (YYYY-MM-DD)' }, 400);

    const businessHours = JSON.parse(config.business_hours_json) as BusinessHours;
    const blackoutDates = JSON.parse(config.blackout_dates_json) as string[];

    // Window guards
    const nowMs = Date.now();
    const advanceMinMs = nowMs + config.advance_min_hours * 60 * 60_000;
    const advanceMaxMs = nowMs + config.advance_max_days * 24 * 60 * 60_000;

    // Pull busy intervals once for the whole window so we don't hit GCal per
    // slot. Local app bookings (active) get added on top.
    const fromIso = jstDateAt(fromStr, '00:00').toISOString();
    const toIsoExclusive = new Date(jstDateAt(toStr, '00:00').getTime() + 24 * 60 * 60_000).toISOString();

    let busy: { start: number; end: number }[] = [];

    const before = config.buffer_before_minutes;
    const after = config.buffer_after_minutes;

    if (config.google_calendar_connection_id) {
      const conn = await c.env.DB
        .prepare(`SELECT * FROM google_calendar_connections WHERE id = ?`)
        .bind(config.google_calendar_connection_id)
        .first<{ calendar_id: string; access_token: string | null; auth_type: string }>();
      if (conn) {
        const token = await resolveCalendarAccessToken(conn, c.env.GOOGLE_SA_JSON);
        if (token) {
          try {
            const gcal = new GoogleCalendarClient({ calendarId: conn.calendar_id, accessToken: token });
            const intervals = await gcal.getFreeBusy(fromIso, toIsoExclusive);
            // Pad GCal busy intervals with the same before/after buffer so a
            // 13:00 calendar entry blocks the prep window before it. Without
            // this, a 12:30 slot (which ends at 13:30 with default 60min
            // duration) only conflicts when the slot itself overlaps the
            // event — buffer never gets a chance to fire.
            busy = intervals.map((i) => ({
              start: new Date(i.start).getTime() - before * 60_000,
              end: new Date(i.end).getTime() + after * 60_000,
            }));
          } catch (e) {
            console.error('GCal freeBusy failed (treating as fully free):', e);
          }
        }
      }
    }

    // For our own bookings, expand by buffer_before/after so the "occupied"
    // range is the full prep+meeting+recovery window. New slots compare
    // against this widened range using their *raw* time, which keeps the
    // semantics intuitive: a 3:30 booking with 30/30 buffer occupies
    // 3:00–5:00, and a fresh 5:00 slot is fine because 5:00 just touches
    // the trailing edge.
    const localBookings = await c.env.DB
      .prepare(`SELECT start_at, end_at FROM calendar_bookings WHERE app_event_id = ? AND status = 'confirmed' AND start_at >= ? AND start_at < ?`)
      .bind(event.id, fromIso, toIsoExclusive)
      .all<{ start_at: string; end_at: string }>();
    for (const b of localBookings.results) {
      busy.push({
        start: new Date(b.start_at).getTime() - before * 60_000,
        end: new Date(b.end_at).getTime() + after * 60_000,
      });
    }

    // Return EVERY candidate within business hours (within the advance
    // window) with an `available` flag, so the LIFF can render a grid that
    // shows ○ / ✕ instead of only the bookable rows.
    const slots: { start: string; end: string; available: boolean }[] = [];
    const totalDuration = config.duration_minutes;
    // The grid step the slot picker walks at — independent from duration so
    // the operator can offer e.g. half-hour starts for a 60-min consultation.
    const stepMinutes = config.slot_interval_minutes ?? 30;

    const availableUntilDate = config.available_until_date;
    for (let cursor = jstDateAt(fromStr, '00:00').getTime(); cursor <= jstDateAt(toStr, '00:00').getTime(); cursor += 24 * 60 * 60_000) {
      const day = new Date(cursor);
      const dateStr = jstDateOnly(day);
      if (blackoutDates.includes(dateStr)) continue;
      if (availableUntilDate && dateStr > availableUntilDate) continue;
      const wd = weekdayKey(day);
      const range = businessHours[wd];
      if (!range) continue;
      const dayStart = jstDateAt(dateStr, range[0]).getTime();
      const dayEnd = jstDateAt(dateStr, range[1]).getTime();

      for (let s = dayStart; s + totalDuration * 60_000 <= dayEnd; s += stepMinutes * 60_000) {
        const start = s;
        const end = s + totalDuration * 60_000;
        if (start > advanceMaxMs) continue;
        // Two reasons to mark unavailable:
        //   - the slot is before the operator's allowed advance-min cutoff
        //   - the slot collides with a busy interval (GCal or another booking)
        const tooSoon = start - before * 60_000 < advanceMinMs;
        const conflict = busy.some((b) => intervalsOverlap(start, end, b.start, b.end));
        slots.push({
          start: new Date(start).toISOString(),
          end: new Date(end).toISOString(),
          available: !tooSoon && !conflict,
        });
      }
    }

    return c.json({ success: true, data: { slots } });
  } catch (err) {
    console.error('GET /api/public/events/:slug/slots error:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, 500);
  }
});

events.post('/api/public/events/:slug/book', async (c) => {
  try {
    const slug = c.req.param('slug');
    const body = await c.req.json<{
      lineUserId: string;
      displayName?: string;
      pictureUrl?: string;
      startAt: string;       // ISO datetime
      formData?: Record<string, unknown>;
    }>();
    if (!body.lineUserId || !body.startAt) {
      return c.json({ success: false, error: 'lineUserId and startAt are required' }, 400);
    }

    const event = await getEventBySlug(c.env.DB, slug);
    if (!event || !event.is_active || event.event_type !== 'consultation') {
      return c.json({ success: false, error: 'Event not found' }, 404);
    }
    if (event.recruitment_paused) {
      return c.json({ success: false, error: '現在募集を停止しています' }, 400);
    }
    const config = await getConsultationConfig(c.env.DB, event.id);
    if (!config) return c.json({ success: false, error: 'Config missing' }, 500);
    if (!event.line_account_id) return c.json({ success: false, error: 'Event has no LINE account binding' }, 400);

    const account = await getLineAccountById(c.env.DB, event.line_account_id);
    if (!account) return c.json({ success: false, error: 'LINE account not found' }, 404);

    // Upsert friend so a brand-new booking from a 1st-time visitor still
    // resolves to a friends row we can tag / push to.
    let friend = await getFriendByLineUserId(c.env.DB, body.lineUserId, event.line_account_id);
    if (!friend) {
      friend = await upsertFriend(c.env.DB, {
        lineUserId: body.lineUserId,
        displayName: body.displayName ?? null,
        pictureUrl: body.pictureUrl ?? null,
        statusMessage: null,
        lineAccountId: event.line_account_id,
      });
    }

    const startMs = new Date(body.startAt).getTime();
    if (Number.isNaN(startMs)) return c.json({ success: false, error: 'invalid startAt' }, 400);
    const endMs = startMs + config.duration_minutes * 60_000;

    // 終了日チェック（availableUntilDate を過ぎたスロットは予約不可）
    if (config.available_until_date) {
      const slotJstDate = new Date(startMs + 9 * 60 * 60_000).toISOString().slice(0, 10);
      if (slotJstDate > config.available_until_date) {
        return c.json({ success: false, error: '予約受付期間を過ぎています' }, 400);
      }
    }

    // One-booking-per-friend guard: prevent the same person from booking
    // the same consultation event more than once (cancellation frees the seat).
    const dupBooking = await c.env.DB
      .prepare(
        `SELECT id, start_at FROM calendar_bookings
         WHERE app_event_id = ? AND friend_id = ? AND status = 'confirmed'
         LIMIT 1`,
      )
      .bind(event.id, friend.id)
      .first<{ id: string; start_at: string }>();
    if (dupBooking) {
      const fmt = new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo',
        month: 'numeric', day: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const when = fmt.format(new Date(dupBooking.start_at)); // e.g. "5/8 14:00"
      return c.json({
        success: false,
        error: `すでにご予約が入っています（${when}）。お一人さま1回限りとなっております。日程変更やキャンセルをご希望の場合は、LINEでご連絡ください。`,
      }, 409);
    }

    // Last-mile race guard: re-check the slot is still available.
    const existing = await c.env.DB
      .prepare(
        `SELECT id FROM calendar_bookings WHERE app_event_id = ? AND status = 'confirmed' AND start_at < ? AND end_at > ?`,
      )
      .bind(event.id, new Date(endMs).toISOString(), new Date(startMs).toISOString())
      .first<{ id: string }>();
    if (existing) return c.json({ success: false, error: 'この枠はすでに予約済みです' }, 409);

    // Event-specific booking form data is stored in the booking's metadata
    // (no separate form_submissions row, since the event isn't a global Form).
    let formSubmissionId: string | null = null;

    // Build a description that ends up on the operator's GCal event so they
    // have everything they need at a glance. Form answers, friend ID, Zoom.
    const descLines: string[] = [];
    descLines.push(`予約: ${event.name}`);
    descLines.push(`友だち: ${friend.display_name ?? body.lineUserId}`);
    if (config.zoom_url) descLines.push(`Zoom: ${config.zoom_url}`);
    if (body.formData) {
      descLines.push('--- フォーム回答 ---');
      for (const [k, v] of Object.entries(body.formData)) {
        descLines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
      }
    }
    const description = descLines.join('\n');

    let gcalEventId: string | null = null;
    if (!config.google_calendar_connection_id) {
      return c.json({ success: false, error: 'Google Calendarが未設定です' }, 400);
    }
    const conn = await c.env.DB
      .prepare(`SELECT * FROM google_calendar_connections WHERE id = ?`)
      .bind(config.google_calendar_connection_id)
      .first<{ calendar_id: string; access_token: string | null; auth_type: string }>();
    if (!conn) return c.json({ success: false, error: 'Google Calendar 接続が見つかりません' }, 400);
    const accessToken = await resolveCalendarAccessToken(conn, c.env.GOOGLE_SA_JSON);
    if (!accessToken) return c.json({ success: false, error: 'Google Calendar 認証エラー' }, 400);
    const gcal = new GoogleCalendarClient({ calendarId: conn.calendar_id, accessToken });
    try {
      const created = await gcal.createEvent({
        summary: `${event.name} / ${friend.display_name ?? body.lineUserId}`,
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        description,
      });
      gcalEventId = created.eventId;
    } catch (e) {
      console.error('GCal createEvent failed:', e);
      return c.json({ success: false, error: 'Google Calendarへの登録に失敗しました' }, 500);
    }

    const bookingId = crypto.randomUUID();
    const now = jstNow();
    await c.env.DB
      .prepare(
        `INSERT INTO calendar_bookings (id, connection_id, friend_id, event_id, app_event_id, form_submission_id, title, start_at, end_at, status, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`,
      )
      .bind(
        bookingId,
        config.google_calendar_connection_id,
        friend.id,
        gcalEventId,
        event.id,
        formSubmissionId,
        event.name,
        new Date(startMs).toISOString(),
        new Date(endMs).toISOString(),
        body.formData ? JSON.stringify({ formData: body.formData }) : null,
        now,
        now,
      )
      .run();

    // Fire-and-forget completion actions. Failures here don't roll back the
    // booking — the operator has the GCal event and will follow up manually.
    try {
      if (config.on_complete_tag_id) await addTagToFriend(c.env.DB, friend.id, config.on_complete_tag_id);
      if (config.on_complete_scenario_id) await enrollFriendInScenario(c.env.DB, friend.id, config.on_complete_scenario_id);
    } catch (e) {
      console.error('Booking completion actions failed (continuing):', e);
    }

    // Confirmation push to the friend. Custom template (with placeholders)
    // wins over the default if the operator has set one.
    try {
      const lineClient = new LineClient(account.channel_access_token);
      const dt = new Date(startMs);
      const jst = new Date(dt.getTime() + 9 * 60 * 60_000);
      const dateLabel = `${jst.getUTCFullYear()}/${String(jst.getUTCMonth() + 1).padStart(2, '0')}/${String(jst.getUTCDate()).padStart(2, '0')} ${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
      let text: string;
      if (config.confirmation_message?.trim()) {
        const tpl = config.confirmation_message;
        text = tpl
          .replace(/\{event\}/g, event.name)
          .replace(/\{datetime\}/g, dateLabel)
          .replace(/\{zoom\}/g, config.zoom_url ?? '')
          .replace(/\{name\}/g, friend.display_name ?? '');
      } else {
        const lines = [`【ご予約完了】${event.name}`, `日時: ${dateLabel}`];
        if (config.zoom_url) lines.push(`Zoom: ${config.zoom_url}`);
        lines.push('当日お会いできるのを楽しみにしています！');
        text = lines.join('\n');
      }
      await lineClient.pushMessage(friend.line_user_id, [{ type: 'text', text }]);
      // Log the outgoing confirmation in messages_log + create/update the
      // chat row so the operator sees this booking conversation in their
      // chat list (matches the behaviour of scenario auto-deliveries).
      await c.env.DB
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
           VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, ?)`,
        )
        .bind(crypto.randomUUID(), friend.id, text, jstNow())
        .run();
      await upsertChatOnMessage(c.env.DB, friend.id);
    } catch (e) {
      console.error('Confirmation push failed (continuing):', e);
    }

    // Discord notification — best-effort, ignore failures.
    try {
      await notifyEventBooked(c.env.DISCORD_WEBHOOK_URL, {
        eventName: event.name,
        friendName: friend.display_name ?? body.lineUserId,
        startAt: new Date(startMs).toISOString(),
        zoomUrl: config.zoom_url,
        formData: body.formData ?? null,
      });
    } catch (e) {
      console.error('Discord notify failed (continuing):', e);
    }

    return c.json({ success: true, data: { id: bookingId, startAt: new Date(startMs).toISOString(), endAt: new Date(endMs).toISOString() } }, 201);
  } catch (err) {
    console.error('POST /api/public/events/:slug/book error:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, 500);
  }
});

export { events };
