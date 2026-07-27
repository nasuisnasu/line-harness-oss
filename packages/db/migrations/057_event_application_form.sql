-- 審査制イベントの「応募窓口フォーム」。予約フォームを出さない代わりに、
-- 応募はこのフォームで受ける。管理画面の予約一覧が、各予約に紐づく友だちの
-- 最新応募をここから引いて表示する。
ALTER TABLE event_consultation_configs ADD COLUMN application_form_id TEXT REFERENCES forms (id) ON DELETE SET NULL;
