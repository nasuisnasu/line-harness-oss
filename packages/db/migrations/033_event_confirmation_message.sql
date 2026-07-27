-- Operators want to author the post-booking confirmation copy themselves
-- (different consultations want different prep instructions / cancellation
-- policies / etc). Mirrors the reminder_*_message columns.
--
-- NULL = use the built-in default.

ALTER TABLE event_consultation_configs ADD COLUMN confirmation_message TEXT;
