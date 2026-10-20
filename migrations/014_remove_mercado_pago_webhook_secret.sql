ALTER TABLE payment_provider_configurations
  DROP COLUMN IF EXISTS webhook_secret_encrypted;
