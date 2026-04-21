-- Migration 008: Add line_account_id to friends table
-- Recreate friends table to replace UNIQUE(line_user_id) with UNIQUE(line_user_id, line_account_id)

CREATE TABLE friends_new (
  id               TEXT PRIMARY KEY,
  line_account_id  TEXT,
  line_user_id     TEXT NOT NULL,
  display_name     TEXT,
  picture_url      TEXT,
  status_message   TEXT,
  is_following     INTEGER NOT NULL DEFAULT 1,
  user_id          TEXT,
  score            INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  ref_code         TEXT,
  metadata         TEXT NOT NULL DEFAULT '{}',
  UNIQUE(line_user_id, line_account_id)
);

INSERT INTO friends_new (id, line_account_id, line_user_id, display_name, picture_url, status_message, is_following, user_id, score, created_at, updated_at, ref_code, metadata)
  SELECT id, NULL, line_user_id, display_name, picture_url, status_message, is_following, user_id, score, created_at, updated_at, ref_code, metadata
  FROM friends;

DROP TABLE friends;

ALTER TABLE friends_new RENAME TO friends;

CREATE INDEX IF NOT EXISTS idx_friends_line_user_id ON friends(line_user_id);
CREATE INDEX IF NOT EXISTS idx_friends_user_id ON friends(user_id);
CREATE INDEX IF NOT EXISTS idx_friends_line_account_id ON friends(line_account_id);
