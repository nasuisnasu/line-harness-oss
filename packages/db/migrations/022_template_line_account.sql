-- Migration 021 rebuilt the templates table to add 'buttons' to the
-- message_type CHECK list, but inadvertently dropped the line_account_id
-- column that earlier ad-hoc work had added. The DB helpers in
-- packages/db/src/templates.ts INSERT and SELECT against this column, so
-- every template request 500s without it. Restore it as a nullable column
-- ("NULL = 全アカウント共通") to match the original semantics.

ALTER TABLE templates ADD COLUMN line_account_id TEXT;
