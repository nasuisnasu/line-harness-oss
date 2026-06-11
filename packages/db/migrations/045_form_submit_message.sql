-- Allow the operator to send a plain-text LINE reply on form submission
-- in addition to (or instead of) starting a scenario. Empty/NULL = no reply.
ALTER TABLE forms ADD COLUMN on_submit_message TEXT;
