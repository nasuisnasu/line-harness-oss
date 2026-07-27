import { jstNow, getLineAccountById, upsertChatOnMessage } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';

/**
 * Send pre-booking reminders for confirmed event bookings.
 *
 * Two reminder slots per booking, controlled per-event in
 * event_consultation_configs:
 *   - day-before: fires once when (now ≥ start_at - 1day) AND now's
 *     wall-clock HH:MM has passed reminder_day_before_at on the day before.
 *   - hour-before: fires once when (now ≥ start_at - reminder_hour_before_minutes).
 *
 * `reminder_*_sent_at` columns gate against double-firing across cron ticks.
 * Cron runs every 5 min, so a window of "we fire if now is within reminder
 * minute and not yet sent" is the simplest model.
 *
 * We fire the message via pushMessage (not reply) since the booking event is
 * the trigger, not an inbound message.
 */
export async function processBookingReminders(db: D1Database): Promise<void> {
  const nowMs = Date.now();
  // Look ahead up to 26h so we can catch day-before reminders that need to
  // fire ~24h ahead at a specific HH:MM.
  const horizonMs = nowMs + 26 * 60 * 60_000;
  const nowIso = new Date(nowMs).toISOString();
  const horizonIso = new Date(horizonMs).toISOString();

  const result = await db
    .prepare(
      `SELECT b.id AS booking_id, b.start_at, b.title, b.status, b.app_event_id,
              b.reminder_day_before_sent_at, b.reminder_hour_before_sent_at,
              b.friend_id,
              f.line_user_id AS friend_line_user_id,
              f.line_account_id AS friend_line_account_id,
              c.reminder_day_before, c.reminder_day_before_at,
              c.reminder_hour_before, c.reminder_hour_before_minutes,
              c.reminder_day_before_message, c.reminder_hour_before_message,
              c.zoom_url,
              e.name AS event_name
       FROM calendar_bookings b
       JOIN friends f ON f.id = b.friend_id
       JOIN events e ON e.id = b.app_event_id
       JOIN event_consultation_configs c ON c.event_id = e.id
       WHERE b.status = 'confirmed'
         AND b.app_event_id IS NOT NULL
         AND b.start_at > ?
         AND b.start_at < ?`,
    )
    .bind(nowIso, horizonIso)
    .all<{
      booking_id: string;
      start_at: string;
      title: string;
      status: string;
      app_event_id: string;
      reminder_day_before_sent_at: string | null;
      reminder_hour_before_sent_at: string | null;
      friend_id: string;
      friend_line_user_id: string;
      friend_line_account_id: string | null;
      reminder_day_before: number;
      reminder_day_before_at: string;
      reminder_hour_before: number;
      reminder_hour_before_minutes: number;
      reminder_day_before_message: string | null;
      reminder_hour_before_message: string | null;
      zoom_url: string | null;
      event_name: string;
    }>();

  for (const r of result.results) {
    const startMs = new Date(r.start_at).getTime();
    const dueDayBefore = r.reminder_day_before === 1 && !r.reminder_day_before_sent_at && computeDayBeforeFire(startMs, r.reminder_day_before_at) <= nowMs;
    const dueHourBefore = r.reminder_hour_before === 1 && !r.reminder_hour_before_sent_at && (startMs - r.reminder_hour_before_minutes * 60_000) <= nowMs;
    if (!dueDayBefore && !dueHourBefore) continue;

    if (!r.friend_line_account_id) continue;
    const account = await getLineAccountById(db, r.friend_line_account_id);
    if (!account) continue;
    const lineClient = new LineClient(account.channel_access_token);

    const jst = new Date(startMs + 9 * 60 * 60_000);
    const dateLabel = `${jst.getUTCFullYear()}/${String(jst.getUTCMonth() + 1).padStart(2, '0')}/${String(jst.getUTCDate()).padStart(2, '0')} ${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;

    if (dueDayBefore) {
      try {
        let text: string;
        if (r.reminder_day_before_message?.trim()) {
          // Custom template; substitute simple placeholders so operators
          // can author once and have date/zoom inserted at fire time.
          text = applyPlaceholders(r.reminder_day_before_message, { event: r.event_name, datetime: dateLabel, zoom: r.zoom_url ?? '' });
        } else {
          const lines = [`【明日のお約束】${r.event_name}`, `日時: ${dateLabel}`];
          if (r.zoom_url) lines.push(`Zoom: ${r.zoom_url}`);
          lines.push('当日お会いできるのを楽しみにしています！');
          text = lines.join('\n');
        }
        await lineClient.pushMessage(r.friend_line_user_id, [{ type: 'text', text }]);
        await logReminderToChat(db, r.friend_id, text);
        await db
          .prepare(`UPDATE calendar_bookings SET reminder_day_before_sent_at = ?, updated_at = ? WHERE id = ?`)
          .bind(jstNow(), jstNow(), r.booking_id)
          .run();
      } catch (e) {
        console.error('day-before reminder failed:', e);
      }
    }

    if (dueHourBefore) {
      try {
        const mins = r.reminder_hour_before_minutes;
        let text: string;
        if (r.reminder_hour_before_message?.trim()) {
          text = applyPlaceholders(r.reminder_hour_before_message, { event: r.event_name, datetime: dateLabel, zoom: r.zoom_url ?? '', minutes: String(mins) });
        } else {
          const lines = [`【まもなく開始】${r.event_name}`, `あと${mins}分後に開始します（${dateLabel}）`];
          if (r.zoom_url) lines.push(`Zoom: ${r.zoom_url}`);
          text = lines.join('\n');
        }
        await lineClient.pushMessage(r.friend_line_user_id, [{ type: 'text', text }]);
        await logReminderToChat(db, r.friend_id, text);
        await db
          .prepare(`UPDATE calendar_bookings SET reminder_hour_before_sent_at = ?, updated_at = ? WHERE id = ?`)
          .bind(jstNow(), jstNow(), r.booking_id)
          .run();
      } catch (e) {
        console.error('hour-before reminder failed:', e);
      }
    }
  }
}

/**
 * Record a sent booking reminder in messages_log + bump the chat row so the
 * operator sees it in the individual chat thread (matches the behaviour of
 * the booking-confirmation push and scenario auto-deliveries).
 */
async function logReminderToChat(db: D1Database, friendId: string, text: string): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
         VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, ?)`,
      )
      .bind(crypto.randomUUID(), friendId, text, jstNow())
      .run();
    await upsertChatOnMessage(db, friendId);
  } catch (e) {
    console.error('reminder chat log failed (continuing):', e);
  }
}

function applyPlaceholders(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? `{${key}}`);
}

function computeDayBeforeFire(startMs: number, hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return startMs - 24 * 60 * 60_000; // fallback: 24h before
  // The previous JST calendar day at HH:MM, expressed as UTC ms.
  const startJst = new Date(startMs + 9 * 60 * 60_000);
  const dayBefore = new Date(Date.UTC(startJst.getUTCFullYear(), startJst.getUTCMonth(), startJst.getUTCDate() - 1, parseInt(m[1]!, 10) - 9, parseInt(m[2]!, 10), 0, 0));
  return dayBefore.getTime();
}
