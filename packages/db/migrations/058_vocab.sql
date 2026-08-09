-- 058_vocab.sql — 単語テスト（受講生専用）
--
-- 生徒の識別は friends.id。students テーブルは作らない
-- （line_user_id はチャネルごとに別値になるため単独キーにできない）。
--
-- 時刻はすべて JST。harness の既存慣習に合わせる。
--
-- ★ このファイルに単語データを書かないこと。
--   line-harness-oss は public リポジトリなので、単語帳の中身をコミットすると
--   そのまま公開転載になる。投入はローカルから D1 へ直接行う。

CREATE TABLE IF NOT EXISTS vocab_books (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  line_account_id  TEXT,                    -- NULL なら全アカウント共通
  slug             TEXT NOT NULL UNIQUE,    -- 'target1900' / 'sysstan5'
  name             TEXT NOT NULL,
  sort             INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE IF NOT EXISTS vocab_words (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id  INTEGER NOT NULL REFERENCES vocab_books (id) ON DELETE CASCADE,
  no       INTEGER NOT NULL,                -- 単語帳の見出し番号
  en       TEXT NOT NULL,
  ja       TEXT NOT NULL,
  section  TEXT,                            -- 'Part 1 これだけは覚えたい基本単語' 等
  UNIQUE (book_id, no)
);

CREATE TABLE IF NOT EXISTS vocab_sessions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  client_session_id  TEXT NOT NULL UNIQUE,  -- UUID。再送の冪等キー
  friend_id          TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  line_account_id    TEXT,
  book_id            INTEGER NOT NULL REFERENCES vocab_books (id),
  kind               TEXT NOT NULL,         -- 'normal' | 'review' | 'retry'
  range_from         INTEGER,
  range_to           INTEGER,
  format             TEXT NOT NULL,         -- 'choice' | 'recall'
  direction          TEXT NOT NULL,         -- 'ej' | 'je'
  order_mode         TEXT NOT NULL,         -- 'seq' | 'rnd'
  timer_sec          INTEGER NOT NULL DEFAULT 0,
  started_at         TEXT NOT NULL,         -- JST
  finished_at        TEXT NOT NULL,         -- JST
  total              INTEGER NOT NULL,
  correct            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vocab_answers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES vocab_sessions (id) ON DELETE CASCADE,
  friend_id   TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  word_id     INTEGER NOT NULL REFERENCES vocab_words (id),
  ok          INTEGER NOT NULL,             -- 0 / 1（時間切れは必ず 0）
  timed_out   INTEGER NOT NULL DEFAULT 0,
  elapsed_ms  INTEGER,
  format      TEXT NOT NULL,                -- 集計を速くするため冗長に持つ
  direction   TEXT NOT NULL,
  answered_at TEXT NOT NULL                 -- JST
);

CREATE INDEX IF NOT EXISTS idx_vocab_words_book  ON vocab_words (book_id, no);
CREATE INDEX IF NOT EXISTS idx_vocab_ans_friend  ON vocab_answers (friend_id, word_id, answered_at);
CREATE INDEX IF NOT EXISTS idx_vocab_ans_session ON vocab_answers (session_id);
CREATE INDEX IF NOT EXISTS idx_vocab_sess_friend ON vocab_sessions (friend_id, finished_at);
