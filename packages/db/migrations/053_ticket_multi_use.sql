-- 回数券（まとめ買い）対応。
--
-- 1決済＝1券のまま、券に「残り使用回数」を持たせて複数回の予約に使えるようにする。
-- 単発は uses_total=1（従来通り1回で used）。5回券は uses_total=5 で、予約成立ごとに
-- uses_remaining を1ずつ減らし、0になったら status='used'。
--
-- あわせて購入者のLINE user_id を保存する（リッチメニュー経由=uidが載る購入のみ）。
-- 再入場時、strategyページが uid で「残っている券」を照会して予約ボタンを出すために使う。
--
-- 有効期限は created_at（＝購入日時）から6ヶ月で判定する（別カラムは持たず、クエリ側で
-- datetime(created_at,'+6 months') と比較する）。

ALTER TABLE payment_tickets ADD COLUMN line_user_id   TEXT;
ALTER TABLE payment_tickets ADD COLUMN uses_total     INTEGER NOT NULL DEFAULT 1;
ALTER TABLE payment_tickets ADD COLUMN uses_remaining INTEGER NOT NULL DEFAULT 1;

-- 既存券のバックフィル：未使用=残1、使用済み=残0。
UPDATE payment_tickets
  SET uses_total = 1,
      uses_remaining = CASE status WHEN 'unused' THEN 1 ELSE 0 END;

CREATE INDEX IF NOT EXISTS idx_payment_tickets_lineuser ON payment_tickets (line_user_id);
