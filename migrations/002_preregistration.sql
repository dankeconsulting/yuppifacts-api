CREATE TABLE IF NOT EXISTS plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  subscriber_kind text NOT NULL CHECK (subscriber_kind IN ('individual', 'company', 'accounting_firm', 'corporate')),
  billing_period text NOT NULL DEFAULT 'monthly',
  price_mxn numeric(12,2),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS preregistrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folio text NOT NULL UNIQUE,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  plan_id uuid REFERENCES plans(id),
  subscriber_kind text NOT NULL CHECK (subscriber_kind IN ('individual', 'company', 'accounting_firm', 'corporate')),
  holder_name text NOT NULL,
  organization_name text,
  email text NOT NULL,
  phone text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'payment_pending', 'voucher_submitted', 'payment_verified', 'pre_registration_approved', 'profile_in_progress', 'profile_submitted', 'active', 'clarification_requested', 'rejected', 'suspended', 'cancelled')) DEFAULT 'draft',
  profile_progress smallint NOT NULL DEFAULT 10 CHECK (profile_progress BETWEEN 10 AND 100),
  is_online boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  preregistration_id uuid NOT NULL REFERENCES preregistrations(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('mercado_pago', 'voucher')),
  provider_reference text,
  storage_key text,
  status text NOT NULL CHECK (status IN ('pending', 'voucher_submitted', 'verified', 'rejected')) DEFAULT 'pending',
  amount_mxn numeric(12,2),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS preregistration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  preregistration_id uuid NOT NULL REFERENCES preregistrations(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  from_status text,
  to_status text NOT NULL,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profile_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_kind text NOT NULL CHECK (subscriber_kind IN ('individual', 'company', 'accounting_firm', 'corporate')),
  code text NOT NULL,
  label text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  UNIQUE(subscriber_kind, code)
);

CREATE INDEX IF NOT EXISTS preregistrations_status_created_idx ON preregistrations(status, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_evidence_preregistration_idx ON payment_evidence(preregistration_id, status);
CREATE INDEX IF NOT EXISTS preregistration_events_registration_idx ON preregistration_events(preregistration_id, created_at DESC);
