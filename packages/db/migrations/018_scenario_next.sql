-- Optional chained scenario: when a friend completes this scenario, the
-- engine auto-enrolls them in `next_scenario_id`. NULL = stop (current
-- behaviour). Cycle prevention is enforced at save time on the API side.

ALTER TABLE scenarios ADD COLUMN next_scenario_id TEXT;
