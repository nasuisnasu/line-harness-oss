-- The event-specific booking form should not share the Forms tab. Operators
-- want each event's pre-booking questions authored in the event editor
-- itself so it doesn't pollute the global form list.
--
-- We keep the legacy `form_id` column for now (existing rows referencing it
-- continue to work) but the UI surfaces only `booking_form_fields_json`
-- going forward. Empty array = no form, skip the form step in LIFF.

ALTER TABLE event_consultation_configs ADD COLUMN booking_form_fields_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE event_consultation_configs ADD COLUMN booking_form_submit_label TEXT;
