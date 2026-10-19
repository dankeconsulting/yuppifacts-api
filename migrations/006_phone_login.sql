-- Phone-first access is independent from contracting. OTPs are generated in-app,
-- stored only as hashes, and must be followed by the account PIN.

CREATE TABLE IF NOT EXISTS access_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone_e164 text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('login_phone')),
  code_hash text NOT NULL,
  verification_token_hash text,
  expires_at timestamptz NOT NULL,
  resend_available_at timestamptz NOT NULL,
  max_attempts smallint NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  verified_at timestamptz,
  completed_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS access_challenges_phone_active_idx
  ON access_challenges (phone_e164, created_at DESC)
  WHERE verified_at IS NULL AND invalidated_at IS NULL;
CREATE INDEX IF NOT EXISTS access_challenges_user_active_idx
  ON access_challenges (user_id, created_at DESC)
  WHERE completed_at IS NULL AND invalidated_at IS NULL;
