import { ApiError } from "./contracting.js";
import { query } from "./db.js";
import { verifySecret } from "./security.js";

export type LandingModal = { isEnabled: boolean; titleEs: string; bodyEs: string; ctaEs: string; titleEn: string; bodyEn: string; ctaEn: string };

const defaults: LandingModal = { isEnabled: false, titleEs: "Contrata YuppiFacts y agiliza la solicitud de tus facturas.", bodyEs: "Conoce cómo YuppiFacts organiza tus solicitudes y facturas.", ctaEs: "Quiero agilizar mi facturación", titleEn: "Get YuppiFacts and streamline your invoice requests.", bodyEn: "Learn how YuppiFacts organizes your requests and invoices.", ctaEn: "I want faster invoicing" };

async function requireMasterPin(pin: string) {
  const result = await query<{ pin_hash: string }>("SELECT pin_hash FROM users WHERE platform_role = 'master_admin' AND account_status = 'active' AND deleted_at IS NULL LIMIT 1");
  if (!result.rows[0] || !(await verifySecret(pin, result.rows[0].pin_hash))) throw new ApiError(401, "PIN administrativo no válido.");
}

export async function getLandingModal(pin?: string): Promise<LandingModal> {
  if (pin !== undefined) await requireMasterPin(pin);
  const result = await query<{ is_enabled: boolean; title_es: string; body_es: string; cta_es: string; title_en: string; body_en: string; cta_en: string }>("SELECT is_enabled, title_es, body_es, cta_es, title_en, body_en, cta_en FROM landing_modal_configuration WHERE singleton = true");
  if (!result.rowCount) return defaults;
  const row = result.rows[0];
  return { isEnabled: row.is_enabled, titleEs: row.title_es, bodyEs: row.body_es, ctaEs: row.cta_es, titleEn: row.title_en, bodyEn: row.body_en, ctaEn: row.cta_en };
}

export async function saveLandingModal(input: LandingModal & { pin?: string }) {
  await requireMasterPin(input.pin ?? "");
  await query("INSERT INTO landing_modal_configuration(singleton, is_enabled, title_es, body_es, cta_es, title_en, body_en, cta_en) VALUES (true, $1, $2, $3, $4, $5, $6, $7) ON CONFLICT (singleton) DO UPDATE SET is_enabled = EXCLUDED.is_enabled, title_es = EXCLUDED.title_es, body_es = EXCLUDED.body_es, cta_es = EXCLUDED.cta_es, title_en = EXCLUDED.title_en, body_en = EXCLUDED.body_en, cta_en = EXCLUDED.cta_en, updated_at = now()", [input.isEnabled, input.titleEs, input.bodyEs, input.ctaEs, input.titleEn, input.bodyEn, input.ctaEn]);
}
