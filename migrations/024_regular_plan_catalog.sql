-- Regular plans are an independent catalog. It intentionally does not copy data or prices from promotion_plans.
CREATE TABLE IF NOT EXISTS regular_plans (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9_]{2,80}$'),
  profile text NOT NULL CHECK (profile IN ('accountant','company','corporate')),
  mode text NOT NULL CHECK (mode IN ('individual','independent_accountant','accounting_firm','company','corporate')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  seats text NOT NULL CHECK (char_length(seats) BETWEEN 1 AND 180),
  monthly_amount_cents integer CHECK (monthly_amount_cents > 0),
  quarterly_amount_cents integer CHECK (quarterly_amount_cents > 0),
  semiannual_amount_cents integer CHECK (semiannual_amount_cents > 0),
  annual_amount_cents integer CHECK (annual_amount_cents > 0),
  benefits jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(benefits) = 'array'),
  active boolean NOT NULL DEFAULT true,
  display_order smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS regular_plans_mode_display_order_unique ON regular_plans(mode,display_order);
DROP TRIGGER IF EXISTS regular_plans_touch_updated_at ON regular_plans;
CREATE TRIGGER regular_plans_touch_updated_at BEFORE UPDATE ON regular_plans FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
