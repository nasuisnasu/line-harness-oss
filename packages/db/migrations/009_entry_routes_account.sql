-- Add line_account_id to entry_routes for per-account filtering
ALTER TABLE entry_routes ADD COLUMN line_account_id TEXT REFERENCES line_accounts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_entry_routes_account ON entry_routes (line_account_id);
