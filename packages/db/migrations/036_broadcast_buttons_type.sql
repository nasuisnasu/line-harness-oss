-- Templates can carry message_type='buttons' (LINE Buttons template).
-- broadcasts.message_type still rejects it via CHECK, so picking a buttons
-- template as the main broadcast message would error out. Widen the CHECK.

CREATE TABLE broadcasts_new (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT,
  title             TEXT NOT NULL,
  message_type      TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'buttons')),
  message_content   TEXT NOT NULL,
  messages_json     TEXT,
  target_type       TEXT NOT NULL CHECK (target_type IN ('all', 'tag')) DEFAULT 'all',
  target_tag_id     TEXT REFERENCES tags (id) ON DELETE SET NULL,
  target_tag_mode   TEXT NOT NULL DEFAULT 'include' CHECK (target_tag_mode IN ('include', 'exclude')),
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent')),
  scheduled_at      TEXT,
  sent_at           TEXT,
  total_count       INTEGER NOT NULL DEFAULT 0,
  success_count     INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

INSERT INTO broadcasts_new (
  id, line_account_id, title, message_type, message_content, messages_json,
  target_type, target_tag_id, target_tag_mode, status, scheduled_at, sent_at,
  total_count, success_count, created_at
)
SELECT
  id, line_account_id, title, message_type, message_content, messages_json,
  target_type, target_tag_id, target_tag_mode, status, scheduled_at, sent_at,
  total_count, success_count, created_at
FROM broadcasts;

DROP TABLE broadcasts;
ALTER TABLE broadcasts_new RENAME TO broadcasts;
CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts (status);
