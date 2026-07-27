-- Rich menus management
CREATE TABLE rich_menus (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  line_richmenu_id TEXT,                -- LINE API側のID（作成後にセット）
  size_type TEXT NOT NULL DEFAULT 'full', -- 'full' | 'compact'
  chat_bar_text TEXT NOT NULL DEFAULT 'メニュー',
  selected INTEGER NOT NULL DEFAULT 1,   -- 開いた状態で表示するか
  areas_json TEXT NOT NULL DEFAULT '[]', -- タップ領域の配列 [{bounds:{x,y,width,height}, action:{...}}]
  is_default INTEGER NOT NULL DEFAULT 0, -- デフォルトリッチメニュー（アカウント内で1つだけ）
  show_on_friend_add INTEGER NOT NULL DEFAULT 0, -- 友達追加時に自動Link
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_rich_menus_account ON rich_menus(line_account_id);

-- シナリオステップにrich_menu_id追加（リッチメニュー切り替えステップ）
ALTER TABLE scenario_steps ADD COLUMN rich_menu_id TEXT;
