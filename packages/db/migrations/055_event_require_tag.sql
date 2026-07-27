-- イベントに「このタグを持つ人だけ予約できる」ゲートを追加。
-- 戦略会議の無料枠は「応募 → 手動で選考 → 当選者にタグを付与 → その人だけ予約できる」運用。
-- 決済券（requires_payment_ticket）と違い、手で選ぶ運用にそのまま乗る。
ALTER TABLE event_consultation_configs ADD COLUMN requires_tag_id TEXT REFERENCES tags (id) ON DELETE SET NULL;
