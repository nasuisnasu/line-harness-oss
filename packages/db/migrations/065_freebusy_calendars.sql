-- 空き判定で参照するカレンダーを複数持てるようにする。
--
-- calendar_id は「予約イベントを書き込む先」1本のまま。
-- freebusy_calendar_ids は「予定が入っているか確認しに行く先」で、JSON 配列。
-- NULL / 空配列のときは calendar_id 1本にフォールバックするので、既存の挙動は変わらない。
--
-- 背景: カレンダーを用途別（個人 / 授業 / 無料相談）に分けると、書き込み先だけを
-- 見ていては授業中や私用の時間帯を「空いています」と出してしまう。

ALTER TABLE google_calendar_connections ADD COLUMN freebusy_calendar_ids TEXT;
