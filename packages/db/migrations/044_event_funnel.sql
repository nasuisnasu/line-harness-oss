-- Funnel KPI: classify each event by its position in the funnel
-- (top = 戦略会議や勉強会など、mid = 個別説明会) and its delivery format
-- (seminar / individual). Used by /api/kpi/funnel-summary to compare
-- multiple top events side by side.
ALTER TABLE events ADD COLUMN funnel_role TEXT;       -- 'top' | 'mid' | NULL
ALTER TABLE events ADD COLUMN event_format TEXT;      -- 'seminar' | 'individual' | NULL
