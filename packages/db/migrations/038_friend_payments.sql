-- Per-friend payment ledger.
-- One row per payment event so we can show history (date + amount) and
-- aggregate totals per friend, per entry route, etc.
-- Manually input by operator from friend detail / chat sidebar.

CREATE TABLE IF NOT EXISTS friend_payments (
  id          TEXT PRIMARY KEY,
  friend_id   TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  amount      INTEGER NOT NULL,
  note        TEXT,
  paid_at     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_friend_payments_friend ON friend_payments (friend_id);
CREATE INDEX IF NOT EXISTS idx_friend_payments_paid_at ON friend_payments (paid_at);
