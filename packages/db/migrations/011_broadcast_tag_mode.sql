-- Add target_tag_mode to broadcasts: 'include' (default) or 'exclude'
ALTER TABLE broadcasts ADD COLUMN target_tag_mode TEXT NOT NULL DEFAULT 'include';
