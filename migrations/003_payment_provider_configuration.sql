CREATE TABLE IF NOT EXISTS platform_admin_security (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  pin_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_provider_configurations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider = 'mercado_pago'),
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  public_key_ciphertext text NOT NULL,
  access_token_ciphertext text NOT NULL,
  connection_status text NOT NULL CHECK (connection_status IN ('pending', 'failed', 'tested')) DEFAULT 'pending',
  connection_message text,
  tested_at timestamptz,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, environment)
);

CREATE INDEX IF NOT EXISTS payment_provider_config_active_idx ON payment_provider_configurations(provider, is_active);
