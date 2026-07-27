-- The slot generator was stepping by `duration + buffer_after` which made
-- bookings only available every 90 minutes when an operator wanted a
-- 60-minute consultation with 30-minute buffers. The "every N minutes"
-- grid for the slot picker is its own concept, separate from buffer.
--
-- Default 30 = the operator can offer a fresh slot every half hour, with
-- the buffers blocking the *neighbouring* grid cells when a booking lands.

ALTER TABLE event_consultation_configs ADD COLUMN slot_interval_minutes INTEGER NOT NULL DEFAULT 30;
