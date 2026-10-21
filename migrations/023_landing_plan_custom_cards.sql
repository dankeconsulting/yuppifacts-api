-- Permit additional, administrator-created landing cards while preserving the existing rows.
ALTER TABLE landing_plans DROP CONSTRAINT IF EXISTS landing_plans_id_check;
ALTER TABLE landing_plans
  ADD CONSTRAINT landing_plans_id_check CHECK (id ~ '^[a-z0-9_]{2,80}$');
