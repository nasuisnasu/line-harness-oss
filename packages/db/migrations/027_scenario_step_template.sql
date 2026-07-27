-- Remember which template a scenario step was filled from so the step
-- editor can re-open in template-picker mode instead of dumping the raw
-- JSON into the textarea. Operators kept losing the "this step is the
-- 参加者アンケート template" framing on edit and ended up with weird
-- mixed state (preview + JSON + new "buttons" type) on re-save.
--
-- ON DELETE SET NULL: deleting a template should not cascade-delete the
-- scenario step. The step keeps its own snapshot in message_type +
-- message_content, just minus the back-reference.

ALTER TABLE scenario_steps ADD COLUMN template_id TEXT REFERENCES templates (id) ON DELETE SET NULL;
