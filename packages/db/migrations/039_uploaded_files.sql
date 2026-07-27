-- Metadata for files uploaded via the admin file uploader.
-- R2 stores the binary keyed by `key`; this table tracks ownership / display name
-- so the UI can list per-account and the operator can find old uploads.

CREATE TABLE IF NOT EXISTS uploaded_files (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT,
  filename        TEXT NOT NULL,
  r2_key          TEXT NOT NULL,
  original_name   TEXT,
  size            INTEGER,
  content_type    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_uploaded_files_account ON uploaded_files (line_account_id);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_created ON uploaded_files (created_at);
