-- タグ連動リッチメニュー
-- 「このタグが付いた人にはこのリッチメニューを出す」の対応表。
-- 受講登録フォームで「生徒」を選んだ人に受講生用メニューを出すのが最初の用途。
-- 1タグ = 1メニュー（同じタグに複数メニューを紐づけると、どれが出るか決まらない）。
ALTER TABLE rich_menus ADD COLUMN auto_link_tag_id TEXT;

CREATE INDEX idx_rich_menus_auto_link_tag ON rich_menus(auto_link_tag_id);
