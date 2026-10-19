-- Production contracting, identity and approval workflow for YuppiFacts.
-- This migration only extends the original fiscal schema; it does not alter
-- organizations, fiscal profiles, invoice requests or their existing data.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS phone_e164 text,
  ADD COLUMN IF NOT EXISTS password_hash text,
  ADD COLUMN IF NOT EXISTS pin_hash text,
  ADD COLUMN IF NOT EXISTS account_status text NOT NULL DEFAULT 'pending_review'
    CHECK (account_status IN ('pending_review', 'active', 'rejected', 'suspended', 'deleted')),
  ADD COLUMN IF NOT EXISTS is_online boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique
  ON users (lower(username)) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_e164_unique
  ON users (phone_e164) WHERE phone_e164 IS NOT NULL;

CREATE TABLE IF NOT EXISTS subscription_plans (
  id text PRIMARY KEY,
  name text NOT NULL,
  audience_copy text NOT NULL,
  organization_kind text NOT NULL CHECK (organization_kind IN ('individual', 'company', 'accounting_firm')),
  monthly_amount_cents integer NOT NULL CHECK (monthly_amount_cents > 0),
  currency char(3) NOT NULL DEFAULT 'MXN',
  active boolean NOT NULL DEFAULT true,
  display_order smallint NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO subscription_plans (id, name, audience_copy, organization_kind, monthly_amount_cents, display_order)
VALUES
  ('individual', 'Persona Física / Natural', 'Para personas físicas con actividad empresarial, RESICO y pequeños contribuyentes.', 'individual', 49900, 1),
  ('accounting_firm', 'Despachos Contables', 'Para contadores independientes y despachos contables con cartera de contribuyentes.', 'accounting_firm', 500000, 2),
  ('company', 'Persona Moral / Jurídica', 'Para todo tipo de empresas y corporativos con áreas contables propias.', 'company', 250000, 3)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  audience_copy = EXCLUDED.audience_copy,
  organization_kind = EXCLUDED.organization_kind,
  monthly_amount_cents = EXCLUDED.monthly_amount_cents,
  display_order = EXCLUDED.display_order,
  updated_at = now();

CREATE TABLE IF NOT EXISTS contracting_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folio text NOT NULL UNIQUE,
  plan_id text NOT NULL REFERENCES subscription_plans(id),
  billing_period text NOT NULL CHECK (billing_period IN ('monthly', 'quarterly', 'annual')),
  quoted_amount_cents integer NOT NULL CHECK (quoted_amount_cents > 0),
  currency char(3) NOT NULL DEFAULT 'MXN',
  lifecycle_status text NOT NULL DEFAULT 'draft' CHECK (lifecycle_status IN (
    'draft', 'phone_pending', 'phone_verified', 'account_created', 'pending_payment',
    'checkout_started', 'voucher_submitted', 'payment_verified', 'activation_details_pending',
    'pending_review', 'active', 'rejected', 'cancelled', 'expired'
  )),
  access_token_hash text NOT NULL UNIQUE,
  phone_e164 text,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS contracting_sessions_status_created_idx
  ON contracting_sessions (lifecycle_status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS contracting_sessions_access_token_hash_unique
  ON contracting_sessions (access_token_hash);
CREATE INDEX IF NOT EXISTS contracting_sessions_user_idx ON contracting_sessions (user_id);
CREATE INDEX IF NOT EXISTS contracting_sessions_phone_idx ON contracting_sessions (phone_e164);

CREATE TABLE IF NOT EXISTS otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contracting_session_id uuid NOT NULL REFERENCES contracting_sessions(id) ON DELETE CASCADE,
  phone_e164 text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('contracting_phone', 'login_pin_reset')),
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  resend_available_at timestamptz NOT NULL,
  max_attempts smallint NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  verified_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_challenges_session_active_idx
  ON otp_challenges (contracting_session_id, created_at DESC)
  WHERE verified_at IS NULL AND invalidated_at IS NULL;

CREATE TABLE IF NOT EXISTS application_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip_hash text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS application_sessions_user_active_idx
  ON application_sessions (user_id, expires_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contracting_session_id uuid NOT NULL REFERENCES contracting_sessions(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('mercado_pago', 'manual_voucher')),
  provider_reference text UNIQUE,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency char(3) NOT NULL DEFAULT 'MXN',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'refunded', 'under_review')),
  provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_attempts_session_idx ON payment_attempts (contracting_session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS voucher_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contracting_session_id uuid NOT NULL REFERENCES contracting_sessions(id) ON DELETE CASCADE,
  payment_attempt_id uuid REFERENCES payment_attempts(id) ON DELETE SET NULL,
  storage_key text NOT NULL UNIQUE,
  original_filename text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
  sha256 text NOT NULL,
  submitter_name text NOT NULL,
  submitter_email text NOT NULL,
  submitter_phone_e164 text NOT NULL,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'accepted', 'rejected')),
  reviewer_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  review_note text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);
CREATE INDEX IF NOT EXISTS voucher_submissions_review_idx ON voucher_submissions (status, submitted_at DESC);

CREATE TABLE IF NOT EXISTS contracting_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contracting_session_id uuid REFERENCES contracting_sessions(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contracting_audit_events_session_idx
  ON contracting_audit_events (contracting_session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contracting_session_id uuid REFERENCES contracting_sessions(id) ON DELETE CASCADE,
  recipient text NOT NULL,
  template text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notification_outbox_pending_idx
  ON notification_outbox (next_attempt_at) WHERE status IN ('pending', 'failed');

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_touch_updated_at ON users;
CREATE TRIGGER users_touch_updated_at BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS subscription_plans_touch_updated_at ON subscription_plans;
CREATE TRIGGER subscription_plans_touch_updated_at BEFORE UPDATE ON subscription_plans
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS contracting_sessions_touch_updated_at ON contracting_sessions;
CREATE TRIGGER contracting_sessions_touch_updated_at BEFORE UPDATE ON contracting_sessions
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS payment_attempts_touch_updated_at ON payment_attempts;
CREATE TRIGGER payment_attempts_touch_updated_at BEFORE UPDATE ON payment_attempts
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS notification_outbox_touch_updated_at ON notification_outbox;
CREATE TRIGGER notification_outbox_touch_updated_at BEFORE UPDATE ON notification_outbox
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
