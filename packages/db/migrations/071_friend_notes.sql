-- 071_friend_notes.sql — 講師メモ（生徒カルテ v0）
--
-- 生徒ごとの「いまどうなっているか／次に何をするか」を人の言葉で置く場所。
-- テストのログも授業記録も提出物も既にあるが、**それらを見て何を考えたか**は
-- どこにも残っていない。次の授業でいちばん先に読みたいのはそれなので、ここに持つ。
--
-- ★ friends.metadata（JSON）に相乗りしない。
--   あそこは harness の他機能も読んで書き戻すので、同時更新で他機能の値を消す。
--   lms_goals（064）が別テーブルなのと同じ理由。
--
-- ★ 1行 = 1メモの追記型にする。1生徒1行の「現在の状態」にしない。
--   上書きにすると、前に何を見立てて外したのかが消える。指導は前の見立てとの
--   差分で動くので、外れた見立てこそ残す価値がある。
--
-- ★ pinned は「いまの方針」を上に固定するためだけのもの。数の制限はかけない
--   （運用で1本にする）。並びは pinned DESC, created_at DESC。
--
-- 生徒には出さない。読むのは講師と Claude だけ（`.company/英弱ニキ/lms/karte/`）。
-- 時刻はすべて JST。

CREATE TABLE IF NOT EXISTS friend_notes (
  id         TEXT PRIMARY KEY,
  friend_id  TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_friend_notes_friend ON friend_notes (friend_id, created_at);
