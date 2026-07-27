-- フォームに「指定イベントの予約履歴がある人は応募させない」ゲートを追加。
-- 戦略会議の無料枠は「お一人さま1回まで」なので、すでに参加した人を審査応募から弾く用途。
-- キャンセル済みの予約は「参加した」に数えない（実際には会えていないため）。
ALTER TABLE forms ADD COLUMN block_if_booked_slugs TEXT;  -- カンマ区切りの event slug。空/NULL ならゲート無し
ALTER TABLE forms ADD COLUMN block_message TEXT;          -- 弾いたときに表示する文言
