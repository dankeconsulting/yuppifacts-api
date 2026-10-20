ALTER TABLE promotion_plans ADD COLUMN IF NOT EXISTS mode text;
ALTER TABLE promotion_plans ADD COLUMN IF NOT EXISTS annual_amount_cents integer CHECK (annual_amount_cents > 0);
ALTER TABLE promotion_plans ALTER COLUMN monthly_amount_cents DROP NOT NULL;
ALTER TABLE promotion_plans ALTER COLUMN quarterly_amount_cents DROP NOT NULL;
UPDATE promotion_plans SET mode = CASE id WHEN 'independent_accountant' THEN 'independent_accountant' WHEN 'accounting_firm' THEN 'accounting_firm' WHEN 'company' THEN 'company' ELSE 'corporate' END WHERE mode IS NULL;
ALTER TABLE promotion_plans ALTER COLUMN mode SET NOT NULL;
ALTER TABLE promotion_plans DROP CONSTRAINT IF EXISTS promotion_plans_mode_check;
ALTER TABLE promotion_plans ADD CONSTRAINT promotion_plans_mode_check CHECK (mode IN ('independent_accountant','accounting_firm','company','corporate'));
ALTER TABLE promotion_plans DROP CONSTRAINT IF EXISTS promotion_plans_one_billing_period_check;
ALTER TABLE promotion_plans ADD CONSTRAINT promotion_plans_one_billing_period_check CHECK (monthly_amount_cents IS NOT NULL OR quarterly_amount_cents IS NOT NULL OR annual_amount_cents IS NOT NULL);

ALTER TABLE promotion_contracts DROP CONSTRAINT IF EXISTS promotion_contracts_billing_period_check;
ALTER TABLE promotion_contracts ADD CONSTRAINT promotion_contracts_billing_period_check CHECK (billing_period IN ('monthly','quarterly','annual'));
