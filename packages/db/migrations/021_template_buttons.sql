-- Allow 'buttons' as a templates.message_type so operators can save
-- LINE Buttons Template messages (image + title + 1-4 buttons).
-- SQLite cannot ALTER a CHECK constraint, so we rebuild the table.

CREATE TABLE templates_new (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'general',
  message_type    TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'carousel', 'buttons')),
  message_content TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

INSERT INTO templates_new (id, name, category, message_type, message_content, created_at, updated_at)
  SELECT id, name, category, message_type, message_content, created_at, updated_at
  FROM templates;

DROP TABLE templates;

ALTER TABLE templates_new RENAME TO templates;

CREATE INDEX IF NOT EXISTS idx_templates_category ON templates (category);
