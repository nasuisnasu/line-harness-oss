-- 授業教材の素材（生徒 → 講師）
--
-- 生徒が「次の授業で使う長文」を出してくる。講師（ローカルのClaude）が
-- pending を取りに来て、kyozai パイプラインに流す。
--
-- 入口は2つ。source で区別する。
--   talk … 普通のトークに写真・PDF・Word を投げた（こちらが主）
--   liff … 提出フォームから出した
--
-- ファイルの実体は R2（UPLOADS）の submissions/<submission_id>/<seq>.<ext>。
-- ここはメタデータと状態だけ持つ。
--
-- status の遷移は pending → building → done。
-- 失敗は failed、教材じゃなかった（雑談の写真など）は skipped。
-- **行を消さない。**消すと、同じ写真を毎回また拾ってしまう。

CREATE TABLE IF NOT EXISTS material_submissions (
  id              TEXT PRIMARY KEY,
  friend_id       TEXT NOT NULL,
  line_account_id TEXT,
  student_name    TEXT NOT NULL,
  note            TEXT,
  file_count      INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  source          TEXT NOT NULL DEFAULT 'talk',
  result_note     TEXT,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  processed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_material_submissions_status
  ON material_submissions (status, created_at);
CREATE INDEX IF NOT EXISTS idx_material_submissions_friend
  ON material_submissions (friend_id, created_at);

CREATE TABLE IF NOT EXISTS material_submission_files (
  id            TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  r2_key        TEXT NOT NULL,
  original_name TEXT,
  content_type  TEXT NOT NULL,
  size          INTEGER NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES material_submissions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_material_submission_files_sub
  ON material_submission_files (submission_id, seq);
