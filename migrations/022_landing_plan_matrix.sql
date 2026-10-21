CREATE TABLE IF NOT EXISTS landing_plans (
  id text PRIMARY KEY CHECK (id IN ('individual','independent_accountant','accounting_firm','company','corporate')),
  title text NOT NULL,
  subtitle text,
  description text NOT NULL,
  audience text NOT NULL,
  benefits jsonb NOT NULL DEFAULT '[]'::jsonb,
  monthly_amount_cents integer CHECK (monthly_amount_cents > 0),
  quarterly_amount_cents integer CHECK (quarterly_amount_cents > 0),
  semiannual_amount_cents integer CHECK (semiannual_amount_cents > 0),
  annual_amount_cents integer CHECK (annual_amount_cents > 0),
  active boolean NOT NULL DEFAULT false,
  display_order integer NOT NULL DEFAULT 100
);

INSERT INTO landing_plans (id,title,subtitle,description,audience,benefits,monthly_amount_cents,quarterly_amount_cents,annual_amount_cents,active,display_order) VALUES
  ('individual','Persona Física / Natural',NULL,'Tus tickets y facturas, organizados en un solo lugar.','Para personas físicas con actividad empresarial, RESICO y pequeños contribuyentes.','["1 contribuyente","Hasta 100 solicitudes al mes","Escáner QR desde el celular","Facturas XML y PDF","Historial y organización mensual","Conexión de IA propia"]'::jsonb,49900,134700,479000,true,10),
  ('independent_accountant','Contador independiente',NULL,'Gestiona tus contribuyentes desde un espacio de trabajo claro.','Para profesionales que atienden cuentas de forma independiente.','[]'::jsonb,false,20),
  ('accounting_firm','Despachos Contables',NULL,'Todos tus contribuyentes desde un solo espacio de trabajo.','Para despachos contables con cartera de contribuyentes.','["Contribuyentes ilimitados","Solicitudes sin cuota fija de volumen*","Hasta 10 usuarios autorizados","Cambio rápido entre contribuyentes","Panel contable y escáner móvil","IA propia y reportes avanzados"]'::jsonb,500000,1350000,4800000,true,30),
  ('company','Persona Moral / Jurídica','Empresas','Control de facturación para empresas y sus equipos.','Para empresas con áreas contables propias.','["1 razón social","Hasta 3,000 solicitudes al mes","Hasta 5 usuarios autorizados","Escáner móvil y panel web","Reportes y exportaciones","Conexión de IA propia"]'::jsonb,250000,675000,2400000,true,40),
  ('corporate','Persona Moral / Jurídica','Corporativos','Control de facturación para corporativos y sus equipos.','[]'::jsonb,false,50)
ON CONFLICT (id) DO NOTHING;
