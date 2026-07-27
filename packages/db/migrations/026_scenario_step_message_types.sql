-- Allow scenario_steps.message_type to store 'richmenu' and 'buttons'
-- alongside the existing text / image / flex. The CHECK constraint can
-- only be widened by rebuilding the table in SQLite.
--
-- Why this exists:
-- - 'richmenu' is the rich-menu-switch step type (delay-only payload, no
--   message body); the column has carried this value since migration 014
--   even though the CHECK was never updated. Codifying it here so the
--   schema matches the runtime behaviour.
-- - 'buttons' is the LINE Buttons template (image + title + 1-4 actions),
--   surfaced as a saveable template in the /templates UI; without it the
--   scenario UI was being forced to fall back to 'flex' and operators saw
--   their picked template silently change type.
--
-- Carry every column added through migrations 005 (condition_*),
-- 014 (rich_menu_id), 019 (delay_mode/days/time) and 025 (delay_at) so
-- in-flight rows keep the same shape.

CREATE TABLE scenario_steps_new (
  id                 TEXT PRIMARY KEY,
  scenario_id        TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
  step_order         INTEGER NOT NULL,
  delay_minutes      INTEGER NOT NULL DEFAULT 0,
  message_type       TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'richmenu', 'buttons')),
  message_content    TEXT NOT NULL,
  condition_type     TEXT,
  condition_value    TEXT,
  next_step_on_false INTEGER,
  rich_menu_id       TEXT,
  delay_mode         TEXT NOT NULL DEFAULT 'relative',
  delay_days         INTEGER,
  delay_time         TEXT,
  delay_at           TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (scenario_id, step_order)
);

INSERT INTO scenario_steps_new (
  id, scenario_id, step_order, delay_minutes, message_type, message_content,
  condition_type, condition_value, next_step_on_false, rich_menu_id,
  delay_mode, delay_days, delay_time, delay_at, created_at
)
SELECT
  id, scenario_id, step_order, delay_minutes, message_type, message_content,
  condition_type, condition_value, next_step_on_false, rich_menu_id,
  delay_mode, delay_days, delay_time, delay_at, created_at
FROM scenario_steps;

DROP TABLE scenario_steps;
ALTER TABLE scenario_steps_new RENAME TO scenario_steps;

CREATE INDEX IF NOT EXISTS idx_scenario_steps_scenario_id ON scenario_steps (scenario_id);
