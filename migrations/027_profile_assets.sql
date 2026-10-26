ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_object_key text,
  ADD COLUMN IF NOT EXISTS avatar_updated_at timestamptz;

CREATE INDEX IF NOT EXISTS users_avatar_object_key_idx
  ON users (avatar_object_key)
  WHERE avatar_object_key IS NOT NULL;
