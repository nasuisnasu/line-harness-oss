-- 受講生の「目標日」。単語テストと文法テストで**共通**に使う。
--
-- 両方の画面の上に出るカウントダウン（既定は共通テストまで）を、
-- 生徒が自分の受験日・模試日に変えられるようにするためのもの。
--
-- テーブル名に vocab_ / grammar_ の前缀を付けないのは、どちらの機能のものでもなく
-- **両方から読む共通の設定**だから。機能ごとに持たせると必ず片方だけ古くなる。
--
-- friends.metadata（JSON）に相乗りしない。あそこは harness の他機能も書くので、
-- 読んで書き戻す実装だと同時更新で他機能の値を消す。

CREATE TABLE IF NOT EXISTS lms_goals (
  friend_id   TEXT PRIMARY KEY REFERENCES friends (id) ON DELETE CASCADE,
  -- 「共通テスト」「早稲田入試」「第2回模試」など。カウントダウンの見出しに出る
  label       TEXT NOT NULL,
  -- 'YYYY-MM-DD'（JST）。時刻は持たない。日数しか使わないので
  target_date TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
