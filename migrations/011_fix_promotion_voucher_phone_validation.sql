ALTER TABLE promotion_vouchers
  DROP CONSTRAINT IF EXISTS promotion_vouchers_phone_e164_check,
  ADD CONSTRAINT promotion_vouchers_phone_e164_check
    CHECK (phone_e164 ~ $$^\+[1-9][0-9]{7,14}$$);
