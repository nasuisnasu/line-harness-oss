-- Operators want to customise the reminder copy per event (different
-- consultations have different prep instructions). Until now the reminder
-- text was hardcoded in booking-reminders.ts; with these columns each
-- event can override the day-before / hour-before message bodies.
--
-- Both columns are nullable; NULL means "use the built-in default text"
-- so existing rows keep their current behaviour.

ALTER TABLE event_consultation_configs ADD COLUMN reminder_day_before_message TEXT;
ALTER TABLE event_consultation_configs ADD COLUMN reminder_hour_before_message TEXT;
