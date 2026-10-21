-- One-time convenience seed: duplicate the current promo catalog into the separate regular catalog.
-- After this migration, each catalog is edited independently.
INSERT INTO regular_plans (
  id, profile, mode, name, seats,
  monthly_amount_cents, quarterly_amount_cents, semiannual_amount_cents, annual_amount_cents,
  benefits, active, display_order
)
SELECT
  id, profile, mode, name, seats,
  monthly_amount_cents, quarterly_amount_cents, semiannual_amount_cents, annual_amount_cents,
  benefits, active, display_order
FROM promotion_plans
ON CONFLICT DO NOTHING;
