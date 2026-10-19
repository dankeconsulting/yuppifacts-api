CREATE TABLE IF NOT EXISTS payment_provider_configurations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider = 'mercado_pago'),
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  public_key_encrypted text NOT NULL,
  access_token_encrypted text NOT NULL,
  webhook_secret_encrypted text NOT NULL,
  connection_status text NOT NULL DEFAULT 'configured' CHECK (connection_status IN ('configured', 'tested', 'failed')),
  is_active boolean NOT NULL DEFAULT false,
  last_tested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, environment)
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_provider_configurations_one_active
  ON payment_provider_configurations (provider) WHERE is_active;

DROP TRIGGER IF EXISTS payment_provider_configurations_touch_updated_at ON payment_provider_configurations;
CREATE TRIGGER payment_provider_configurations_touch_updated_at BEFORE UPDATE ON payment_provider_configurations
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
