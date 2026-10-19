import { z } from "zod";
import { query } from "./db.js";
import { ApiError } from "./contracting.js";
import { createPromotionVoucherUploadUrl, verifyPromotionVoucherUpload } from "./storage.js";

const phone = z.string().regex(/^\+[1-9]\d{7,14}$/, "Número de WhatsApp inválido");
const documentType = z.enum(["application/pdf", "image/jpeg", "image/png"]);
const countries = {
  MX: ["Aguascalientes", "Baja California", "Baja California Sur", "Campeche", "Chiapas", "Chihuahua", "Ciudad de México", "Coahuila", "Colima", "Durango", "Estado de México", "Guanajuato", "Guerrero", "Hidalgo", "Jalisco", "Michoacán", "Morelos", "Nayarit", "Nuevo León", "Oaxaca", "Puebla", "Querétaro", "Quintana Roo", "San Luis Potosí", "Sinaloa", "Sonora", "Tabasco", "Tamaulipas", "Tlaxcala", "Veracruz", "Yucatán", "Zacatecas"],
  CO: ["Amazonas", "Antioquia", "Arauca", "Atlántico", "Bogotá, D.C.", "Bolívar", "Boyacá", "Caldas", "Caquetá", "Casanare", "Cauca", "Cesar", "Chocó", "Córdoba", "Cundinamarca", "Guainía", "Guaviare", "Huila", "La Guajira", "Magdalena", "Meta", "Nariño", "Norte de Santander", "Putumayo", "Quindío", "Risaralda", "San Andrés y Providencia", "Santander", "Sucre", "Tolima", "Valle del Cauca", "Vaupés", "Vichada"],
  CR: ["Alajuela", "Cartago", "Guanacaste", "Heredia", "Limón", "Puntarenas", "San José"],
} as const;

const countryCode = z.enum(["MX", "CO", "CR"]);
export const createPromotionVoucherInput = z.object({
  fullName: z.string().trim().min(3).max(160),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  phoneE164: phone,
  countryCode,
  stateName: z.string().trim().min(2).max(100),
  filename: z.string().trim().min(1).max(180),
  contentType: documentType,
  byteSize: z.number().int().positive().max(10 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const submitPromotionVoucherInput = z.object({ id: z.string().uuid() });

type VoucherRow = { id: string; storage_key: string; status: string; content_type: "application/pdf" | "image/jpeg" | "image/png"; byte_size: number };

function validateState(country: z.infer<typeof countryCode>, state: string) {
  if (!countries[country].includes(state as never)) throw new ApiError(400, "Selecciona un estado o departamento válido.");
}

export async function createPromotionVoucher(input: z.infer<typeof createPromotionVoucherInput>) {
  validateState(input.countryCode, input.stateName);
  const voucherId = crypto.randomUUID();
  const upload = await createPromotionVoucherUploadUrl({ voucherId, filename: input.filename, contentType: input.contentType });
  await query(
    `INSERT INTO promotion_vouchers (id, full_name, email, phone_e164, country_code, state_name, storage_key, original_filename, content_type, byte_size, sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [voucherId, input.fullName, input.email, input.phoneE164, input.countryCode, input.stateName, upload.key, input.filename, input.contentType, input.byteSize, input.sha256],
  );
  return { voucherId, uploadUrl: upload.uploadUrl, expiresIn: upload.expiresIn };
}

export async function submitPromotionVoucher(input: z.infer<typeof submitPromotionVoucherInput>) {
  const pending = await query<VoucherRow>(
    `SELECT id, storage_key, status, content_type, byte_size FROM promotion_vouchers
      WHERE id = $1 AND status = 'upload_pending'`,
    [input.id],
  );
  const voucher = pending.rows[0];
  if (!voucher) throw new ApiError(409, "Este comprobante ya fue enviado o ya no está disponible.");
  const uploadIsValid = await verifyPromotionVoucherUpload({ key: voucher.storage_key, contentType: voucher.content_type, byteSize: voucher.byte_size });
  if (!uploadIsValid) throw new ApiError(400, "No encontramos un comprobante válido. Vuelve a cargarlo e inténtalo de nuevo.");
  const result = await query<VoucherRow>(
    `UPDATE promotion_vouchers SET status = 'submitted', submitted_at = now()
      WHERE id = $1 AND status = 'upload_pending'
      RETURNING id, storage_key, status`,
    [input.id],
  );
  if (!result.rows[0]) throw new ApiError(409, "Este comprobante ya fue enviado o ya no está disponible.");
  return { voucherId: result.rows[0].id, status: "submitted" as const };
}
