CREATE TABLE IF NOT EXISTS landing_modal_configuration (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  is_enabled boolean NOT NULL DEFAULT false,
  title_es text NOT NULL DEFAULT 'Contrata YuppiFacts y agiliza la solicitud de tus facturas.',
  body_es text NOT NULL DEFAULT 'Conoce cómo YuppiFacts organiza tus solicitudes y facturas.',
  cta_es text NOT NULL DEFAULT 'Quiero agilizar mi facturación',
  title_en text NOT NULL DEFAULT 'Your tax information, in order.',
  body_en text NOT NULL DEFAULT 'Learn how YuppiFacts organizes your requests and invoices.',
  cta_en text NOT NULL DEFAULT 'Discover YuppiFacts',
  updated_at timestamptz NOT NULL DEFAULT now()
);
