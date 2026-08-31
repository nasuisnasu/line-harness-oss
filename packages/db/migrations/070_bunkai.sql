-- 070_bunkai.sql — 古文の品詞分解チェッカー
--
-- 単語テスト（058）・文法テスト（060）・並び替え（066）の弟だが、**性質が違う。**
-- 兄たちは「あらかじめ作った問題を D1 から出す」。こちらは生徒が入れた文を
-- その場で Claude に分解させる。**このリポジトリで初めて外部のLLMを叩く機能。**
--
-- 生徒の識別は friends.id、時刻は JST。そこは兄たちと同じ。
--
-- ★ なぜキャッシュのテーブルがあるのか
--   同じ一文の品詞分解は誰が聞いても同じ答えになる。生徒は同じ文を何度も見返すし、
--   同じ教材を配れば複数人が同じ文を投げる。毎回APIを叩くと、
--   同じ答えを買い直しているだけになる。text_hash で引いて、あればそれを返す。
--   キャッシュは**生徒ごとに分けない**。分けると人数分だけ買い直すことになる。
--
-- ★ なぜリクエストの記録が別テーブルなのか
--   1. 1日の上限を数えるため。API は従量課金なので、上限が無いと青天井になる。
--      **数えるのはキャッシュに無くて実際に叩いた分だけ**（cached=1 はタダなので数えない）。
--   2. 生徒が何につまずいて投げたかが、そのまま指導の材料になる。
--      「この生徒はいつも助動詞の『なり』で止まる」が見える。

-- 分解の結果そのもの。1文 = 1行。全生徒で共有する。
CREATE TABLE IF NOT EXISTS bunkai_parses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 正規化した本文の SHA-256（hex）。正規化の規則はサーバー側 normalizeText() が正本。
  -- 規則を変えたらキャッシュは全部ミスになるが、壊れはしない（作り直されるだけ）。
  text_hash   TEXT NOT NULL UNIQUE,
  text        TEXT NOT NULL,           -- 正規化後の本文。講師が「何を投げたか」を見るために持つ
  -- 分解の結果（JSON）。形はサーバー側の PARSE_SCHEMA が正本。
  -- 列に割らない理由：形態素は可変長で、1文につき数十件ぶら下がる。
  -- 表示は常に「1文まるごと」なので、割っても JOIN して戻すだけになる。
  result      TEXT NOT NULL,
  model       TEXT NOT NULL,           -- どのモデルが出したか。モデルを変えたとき見分けるため
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

-- 誰がいつ何を投げたか。上限を数える台帳でもあり、指導の材料でもある。
CREATE TABLE IF NOT EXISTS bunkai_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  friend_id   TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  -- NULL は「叩いたが結果を保存しなかった」= 古文でなかったとき。
  -- 保存する分解が無くても**1日の上限には数える**。数えないと、
  -- 古文でない文字列を投げ続けるだけで無料でAPIを回せてしまう。
  parse_id    INTEGER REFERENCES bunkai_parses (id) ON DELETE CASCADE,
  -- 1 ならキャッシュから返した（APIを叩いていない＝1日の上限に数えない）
  cached      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_bunkai_req_friend ON bunkai_requests (friend_id, created_at);
-- 1日の上限を数えるクエリ専用。日付は created_at の先頭10文字（JSTなのでそのまま日付）。
CREATE INDEX IF NOT EXISTS idx_bunkai_req_quota  ON bunkai_requests (friend_id, cached, created_at);
