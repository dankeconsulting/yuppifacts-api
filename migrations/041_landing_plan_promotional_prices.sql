ALTER TABLE landing_plans
  ADD COLUMN IF NOT EXISTS promotional_prices_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS promotional_monthly_amount_cents integer CHECK (promotional_monthly_amount_cents > 0),
  ADD COLUMN IF NOT EXISTS promotional_quarterly_amount_cents integer CHECK (promotional_quarterly_amount_cents > 0),
  ADD COLUMN IF NOT EXISTS promotional_semiannual_amount_cents integer CHECK (promotional_semiannual_amount_cents > 0),
  ADD COLUMN IF NOT EXISTS promotional_annual_amount_cents integer CHECK (promotional_annual_amount_cents > 0);
