CREATE TABLE IF NOT EXISTS promotion_configuration (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  is_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO promotion_configuration (singleton, is_enabled) VALUES (true, true) ON CONFLICT (singleton) DO NOTHING;
