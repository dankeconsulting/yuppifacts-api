CREATE TABLE IF NOT EXISTS promotion_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 100000),
  duration_unit text NOT NULL CHECK (duration_unit IN ('days', 'weeks')),
  duration_value integer NOT NULL CHECK (duration_value BETWEEN 1 AND 3650),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS promotion_campaign_plans (
  campaign_id uuid NOT NULL REFERENCES promotion_campaigns(id) ON DELETE CASCADE,
  plan_id text NOT NULL REFERENCES promotion_plans(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, plan_id)
);

CREATE INDEX IF NOT EXISTS promotion_campaigns_active_window_idx
  ON promotion_campaigns (is_active, starts_at DESC, ends_at DESC);

ALTER TABLE promotion_contracts
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES promotion_campaigns(id) ON DELETE SET NULL;

INSERT INTO promotion_campaigns (name, capacity, duration_unit, duration_value, starts_at, ends_at, is_active)
SELECT 'Promoción inicial', configuration.capacity, configuration.duration_unit, configuration.duration_value,
  COALESCE(configuration.starts_at, now()),
  COALESCE(configuration.ends_at, now() + (configuration.duration_value * CASE WHEN configuration.duration_unit = 'weeks' THEN 7 ELSE 1 END) * interval '1 day'),
  configuration.is_enabled
FROM promotion_configuration configuration
WHERE configuration.singleton = true
  AND NOT EXISTS (SELECT 1 FROM promotion_campaigns);

INSERT INTO promotion_campaign_plans (campaign_id, plan_id)
SELECT campaign.id, plan.id
FROM promotion_campaigns campaign CROSS JOIN promotion_plans plan
WHERE campaign.name = 'Promoción inicial'
ON CONFLICT DO NOTHING;

DROP TRIGGER IF EXISTS promotion_campaigns_touch_updated_at ON promotion_campaigns;
CREATE TRIGGER promotion_campaigns_touch_updated_at BEFORE UPDATE ON promotion_campaigns
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
