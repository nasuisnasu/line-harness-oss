-- フォームのベタ打ち共有用 LIFF URL 生成のための追加カラム
-- - line_accounts.liff_id: 各 OA のフォーム LIFF ID（同一 OA 内なら同じ）
-- - forms.line_account_id: そのフォームをどの OA で運用するか
ALTER TABLE line_accounts ADD COLUMN liff_id TEXT;
ALTER TABLE forms ADD COLUMN line_account_id TEXT REFERENCES line_accounts (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_forms_account ON forms (line_account_id);
