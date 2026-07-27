-- Add is_blocked flag to friends table
ALTER TABLE friends ADD COLUMN is_blocked INTEGER NOT NULL DEFAULT 0;
