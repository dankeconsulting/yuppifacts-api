import { z } from "zod";
import { query } from "./db.js";
import { ApiError } from "./contracting.js";
import { createPromotionVoucherUploadUrl, verifyPromotionVoucherUpload } from "./storage.js";
import { deliverPromotionEmail, queuePromotionEmail } from "./promotionNotifications.js";
import { promotionAccessInput, requirePromotionContract } from "./promotionContracts.js";
import { verifySecret } from "./security.js";

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
  promotionId: z.string().uuid().optional(),
  promotionToken: z.string().min(32).max(256).optional(),
});

export const submitPromotionVoucherInput = z.object({ id: z.string().uuid() });
export const promotionVoucherReviewsInput = z.object({ pin: z.string().regex(/^\d{4,12}$/) });
export const reviewPromotionVoucherInput = promotionVoucherReviewsInput.extend({ voucherId: z.string().uuid(), approved: z.boolean() });

type VoucherRow = { id: string; storage_key: string; status: string; content_type: "application/pdf" | "image/jpeg" | "image/png"; byte_size: number; full_name:string; email:string };
type ReviewRow = { id:string; full_name:string; email:string; phone_e164:string; original_filename:string; status:string; submitted_at:Date|null; promotion_contract_id:string|null; folio:string|null; plan_id:string|null; billing_period:string|null; quoted_amount_cents:number|null };

async function requireMasterPin(pin:string){const result=await query<{id:string;pin_hash:string}>("SELECT id,pin_hash FROM users WHERE platform_role='master_admin' AND account_status='active' AND deleted_at IS NULL LIMIT 1");const admin=result.rows[0];if(!admin||!(await verifySecret(pin,admin.pin_hash)))throw new ApiError(401,"PIN administrativo no válido.");return admin.id;}

function validateState(country: z.infer<typeof countryCode>, state: string) {
  if (!countries[country].includes(state as never)) throw new ApiError(400, "Selecciona un estado o departamento válido.");
}

export async function createPromotionVoucher(input: z.infer<typeof createPromotionVoucherInput>) {
  validateState(input.countryCode, input.stateName);
  if (Boolean(input.promotionId) !== Boolean(input.promotionToken)) throw new ApiError(400, "Falta la referencia de la contratación promocional.");
  const contract = input.promotionId && input.promotionToken ? await requirePromotionContract(promotionAccessInput.parse({promotionId:input.promotionId,promotionToken:input.promotionToken})) : null;
  const voucherId = crypto.randomUUID();
  const upload = await createPromotionVoucherUploadUrl({ voucherId, filename: input.filename, contentType: input.contentType });
  await query(
    `INSERT INTO promotion_vouchers (id, promotion_contract_id, full_name, email, phone_e164, country_code, state_name, amount_cents, currency, storage_key, original_filename, content_type, byte_size, sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'MXN', $9, $10, $11, $12, $13)`,
    [voucherId, contract?.id ?? null, input.fullName, input.email, input.phoneE164, input.countryCode, input.stateName, contract?.quoted_amount_cents ?? 390000, upload.key, input.filename, input.contentType, input.byteSize, input.sha256],
  );
  if(contract)await query(`UPDATE promotion_contracts SET full_name=$2,email=$3,phone_e164=$4,country_code=$5,state_name=$6 WHERE id=$1`,[contract.id,input.fullName,input.email,input.phoneE164,input.countryCode,input.stateName]);
  return { voucherId, uploadUrl: upload.uploadUrl, expiresIn: upload.expiresIn };
}

export async function submitPromotionVoucher(input: z.infer<typeof submitPromotionVoucherInput>) {
  const pending = await query<VoucherRow>(
    `SELECT id, storage_key, status, content_type, byte_size, full_name, email FROM promotion_vouchers
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
  const emailId = await queuePromotionEmail({ voucherId:voucher.id, recipient:voucher.email, template:"voucher_received", payload:{fullName:voucher.full_name} });
  void deliverPromotionEmail(emailId);
  await query(`UPDATE promotion_contracts SET lifecycle_status='voucher_submitted' WHERE id=(SELECT promotion_contract_id FROM promotion_vouchers WHERE id=$1) AND lifecycle_status IN ('draft','pending_payment')`,[voucher.id]);
  return { voucherId: result.rows[0].id, status: "submitted" as const };
}

export async function listPromotionVoucherReviews(input:z.infer<typeof promotionVoucherReviewsInput>){await requireMasterPin(input.pin);const result=await query<ReviewRow>(`SELECT voucher.id,voucher.full_name,voucher.email,voucher.phone_e164,voucher.original_filename,voucher.status,voucher.submitted_at,voucher.promotion_contract_id,contract.folio,contract.plan_id,contract.billing_period,contract.quoted_amount_cents FROM promotion_vouchers voucher LEFT JOIN promotion_contracts contract ON contract.id=voucher.promotion_contract_id WHERE voucher.status IN ('submitted','verified','rejected') ORDER BY voucher.submitted_at DESC NULLS LAST LIMIT 200`);return {vouchers:result.rows.map(voucher=>({id:voucher.id,fullName:voucher.full_name,email:voucher.email,phone:voucher.phone_e164,filename:voucher.original_filename,status:voucher.status,submittedAt:voucher.submitted_at?.toISOString()??null,promotionId:voucher.promotion_contract_id,folio:voucher.folio,planId:voucher.plan_id,billingPeriod:voucher.billing_period,quotedAmountCents:voucher.quoted_amount_cents}))};}

export async function reviewPromotionVoucher(input:z.infer<typeof reviewPromotionVoucherInput>){await requireMasterPin(input.pin);const status=input.approved?'verified':'rejected';const result=await query<{promotion_contract_id:string|null}>("UPDATE promotion_vouchers SET status=$2,reviewed_at=now() WHERE id=$1 AND status='submitted' RETURNING promotion_contract_id",[input.voucherId,status]);const voucher=result.rows[0];if(!voucher)throw new ApiError(409,"Este voucher ya fue revisado o no está disponible.");if(!input.approved&&voucher.promotion_contract_id)await query("UPDATE promotion_contracts SET lifecycle_status='pending_payment' WHERE id=$1 AND lifecycle_status='voucher_submitted'",[voucher.promotion_contract_id]);return {status};}
