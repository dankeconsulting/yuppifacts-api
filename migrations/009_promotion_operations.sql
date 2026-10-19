ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_source text NOT NULL DEFAULT 'standard'
  CHECK (acquisition_source IN ('standard', 'promotion'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS promotion_price_locked boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS promotion_notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id uuid REFERENCES promotion_vouchers(id) ON DELETE SET NULL,
  recipient text NOT NULL,
  reply_to text NOT NULL,
  template text NOT NULL CHECK (template IN ('contract_received', 'voucher_received', 'advisor_assigned', 'panel_access')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  provider_message_id text,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS promotion_notification_outbox_pending_idx
  ON promotion_notification_outbox (status, created_at) WHERE status IN ('pending', 'failed');
DROP TRIGGER IF EXISTS promotion_notification_outbox_touch_updated_at ON promotion_notification_outbox;
CREATE TRIGGER promotion_notification_outbox_touch_updated_at BEFORE UPDATE ON promotion_notification_outbox
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
