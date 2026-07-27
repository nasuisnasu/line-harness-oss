-- 生徒ごとの授業記録（回数制プランの消化管理）。
-- type='contract' : 契約（count に契約回数。例 +10）
-- type='lesson'   : 授業実施（count=1 消化）
-- type='cancel'   : キャンセル（count=1 消化。キャンセルも1回分消化とする）
-- 残り回数 = SUM(contract.count) - (実施件数 + キャンセル件数)
CREATE TABLE IF NOT EXISTS friend_lesson_records (
  id          TEXT PRIMARY KEY,
  friend_id   TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 1,
  record_date TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_lesson_records_friend ON friend_lesson_records (friend_id);
CREATE INDEX IF NOT EXISTS idx_lesson_records_date ON friend_lesson_records (record_date);
