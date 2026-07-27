-- Absolute-time delivery mode for scenario steps. Operators wanted "N
-- days after enrollment, at HH:MM JST" instead of just "M minutes after
-- enrollment". We store both modes on the row and read `delay_mode` to
-- decide which fields to use.
--
--   delay_mode='relative'      → use existing delay_minutes
--   delay_mode='days_at_time'  → use delay_days + delay_time (HH:MM JST)
--
-- delay_minutes stays for back-compat; existing rows default to 'relative'
-- and behave exactly as before.

ALTER TABLE scenario_steps ADD COLUMN delay_mode TEXT NOT NULL DEFAULT 'relative';
ALTER TABLE scenario_steps ADD COLUMN delay_days INTEGER;
ALTER TABLE scenario_steps ADD COLUMN delay_time TEXT;
