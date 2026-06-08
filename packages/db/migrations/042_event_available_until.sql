-- Optional absolute end date for bookings.
-- When set, slot generation also requires slot date <= available_until_date.
-- ANDs with the relative `advance_max_days` window.
ALTER TABLE event_consultation_configs ADD COLUMN available_until_date TEXT;
