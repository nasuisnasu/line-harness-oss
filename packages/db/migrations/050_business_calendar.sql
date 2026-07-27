-- 営業カレンダー（休業日）設定。アカウントごとに1行。
-- closed_weekdays: 毎週の固定休（JSON配列, 0=日〜6=土）
-- closed_dates:    単発の休業日（JSON配列, 'YYYY-MM-DD'）
-- notice:          学生向けの注意書き（例: 休業日は返信が遅れます）
CREATE TABLE IF NOT EXISTS business_calendar (
  line_account_id TEXT PRIMARY KEY,
  closed_weekdays TEXT NOT NULL DEFAULT '[]',
  closed_dates    TEXT NOT NULL DEFAULT '[]',
  notice          TEXT,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
