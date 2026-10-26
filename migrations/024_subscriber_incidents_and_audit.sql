CREATE TABLE IF NOT EXISTS subscriber_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriber_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_contract_id uuid REFERENCES promotion_contracts(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  title text NOT NULL,
  detail text,
  incident_id uuid REFERENCES subscriber_incidents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriber_activity_log_contract_idx ON subscriber_activity_log(promotion_contract_id, created_at DESC);
