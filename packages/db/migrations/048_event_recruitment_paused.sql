-- 公開中（is_active）とは別軸で「募集停止」を扱う。
-- recruitment_paused=1 のときは LIFF 予約画面で「予約可能な枠がありません」と表示し、
-- slot生成は空配列を返す。ページ自体は公開のまま残る運用想定。
ALTER TABLE events ADD COLUMN recruitment_paused INTEGER NOT NULL DEFAULT 0;
