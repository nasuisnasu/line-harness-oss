-- Cache the LINE OA's display name + icon, refreshed periodically from
-- LINE Messaging API /v2/bot/info. profile_synced_at lets the cron skip
-- accounts that were already synced within the last 24 hours.
ALTER TABLE line_accounts ADD COLUMN picture_url TEXT;
ALTER TABLE line_accounts ADD COLUMN profile_synced_at TEXT;
