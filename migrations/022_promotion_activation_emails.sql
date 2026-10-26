ALTER TABLE promotion_notification_outbox DROP CONSTRAINT IF EXISTS promotion_notification_outbox_template_check;
ALTER TABLE promotion_notification_outbox ADD CONSTRAINT promotion_notification_outbox_template_check
  CHECK (template IN ('contract_received', 'voucher_received', 'payment_verified', 'advisor_assigned', 'panel_access', 'payment_reminder'));
