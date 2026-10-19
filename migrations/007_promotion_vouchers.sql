CREATE TABLE IF NOT EXISTS promotion_vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 3 AND 160),
  email text NOT NULL CHECK (char_length(email) <= 254),
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\\+[1-9][0-9]{7,14}$'),
  country_code char(2) NOT NULL,
  state_name text NOT NULL CHECK (char_length(state_name) BETWEEN 2 AND 100),
  amount_cents integer NOT NULL DEFAULT 390000 CHECK (amount_cents = 390000),
  currency char(3) NOT NULL DEFAULT 'MXN' CHECK (currency = 'MXN'),
  storage_key text NOT NULL UNIQUE,
  original_filename text NOT NULL CHECK (char_length(original_filename) BETWEEN 1 AND 180),
  content_type text NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'upload_pending' CHECK (status IN ('upload_pending', 'submitted', 'verified', 'rejected')),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS promotion_vouchers_review_idx ON promotion_vouchers (status, created_at DESC);
DROP TRIGGER IF EXISTS promotion_vouchers_touch_updated_at ON promotion_vouchers;
CREATE TRIGGER promotion_vouchers_touch_updated_at BEFORE UPDATE ON promotion_vouchers
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
