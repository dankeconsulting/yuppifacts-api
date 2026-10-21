-- Consolidates the promotional subscription record with the eventual account.
ALTER TABLE promotion_contracts
  ADD COLUMN IF NOT EXISTS city_name text,
  ADD COLUMN IF NOT EXISTS pin_hash text,
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS subscription_tag text NOT NULL DEFAULT 'promo' CHECK (subscription_tag IN ('promo', 'traditional')),
  ADD COLUMN IF NOT EXISTS subscription_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS renewal_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS promotion_contracts_user_id_unique
  ON promotion_contracts(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS promotion_contracts_admin_queue_idx
  ON promotion_contracts(lifecycle_status, created_at DESC);

ALTER TABLE promotion_vouchers
  ADD COLUMN IF NOT EXISTS city_name text;
