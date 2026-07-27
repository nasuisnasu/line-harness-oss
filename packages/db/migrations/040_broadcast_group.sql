-- Group categorization for broadcasts (mirrors scenarios.group_name).
-- Operators with many broadcasts can collapse them by group in the admin list.
ALTER TABLE broadcasts ADD COLUMN group_name TEXT;
CREATE INDEX IF NOT EXISTS idx_broadcasts_group ON broadcasts (group_name);
