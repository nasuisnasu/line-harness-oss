-- Group entry-routes under a free-form label so the operator can collapse
-- the list by source channel (Threads / LP / 広告 / IG など). NULL = 未分類.
-- We keep this as a string column instead of a separate table because the
-- group is purely a UI grouping concept; per-route config still lives on
-- the entry_routes row.

ALTER TABLE entry_routes ADD COLUMN group_name TEXT;
