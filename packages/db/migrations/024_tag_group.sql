-- Group tags under a free-form label so the operator can collapse the tag
-- list by use case (LP流入 / アンケート結果 / 属性 など). NULL = 未分類.
-- Mirrors migrations 016 (entry_routes) and 017 (scenarios).

ALTER TABLE tags ADD COLUMN group_name TEXT;
