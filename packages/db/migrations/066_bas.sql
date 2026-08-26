-- 066_bas.sql — 並び替えテスト（Build a Sentence）
--
-- 単語テスト（058_vocab.sql）・文法テスト（060_grammar.sql）の弟。
-- ゲートも時刻の扱いも兄たちに揃えてある。
--   - 生徒の識別は friends.id
--   - 時刻はすべて JST
--   - 時間切れは不正解（ok=0）
--
-- ★ 文法テストとの決定的な違い：**選択肢が無い。**
--   語群を並べて1文を作らせるので、採点は「並びが正解と一致するか」の一致判定。
--   したがって**答えが1通りに定まる問題しか入れてはいけない**。
--   （例：Never have I waited this long. は I have never waited this long. でも
--     同じ語数で成立してしまうので、問題として成立しない。verify.py で弾く）
--
-- ★ 出題はセット単位ではなく**プール全体**から行う。
--   bas_sets は「いつ作ったどの束か」を残すためだけの出所メモで、
--   生徒にセットを選ばせる画面は作らない。毎週 100 問を足して池を深くしていく。

CREATE TABLE IF NOT EXISTS bas_sets (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  line_account_id  TEXT,                    -- NULL なら全アカウント共通
  slug             TEXT NOT NULL UNIQUE,    -- 'set-002' 等
  name             TEXT NOT NULL,
  sort             INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

-- 型カタログ（A1〜G4）。「攻略ブック」§3 の記号がそのまま入る。
--
-- ラベルは教材の中身なので**このファイルには書かない**（public リポジトリ）。
-- 投入はローカルの import スクリプトから行う。
CREATE TABLE IF NOT EXISTS bas_types (
  code        TEXT PRIMARY KEY,             -- 'E1' / 'B3' 等
  group_code  TEXT NOT NULL,                -- 'E' / 'B' 等
  group_name  TEXT NOT NULL,                -- '名詞節' 等
  name        TEXT NOT NULL,                -- '間接疑問' 等
  hint        TEXT,                         -- 見分け方の1行
  sort        INTEGER NOT NULL DEFAULT 0
);

-- ★ このテーブルに問題データを直接書かないこと。
--   line-harness-oss は public リポジトリなので、問題文をコミットすると
--   そのまま公開転載になる。投入は管理画面か、ローカルから D1 へ直接行う。
CREATE TABLE IF NOT EXISTS bas_questions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id    INTEGER NOT NULL REFERENCES bas_sets (id) ON DELETE CASCADE,
  no        INTEGER NOT NULL,               -- セット内の通し番号
  lead      TEXT NOT NULL,                  -- 導入文（英語。ここに答えの文脈が入る）
  -- 空所を {} で表した文の骨格。'{} {} {} {} {} this morning.' のように、
  -- 印字して与える語（this morning）は {} の外に書く。
  frame     TEXT NOT NULL,
  answer    TEXT NOT NULL,                  -- JSON配列。{} を埋める正しい順
  extra     TEXT,                           -- 余分語。無ければ NULL
  types     TEXT NOT NULL,                  -- JSON配列 ["E1","B3"]
  steps     TEXT NOT NULL,                  -- JSON配列。8つの決め手（解説）
  sentence  TEXT NOT NULL,                  -- 完成文。結果画面に出す
  ja        TEXT NOT NULL,                  -- 和訳
  level     TEXT,
  UNIQUE (set_id, no)
);

CREATE TABLE IF NOT EXISTS bas_sessions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  client_session_id  TEXT NOT NULL UNIQUE,  -- UUID。再送の冪等キー
  friend_id          TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  line_account_id    TEXT,
  kind               TEXT NOT NULL,         -- 'mixed' | 'weak' | 'type'
  focus_type         TEXT,                  -- kind='type' のときの記号。それ以外 NULL
  timer_sec          INTEGER NOT NULL DEFAULT 0,
  started_at         TEXT NOT NULL,         -- JST
  finished_at        TEXT NOT NULL,         -- JST
  total              INTEGER NOT NULL,
  correct            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bas_answers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES bas_sessions (id) ON DELETE CASCADE,
  friend_id   TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES bas_questions (id),
  ok          INTEGER NOT NULL,             -- 0 / 1（時間切れは必ず 0）
  -- 生徒が組んだ並び（JSON配列）。4択と違い「どう間違えたか」が全部ここに出るので、
  -- 誤答の形そのものが分析材料になる。時間切れ・未提出は NULL。
  submitted   TEXT,
  timed_out   INTEGER NOT NULL DEFAULT 0,
  elapsed_ms  INTEGER,
  answered_at TEXT NOT NULL                 -- JST
);

-- 弱点集計の芯。
--
-- 1問が型を複数持つ（["E1","B3","G2"]）ので、答えを**型ごとにばらして**持つ。
-- ここを正規化しておかないと、集計のたびに JSON を舐めることになり
-- 「E1 の正答率」が SQL で書けない。1答え = 1〜4行に増えるが、
-- 増えるぶんは高々4倍で、集計が GROUP BY 一発になる価値のほうが大きい。
CREATE TABLE IF NOT EXISTS bas_answer_types (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  answer_id   INTEGER NOT NULL REFERENCES bas_answers (id) ON DELETE CASCADE,
  friend_id   TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES bas_questions (id),
  type_code   TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  answered_at TEXT NOT NULL                 -- JST
);

CREATE INDEX IF NOT EXISTS idx_bq_set     ON bas_questions (set_id, no);
CREATE INDEX IF NOT EXISTS idx_ba_friend  ON bas_answers (friend_id, question_id, answered_at);
CREATE INDEX IF NOT EXISTS idx_ba_session ON bas_answers (session_id);
CREATE INDEX IF NOT EXISTS idx_bs_friend  ON bas_sessions (friend_id, finished_at);
CREATE INDEX IF NOT EXISTS idx_bat_friend ON bas_answer_types (friend_id, type_code, answered_at);
CREATE INDEX IF NOT EXISTS idx_bat_answer ON bas_answer_types (answer_id);
