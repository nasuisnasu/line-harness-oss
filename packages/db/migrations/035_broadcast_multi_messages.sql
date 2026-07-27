-- One broadcast can now carry multiple messages (text / image / flex) so the
-- operator can build a "story" send (intro text → banner image → CTA text)
-- without having to schedule 3 separate broadcasts. LINE's pushMessage
-- accepts up to 5 messages per request, so we cap at 5.
--
-- messages_json holds a JSON array of { type, content }. When present it
-- supersedes the legacy message_type / message_content fields. Existing
-- single-message broadcasts keep working — we read the new field first
-- and fall back to the old shape.

ALTER TABLE broadcasts ADD COLUMN messages_json TEXT;
