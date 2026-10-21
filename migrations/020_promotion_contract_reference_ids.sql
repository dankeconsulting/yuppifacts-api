-- A short numeric reference for every promotion record. It allows legacy
-- temporary records (which predate user creation) to be reviewed and removed
-- with the same human-readable confirmation used for subscriber accounts.
ALTER TABLE promotion_contracts ADD COLUMN IF NOT EXISTS admin_reference bigint;

CREATE SEQUENCE IF NOT EXISTS promotion_contracts_admin_reference_seq;
ALTER SEQUENCE promotion_contracts_admin_reference_seq OWNED BY promotion_contracts.admin_reference;

ALTER TABLE promotion_contracts
  ALTER COLUMN admin_reference SET DEFAULT nextval('promotion_contracts_admin_reference_seq');

WITH numbered_contracts AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id)::bigint AS admin_reference
  FROM promotion_contracts
  WHERE admin_reference IS NULL
)
UPDATE promotion_contracts
SET admin_reference = numbered_contracts.admin_reference
FROM numbered_contracts
WHERE promotion_contracts.id = numbered_contracts.id;

SELECT setval(
  'promotion_contracts_admin_reference_seq',
  COALESCE((SELECT max(admin_reference) FROM promotion_contracts), 1),
  EXISTS(SELECT 1 FROM promotion_contracts)
);

ALTER TABLE promotion_contracts ALTER COLUMN admin_reference SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS promotion_contracts_admin_reference_unique
  ON promotion_contracts(admin_reference);
