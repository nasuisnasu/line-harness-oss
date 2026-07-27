-- Auto-reply rules predate the multi-account era and only knew about
-- text/image/flex responses. We're widening them so they can:
--   - drop a saved template into the reply
--   - tag the friend
--   - enroll the friend into a scenario
-- and so each rule belongs to a specific LINE OA (the same rule firing on
-- two OAs at once was a design accident from the single-account days).
--
-- response_content semantics by response_type:
--   text             → the literal text to reply
--   template         → templates.id (snapshot fetched at fire time)
--   add_tag          → tags.id
--   enroll_scenario  → scenarios.id

ALTER TABLE auto_replies ADD COLUMN line_account_id TEXT;
ALTER TABLE auto_replies ADD COLUMN updated_at TEXT;
