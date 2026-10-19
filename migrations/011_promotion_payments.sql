ALTER TABLE promotion_contracts DROP CONSTRAINT IF EXISTS promotion_contracts_lifecycle_status_check;
ALTER TABLE promotion_contracts ADD CONSTRAINT promotion_contracts_lifecycle_status_check
  CHECK (lifecycle_status IN ('draft', 'pending_payment', 'checkout_started', 'voucher_submitted', 'payment_verified', 'active', 'rejected', 'cancelled'));

CREATE TABLE IF NOT EXISTS promotion_payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_contract_id uuid NOT NULL REFERENCES promotion_contracts(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'mercado_pago' CHECK (provider = 'mercado_pago'),
  provider_reference text NOT NULL UNIQUE,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency char(3) NOT NULL DEFAULT 'MXN',
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'approved', 'rejected', 'pending', 'under_review', 'cancelled')),
  provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS promotion_payment_attempts_contract_idx ON promotion_payment_attempts (promotion_contract_id, created_at DESC);
DROP TRIGGER IF EXISTS promotion_payment_attempts_touch_updated_at ON promotion_payment_attempts;
CREATE TRIGGER promotion_payment_attempts_touch_updated_at BEFORE UPDATE ON promotion_payment_attempts
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
