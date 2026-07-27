-- Calendar booking events (= 「個別相談」 type for now; seminar comes later).
--
-- Why split into events + event_consultation_configs:
-- - The parent `events` row is what the LIFF deep-link points at and what
--   the admin lists / toggles active.
-- - Sub-config tables let us add seminar-specific fields later without
--   muddying the consultation row schema (定員 / 開催日時固定 / etc).
--
-- calendar_bookings.event_id is already taken (= Google Calendar event id),
-- so we add `app_event_id` as the reference back to the parent event.

CREATE TABLE IF NOT EXISTS events (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT,
  name            TEXT NOT NULL,
  description     TEXT,
  event_type      TEXT NOT NULL CHECK (event_type IN ('consultation', 'seminar')),
  slug            TEXT NOT NULL UNIQUE,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_events_account ON events (line_account_id);
CREATE INDEX IF NOT EXISTS idx_events_slug ON events (slug);

CREATE TABLE IF NOT EXISTS event_consultation_configs (
  event_id                       TEXT PRIMARY KEY REFERENCES events (id) ON DELETE CASCADE,
  duration_minutes               INTEGER NOT NULL DEFAULT 30,
  buffer_before_minutes          INTEGER NOT NULL DEFAULT 0,
  buffer_after_minutes           INTEGER NOT NULL DEFAULT 10,
  advance_min_hours              INTEGER NOT NULL DEFAULT 24,
  advance_max_days               INTEGER NOT NULL DEFAULT 30,
  calendar_view_mode             TEXT NOT NULL DEFAULT 'week' CHECK (calendar_view_mode IN ('month', 'week')),
  business_hours_json            TEXT NOT NULL DEFAULT '{"mon":["10:00","18:00"],"tue":["10:00","18:00"],"wed":["10:00","18:00"],"thu":["10:00","18:00"],"fri":["10:00","18:00"],"sat":null,"sun":null}',
  blackout_dates_json            TEXT NOT NULL DEFAULT '[]',
  google_calendar_connection_id  TEXT REFERENCES google_calendar_connections (id) ON DELETE SET NULL,
  form_id                        TEXT REFERENCES forms (id) ON DELETE SET NULL,
  on_complete_tag_id             TEXT REFERENCES tags (id) ON DELETE SET NULL,
  on_complete_scenario_id        TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  zoom_url                       TEXT,
  reminder_day_before            INTEGER NOT NULL DEFAULT 1,        -- 1=ON, 0=OFF
  reminder_day_before_at         TEXT NOT NULL DEFAULT '09:00',     -- HH:MM JST
  reminder_hour_before           INTEGER NOT NULL DEFAULT 1,        -- 1=ON, 0=OFF
  reminder_hour_before_minutes   INTEGER NOT NULL DEFAULT 60,       -- 開始の何分前
  updated_at                     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

ALTER TABLE calendar_bookings ADD COLUMN app_event_id TEXT REFERENCES events (id) ON DELETE SET NULL;
ALTER TABLE calendar_bookings ADD COLUMN form_submission_id TEXT;
ALTER TABLE calendar_bookings ADD COLUMN reminder_day_before_sent_at TEXT;
ALTER TABLE calendar_bookings ADD COLUMN reminder_hour_before_sent_at TEXT;
CREATE INDEX IF NOT EXISTS idx_calendar_bookings_app_event ON calendar_bookings (app_event_id);
