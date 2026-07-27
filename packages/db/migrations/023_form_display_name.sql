-- Split forms.name into a management name (still `name`) and a public-facing
-- display name (`display_name`) that respondents see at the top of the LIFF
-- form. Existing rows fall back to using `name` until an operator edits.

ALTER TABLE forms ADD COLUMN display_name TEXT;
