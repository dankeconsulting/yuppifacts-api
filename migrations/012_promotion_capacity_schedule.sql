ALTER TABLE promotion_configuration ADD COLUMN IF NOT EXISTS capacity integer NOT NULL DEFAULT 100 CHECK (capacity > 0 AND capacity <= 100000);
ALTER TABLE promotion_configuration ADD COLUMN IF NOT EXISTS duration_unit text NOT NULL DEFAULT 'days' CHECK (duration_unit IN ('days', 'weeks'));
ALTER TABLE promotion_configuration ADD COLUMN IF NOT EXISTS duration_value integer NOT NULL DEFAULT 30 CHECK (duration_value > 0 AND duration_value <= 3650);
ALTER TABLE promotion_configuration ADD COLUMN IF NOT EXISTS starts_at timestamptz;
ALTER TABLE promotion_configuration ADD COLUMN IF NOT EXISTS ends_at timestamptz;
UPDATE promotion_configuration SET capacity = 100 WHERE capacity IS NULL;
