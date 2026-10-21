-- The UUID remains the internal key. This is the short, immutable identifier
-- displayed to administrators and used in the protected deletion confirmation.
ALTER TABLE users ADD COLUMN IF NOT EXISTS user_number bigint;

CREATE SEQUENCE IF NOT EXISTS users_user_number_seq;
ALTER SEQUENCE users_user_number_seq OWNED BY users.user_number;

ALTER TABLE users
  ALTER COLUMN user_number SET DEFAULT nextval('users_user_number_seq');

WITH numbered_users AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id)::bigint AS user_number
  FROM users
  WHERE user_number IS NULL
)
UPDATE users
SET user_number = numbered_users.user_number
FROM numbered_users
WHERE users.id = numbered_users.id;

SELECT setval(
  'users_user_number_seq',
  GREATEST(COALESCE((SELECT max(user_number) FROM users), 1), 1),
  true
);

ALTER TABLE users ALTER COLUMN user_number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_user_number_unique ON users(user_number);
