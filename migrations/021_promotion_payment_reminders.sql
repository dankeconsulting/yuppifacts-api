ALTER TABLE promotion_notification_outbox
  ADD COLUMN IF NOT EXISTS promotion_contract_id uuid REFERENCES promotion_contracts(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS deliver_after timestamptz NOT NULL DEFAULT now();

ALTER TABLE promotion_notification_outbox DROP CONSTRAINT IF EXISTS promotion_notification_outbox_template_check;
ALTER TABLE promotion_notification_outbox ADD CONSTRAINT promotion_notification_outbox_template_check
  CHECK (template IN ('contract_received', 'voucher_received', 'advisor_assigned', 'panel_access', 'payment_reminder'));

ALTER TABLE promotion_notification_outbox DROP CONSTRAINT IF EXISTS promotion_notification_outbox_status_check;
ALTER TABLE promotion_notification_outbox ADD CONSTRAINT promotion_notification_outbox_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled'));

CREATE UNIQUE INDEX IF NOT EXISTS promotion_payment_reminder_once
  ON promotion_notification_outbox (promotion_contract_id)
  WHERE template = 'payment_reminder';

CREATE INDEX IF NOT EXISTS promotion_notification_outbox_due_idx
  ON promotion_notification_outbox (deliver_after, created_at)
  WHERE status = 'pending';
