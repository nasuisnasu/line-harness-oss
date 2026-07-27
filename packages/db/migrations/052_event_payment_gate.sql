-- 有料イベントの決済ゲート。
--
-- consultation イベントに「決済で発行された未使用の予約券がないと予約できない」
-- フラグを足す。無料イベントは requires_payment_ticket=0 のまま従来通り。
--
-- 予約券（payment_tickets）は UnivaPay の webhook が決済成功で1枚発行し、
-- サンクスページ経由で予約URLに載る。予約成立時に status='used' で消費し、
-- 同じ券での二重予約を防ぐ（charge_id 一意で決済1件=券1枚を保証）。

ALTER TABLE event_consultation_configs
  ADD COLUMN requires_payment_ticket INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS payment_tickets (
  id               TEXT PRIMARY KEY,               -- ランダムトークン（予約URLに載る券番号）
  line_account_id  TEXT,
  charge_id        TEXT NOT NULL,                  -- UnivaPay charge id（1決済=1券）
  amount           INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'unused' CHECK (status IN ('unused', 'used')),
  event_slug       TEXT,                           -- 対象イベント（任意。指定時はそのイベント専用）
  name             TEXT,
  email            TEXT,
  used_booking_id  TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  used_at          TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_tickets_charge ON payment_tickets (charge_id);
CREATE INDEX IF NOT EXISTS idx_payment_tickets_status ON payment_tickets (status);
