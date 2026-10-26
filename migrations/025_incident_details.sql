ALTER TABLE subscriber_incidents
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'media' CHECK (priority IN ('alta','media','baja')),
  ADD COLUMN IF NOT EXISTS description text;
