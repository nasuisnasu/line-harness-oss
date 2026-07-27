-- Bulk operator actions: not message broadcasts but side-effect actions
-- against a friend segment. Mirrors L-step's "アクション" concept so the
-- operator can fire-and-forget things like:
--   - enroll a tagged segment into a follow-up scenario
--   - bulk-attach a tag to a segment
--   - swap each friend's rich menu to a different one
--
-- Why a separate table from `broadcasts`:
-- - Broadcasts have message_content / message_type semantics that make no
--   sense for these actions; we'd be threading null sentinels everywhere.
-- - Operators need a separate audit trail ("who got tagged when") that
--   doesn't pollute the broadcast send log.
--
-- target_spec stores the segment definition as JSON to keep the row small
-- regardless of which targeting mode is used (all / tag include / tag
-- exclude / explicit friend ids).

CREATE TABLE IF NOT EXISTS bulk_actions (
  id               TEXT PRIMARY KEY,
  line_account_id  TEXT,
  name             TEXT NOT NULL,
  action_type      TEXT NOT NULL CHECK (action_type IN ('enroll_scenario', 'add_tag', 'set_richmenu')),
  action_payload   TEXT NOT NULL,   -- JSON, schema depends on action_type
  target_spec      TEXT NOT NULL,   -- JSON: { mode: 'all'|'tag_include'|'tag_exclude', tagId?: string }
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  total_targets    INTEGER NOT NULL DEFAULT 0,
  processed_count  INTEGER NOT NULL DEFAULT 0,
  failed_count     INTEGER NOT NULL DEFAULT 0,
  error_log        TEXT,
  scheduled_at     TEXT,
  executed_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_bulk_actions_account ON bulk_actions (line_account_id);
CREATE INDEX IF NOT EXISTS idx_bulk_actions_status ON bulk_actions (status);
CREATE INDEX IF NOT EXISTS idx_bulk_actions_created ON bulk_actions (created_at);
