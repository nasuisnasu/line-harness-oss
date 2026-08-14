-- 060_grammar.sql — 文法テスト（受講生専用）
--
-- 単語テスト（058_vocab.sql）の兄弟。設計判断はそちらに揃えてある。
--   - 生徒の識別は friends.id。students テーブルは作らない
--   - 時刻はすべて JST
--   - 時間切れは不正解（ok=0）
--
-- ★ 単語テストとの決定的な違い：**選択肢を自動生成しない。**
--   単語は en/ja のペアなので他の語からダミーを作れたが、文法問題は
--   「なぜその誤答が魅力的か」まで含めて1問なので、4つとも人が書く。
--   そのぶん誤答の選ばれ方（grammar_answers.chosen）が分析材料になる。
--
-- ★ このファイルに問題データを書かないこと。
--   line-harness-oss は public リポジトリなので、問題集の中身をコミットすると
--   そのまま公開転載になる。投入は管理画面か、ローカルから D1 へ直接行う。

CREATE TABLE IF NOT EXISTS grammar_books (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  line_account_id  TEXT,                    -- NULL なら全アカウント共通
  slug             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  sort             INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

-- 出題の単位。
--
-- category が単語テストの「100語ブロック」にあたる主軸。生徒は番号ではなく
-- 「関係詞をやる」と考えるので、範囲指定ではなく分野で選ばせる。
-- 分野の並び順は MIN(no) で決める（専用の列を持たない）。問題集を分野順に
-- 投入すれば、そのまま生徒に見える順になる。
CREATE TABLE IF NOT EXISTS grammar_questions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id      INTEGER NOT NULL REFERENCES grammar_books (id) ON DELETE CASCADE,
  no           INTEGER NOT NULL,            -- 問題集の通し番号
  category     TEXT NOT NULL,               -- '関係詞' / '仮定法' / '動詞の語法' 等
  sub_category TEXT,                        -- '関係代名詞 what' 等。任意
  prompt       TEXT NOT NULL,               -- 問題文。空所は ( ) 、下線は [ ] で囲む
  choices      TEXT NOT NULL,               -- JSON配列。要素数は2〜5（通常4）
  answer       INTEGER NOT NULL,            -- choices の 0 始まりの添字
  explanation  TEXT,                        -- 解説。無くても動くが、無いと復習にならない
  level        TEXT,                        -- 'A' | 'B' | 'C' 等。任意
  source       TEXT,                        -- 出典メモ（講師用。生徒には出さない）
  UNIQUE (book_id, no)
);

CREATE TABLE IF NOT EXISTS grammar_sessions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  client_session_id  TEXT NOT NULL UNIQUE,  -- UUID。再送の冪等キー
  friend_id          TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  line_account_id    TEXT,
  book_id            INTEGER NOT NULL REFERENCES grammar_books (id),
  kind               TEXT NOT NULL,         -- 'normal' | 'review' | 'retry' | 'checkup'
  category           TEXT,                  -- 絞った分野。NULL なら全分野
  range_from         INTEGER,               -- 番号で絞ったとき用。通常は NULL
  range_to           INTEGER,
  order_mode         TEXT NOT NULL,         -- 'seq' | 'rnd'
  timer_sec          INTEGER NOT NULL DEFAULT 0,
  started_at         TEXT NOT NULL,         -- JST
  finished_at        TEXT NOT NULL,         -- JST
  total              INTEGER NOT NULL,
  correct            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS grammar_answers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES grammar_sessions (id) ON DELETE CASCADE,
  friend_id   TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES grammar_questions (id),
  ok          INTEGER NOT NULL,             -- 0 / 1（時間切れは必ず 0）
  -- 生徒が選んだ選択肢の**元の**添字。画面ではシャッフルして出すので、
  -- クライアントはシャッフル後の位置ではなく元の添字を送ること。
  -- 時間切れ・未選択は NULL。
  chosen      INTEGER,
  timed_out   INTEGER NOT NULL DEFAULT 0,
  elapsed_ms  INTEGER,
  -- 集計を速くするため冗長に持つ（vocab_answers の format/direction と同じ考え方）
  category    TEXT NOT NULL,
  answered_at TEXT NOT NULL                 -- JST
);

CREATE INDEX IF NOT EXISTS idx_gq_book      ON grammar_questions (book_id, no);
CREATE INDEX IF NOT EXISTS idx_gq_cat       ON grammar_questions (book_id, category, no);
CREATE INDEX IF NOT EXISTS idx_ga_friend    ON grammar_answers (friend_id, question_id, answered_at);
CREATE INDEX IF NOT EXISTS idx_ga_session   ON grammar_answers (session_id);
CREATE INDEX IF NOT EXISTS idx_gs_friend    ON grammar_sessions (friend_id, finished_at);
