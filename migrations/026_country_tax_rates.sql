CREATE TABLE IF NOT EXISTS country_tax_rates (
  country_code text PRIMARY KEY CHECK (country_code IN ('MX', 'CR', 'CO')),
  iva_bps integer NOT NULL DEFAULT 0 CHECK (iva_bps >= 0 AND iva_bps <= 10000),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO country_tax_rates (country_code, iva_bps)
VALUES ('MX', 1600), ('CR', 0), ('CO', 0)
ON CONFLICT (country_code) DO NOTHING;
