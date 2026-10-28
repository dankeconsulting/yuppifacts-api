CREATE TABLE IF NOT EXISTS admin_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  title text NOT NULL,
  detail text,
  route text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_activity_log_admin_created_idx
  ON admin_activity_log (admin_user_id, created_at DESC);
