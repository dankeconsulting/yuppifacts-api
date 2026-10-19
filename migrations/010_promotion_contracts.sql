CREATE TABLE IF NOT EXISTS promotion_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folio text NOT NULL UNIQUE,
  access_token_hash text NOT NULL UNIQUE,
  promotion_tag text NOT NULL DEFAULT 'promo' CHECK (promotion_tag = 'promo'),
  profile text NOT NULL CHECK (profile IN ('accountant', 'company', 'corporate')),
  plan_id text NOT NULL CHECK (plan_id IN ('independent_accountant', 'accounting_firm', 'company', 'corporate')),
  billing_period text NOT NULL CHECK (billing_period IN ('monthly', 'quarterly')),
  quoted_amount_cents integer NOT NULL CHECK (quoted_amount_cents > 0),
  currency char(3) NOT NULL DEFAULT 'MXN',
  lifecycle_status text NOT NULL DEFAULT 'pending_payment' CHECK (lifecycle_status IN ('draft', 'pending_payment', 'voucher_submitted', 'payment_verified', 'active', 'rejected', 'cancelled')),
  full_name text,
  email text,
  phone_e164 text,
  country_code char(2),
  state_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS promotion_contracts_status_idx ON promotion_contracts (lifecycle_status, created_at DESC);
DROP TRIGGER IF EXISTS promotion_contracts_touch_updated_at ON promotion_contracts;
CREATE TRIGGER promotion_contracts_touch_updated_at BEFORE UPDATE ON promotion_contracts
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE promotion_vouchers ADD COLUMN IF NOT EXISTS promotion_contract_id uuid REFERENCES promotion_contracts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS promotion_vouchers_contract_idx ON promotion_vouchers (promotion_contract_id, submitted_at DESC);
ALTER TABLE promotion_vouchers DROP CONSTRAINT IF EXISTS promotion_vouchers_amount_cents_check;
