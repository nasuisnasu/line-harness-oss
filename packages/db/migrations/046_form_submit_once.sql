-- Limit a form to one submission per friend (e.g. 入塾時のカルテ登録).
-- The submit endpoint returns alreadySubmitted=true when this is set
-- and the friend has a prior submission so the LIFF can show a
-- 「既に回答されています」 message.
ALTER TABLE forms ADD COLUMN submit_once INTEGER NOT NULL DEFAULT 0;
