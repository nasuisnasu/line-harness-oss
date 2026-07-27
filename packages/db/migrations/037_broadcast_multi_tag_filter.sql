-- Allow broadcasts to target with compound tag filters:
--   { "include": ["tagId1", "tagId2"], "exclude": ["tagId3"] }
-- Friend must have ALL include tags AND NOT have ANY exclude tag.
-- The legacy target_tag_id / target_tag_mode columns remain as fallback
-- so older drafts keep working.
ALTER TABLE broadcasts ADD COLUMN target_tag_filter_json TEXT;
