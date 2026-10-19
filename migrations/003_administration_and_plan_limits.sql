-- Platform administration and enforceable account limits.
-- One master administrator is claimed once through a server-held bootstrap secret.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS platform_role text NOT NULL DEFAULT 'subscriber'
    CHECK (platform_role IN ('master_admin', 'subscriber', 'support')),
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_reason text;

CREATE UNIQUE INDEX IF NOT EXISTS users_single_master_admin
  ON users ((platform_role)) WHERE platform_role = 'master_admin' AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS organization_memberships_one_owned_organization_per_user
  ON organization_memberships (user_id) WHERE role = 'owner';

ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS max_fiscal_profiles integer NOT NULL DEFAULT 1 CHECK (max_fiscal_profiles = -1 OR max_fiscal_profiles >= 1),
  ADD COLUMN IF NOT EXISTS max_authorized_users integer NOT NULL DEFAULT 1 CHECK (max_authorized_users >= 1),
  ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE subscription_plans
SET
  max_fiscal_profiles = CASE id WHEN 'accounting_firm' THEN -1 ELSE 1 END,
  max_authorized_users = CASE id WHEN 'individual' THEN 1 WHEN 'company' THEN 5 WHEN 'accounting_firm' THEN 10 ELSE 1 END,
  capabilities = CASE id
    WHEN 'individual' THEN '{"mobile_scan":true,"web_panel":true,"reports":false,"exports":false,"ai_connection":true}'::jsonb
    WHEN 'company' THEN '{"mobile_scan":true,"web_panel":true,"reports":true,"exports":true,"ai_connection":true}'::jsonb
    WHEN 'accounting_firm' THEN '{"mobile_scan":true,"web_panel":true,"reports":true,"exports":true,"ai_connection":true,"quick_taxpayer_switch":true}'::jsonb
    ELSE '{}'::jsonb
  END;

CREATE TABLE IF NOT EXISTS organization_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  contracting_session_id uuid UNIQUE REFERENCES contracting_sessions(id) ON DELETE SET NULL,
  plan_id text NOT NULL REFERENCES subscription_plans(id),
  status text NOT NULL DEFAULT 'pending_activation' CHECK (status IN ('pending_activation', 'active', 'suspended', 'cancelled', 'custom_quote_required')),
  billing_period text NOT NULL CHECK (billing_period IN ('monthly', 'quarterly', 'annual')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency char(3) NOT NULL DEFAULT 'MXN',
  max_fiscal_profiles integer NOT NULL CHECK (max_fiscal_profiles = -1 OR max_fiscal_profiles >= 1),
  max_authorized_users integer NOT NULL CHECK (max_authorized_users >= 1),
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS organization_subscriptions_status_idx ON organization_subscriptions (status, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  is_secret boolean NOT NULL DEFAULT false,
  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_settings (key, value, is_secret)
VALUES
  ('master_admin_claimed', 'false'::jsonb, false),
  ('catalog_version', '1'::jsonb, false),
  ('contracting_configuration', '{"otp_ttl_seconds":300,"otp_resend_seconds":60,"voucher_max_bytes":10485760}'::jsonb, false)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS admin_security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_security_events_actor_created_idx
  ON admin_security_events (actor_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION enforce_fiscal_profile_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  profile_limit integer;
  existing_count integer;
BEGIN
  SELECT s.max_fiscal_profiles INTO profile_limit
  FROM organization_subscriptions s
  WHERE s.organization_id = NEW.organization_id AND s.status IN ('pending_activation', 'active');
  IF profile_limit IS NULL THEN
    RAISE EXCEPTION 'La organización no tiene una suscripción válida';
  END IF;
  IF profile_limit = -1 THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO existing_count FROM fiscal_profiles WHERE organization_id = NEW.organization_id;
  IF existing_count >= profile_limit THEN
    RAISE EXCEPTION 'El plan contratado permite un máximo de % contribuyente(s)', profile_limit USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fiscal_profiles_enforce_subscription_limit ON fiscal_profiles;
CREATE TRIGGER fiscal_profiles_enforce_subscription_limit
BEFORE INSERT ON fiscal_profiles
FOR EACH ROW EXECUTE FUNCTION enforce_fiscal_profile_limit();

CREATE OR REPLACE FUNCTION enforce_membership_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  member_limit integer;
  existing_count integer;
BEGIN
  SELECT s.max_authorized_users INTO member_limit
  FROM organization_subscriptions s
  WHERE s.organization_id = NEW.organization_id AND s.status IN ('pending_activation', 'active');
  IF member_limit IS NULL THEN
    RAISE EXCEPTION 'La organización no tiene una suscripción válida';
  END IF;
  SELECT count(*) INTO existing_count FROM organization_memberships WHERE organization_id = NEW.organization_id;
  IF existing_count >= member_limit THEN
    RAISE EXCEPTION 'El plan contratado permite un máximo de % usuario(s)', member_limit USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organization_memberships_enforce_subscription_limit ON organization_memberships;
CREATE TRIGGER organization_memberships_enforce_subscription_limit
BEFORE INSERT ON organization_memberships
FOR EACH ROW EXECUTE FUNCTION enforce_membership_limit();

DROP TRIGGER IF EXISTS organization_subscriptions_touch_updated_at ON organization_subscriptions;
CREATE TRIGGER organization_subscriptions_touch_updated_at BEFORE UPDATE ON organization_subscriptions
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS platform_settings_touch_updated_at ON platform_settings;
CREATE TRIGGER platform_settings_touch_updated_at BEFORE UPDATE ON platform_settings
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
