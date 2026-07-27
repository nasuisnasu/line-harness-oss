-- 予約フォームの「定義は残すが、予約時には出さない」フラグ。
-- 定義を空にすると管理画面が過去の回答をラベル表示できなくなる（キーが field_xxx のままになる）ため、
-- 表示のON/OFFは定義の有無とは別に持つ。
ALTER TABLE event_consultation_configs ADD COLUMN hide_booking_form INTEGER NOT NULL DEFAULT 0;
