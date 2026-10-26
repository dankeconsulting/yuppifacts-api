ALTER TABLE promotion_contracts DROP CONSTRAINT IF EXISTS promotion_contracts_lifecycle_status_check;
ALTER TABLE promotion_contracts ADD CONSTRAINT promotion_contracts_lifecycle_status_check
  CHECK (lifecycle_status IN ('draft', 'pending_payment', 'checkout_started', 'voucher_submitted', 'payment_verified', 'approved', 'active', 'rejected', 'cancelled'));
