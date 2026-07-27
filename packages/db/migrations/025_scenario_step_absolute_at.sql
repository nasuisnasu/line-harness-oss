-- Add a third delivery mode: absolute calendar date+time. Operators wanted
-- to schedule a step for "2026-05-01 10:00 JST" rather than "N days after
-- enrollment", so the welcome blast for an upcoming event can fire on the
-- right calendar date regardless of when each friend enrolled.
--
--   delay_mode='absolute' → use delay_at (ISO datetime, treated as JST)
--
-- Existing rows keep their delay_mode and ignore this column.

ALTER TABLE scenario_steps ADD COLUMN delay_at TEXT;
