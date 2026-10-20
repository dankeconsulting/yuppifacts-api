CREATE TABLE IF NOT EXISTS promotion_plans (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9_]{2,80}$'),
  profile text NOT NULL CHECK (profile IN ('accountant', 'company', 'corporate')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  seats text NOT NULL CHECK (char_length(seats) BETWEEN 1 AND 180),
  monthly_amount_cents integer NOT NULL CHECK (monthly_amount_cents > 0),
  quarterly_amount_cents integer NOT NULL CHECK (quarterly_amount_cents > 0),
  regular_monthly_amount_cents integer,
  benefits jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(benefits) = 'array'),
  active boolean NOT NULL DEFAULT true,
  display_order smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS promotion_plans_profile_display_order_unique
  ON promotion_plans(profile, display_order);

INSERT INTO promotion_plans (id, profile, name, seats, monthly_amount_cents, quarterly_amount_cents, regular_monthly_amount_cents, benefits, active, display_order)
VALUES
  ('independent_accountant', 'accountant', 'Contador independiente', '1 asiento', 89900, 242700, 149900, '["1 asiento de trabajo","Solicitudes sin cuota fija de volumen","Cambio rápido entre contribuyentes","Panel contable y escáner móvil","Compatible con IA mediante tu propia API Key. El servicio y consumo de IA se contratan por separado y no están incluidos en el precio","Reportes avanzados"]'::jsonb, true, 10),
  ('accounting_firm', 'accountant', 'Despacho contable', '3 asientos', 199900, 539700, 349900, '["3 asientos de trabajo","Solicitudes sin cuota fija de volumen","Cambio rápido entre contribuyentes","Panel contable y escáner móvil","Compatible con IA mediante tu propia API Key. El servicio y consumo de IA se contratan por separado y no están incluidos en el precio","Reportes avanzados"]'::jsonb, true, 20),
  ('company', 'company', 'Empresa', '1 empresa · hasta 5 asientos', 299900, 809700, 499900, '["Hasta 5 asientos autorizados","Una empresa y su equipo","Solicitudes sin cuota fija de volumen*","Escáner móvil para tu equipo","XML y PDF organizados","Compatible con IA mediante tu propia API Key. El servicio y consumo de IA se contratan por separado y no están incluidos en el precio","Reportes avanzados"]'::jsonb, true, 10),
  ('corporate', 'corporate', 'Corporativo', 'Hasta 2 sucursales · 5 asientos por sucursal', 499900, 1349700, 799900, '["Hasta 2 sucursales","5 asientos por sucursal","Solicitudes sin cuota fija de volumen*","Control por empresa y RFC","Panel centralizado y escáner móvil","Compatible con IA mediante tu propia API Key. El servicio y consumo de IA se contratan por separado y no están incluidos en el precio","Reportes avanzados"]'::jsonb, true, 10)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE promotion_contracts
  DROP CONSTRAINT IF EXISTS promotion_contracts_plan_id_check;
ALTER TABLE promotion_contracts
  ADD COLUMN IF NOT EXISTS plan_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

DROP TRIGGER IF EXISTS promotion_plans_touch_updated_at ON promotion_plans;
CREATE TRIGGER promotion_plans_touch_updated_at BEFORE UPDATE ON promotion_plans
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
