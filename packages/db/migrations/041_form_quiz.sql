-- 041: 確認テスト・日報フォーム拡張
-- forms に「フォーム種別」「正解定義」「合格点」「合格/不合格時のタグ」を追加
-- 既存の汎用フォームと完全互換（NULL のまま使えば従来通り）

ALTER TABLE forms ADD COLUMN form_type TEXT NOT NULL DEFAULT 'generic';
-- 'generic' | 'daily_report' | 'test'

ALTER TABLE forms ADD COLUMN correct_answers TEXT;
-- JSON: { "<field.name>": "<正解値>" | ["<複数正解>"] }
-- form_type='test' のときのみ使用

ALTER TABLE forms ADD COLUMN passing_score INTEGER;
-- 0〜100 の合格パーセント。NULL なら採点のみで合否判定なし

ALTER TABLE forms ADD COLUMN pass_tag_id TEXT REFERENCES tags (id) ON DELETE SET NULL;
ALTER TABLE forms ADD COLUMN fail_tag_id TEXT REFERENCES tags (id) ON DELETE SET NULL;

-- 提出に採点結果を保持
ALTER TABLE form_submissions ADD COLUMN score INTEGER;
-- 正解数（test 以外は NULL）
ALTER TABLE form_submissions ADD COLUMN max_score INTEGER;
-- 採点対象の総問題数
ALTER TABLE form_submissions ADD COLUMN passed INTEGER;
-- 1 / 0 / NULL（採点なし）
