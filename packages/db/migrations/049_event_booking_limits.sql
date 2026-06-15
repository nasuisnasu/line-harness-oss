-- 戦略会議の枠制限：1日の上限 + 月間上限。
-- どちらか NULL なら未設定。両方設定すれば AND 条件で適用。
ALTER TABLE event_consultation_configs ADD COLUMN daily_booking_limit INTEGER;
ALTER TABLE event_consultation_configs ADD COLUMN monthly_booking_limit INTEGER;
