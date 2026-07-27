-- Group scenarios under a free-form label so the operator can collapse the
-- list by use case (LP誘導 / セミナー / 教材配布 など). NULL = 未分類.

ALTER TABLE scenarios ADD COLUMN group_name TEXT;
