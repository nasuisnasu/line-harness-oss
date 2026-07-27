-- Scope tracked links to a LINE Official Account so each OA sees only
-- its own links in the admin UI. Existing rows get NULL = "全アカウント
-- 共通" so we don't break links that were created before this column.
-- Operators can assign one via the row's edit UI.

ALTER TABLE tracked_links ADD COLUMN line_account_id TEXT;
