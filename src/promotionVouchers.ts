import { z } from "zod";
import { query, transaction } from "./db.js";
import { ApiError } from "./contracting.js";
import { createPromotionVoucherUploadUrl, verifyPromotionVoucherUpload } from "./storage.js";
import { deliverPromotionEmail, queuePromotionEmail } from "./promotionNotifications.js";
import { promotionAccessInput, requirePromotionContract } from "./promotionContracts.js";
import { hashSecret, verifySecret } from "./security.js";
import { moveSubscriberToReview } from "./adminSubscribers.js";

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
  cityName: z.string().trim().min(2).max(120),
  pin: z.string().regex(/^\d{4}$/),
  pinConfirmation: z.string().regex(/^\d{4}$/),
  filename: z.string().trim().min(1).max(180),
  contentType: documentType,
  byteSize: z.number().int().positive().max(10 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  promotionId: z.string().uuid().optional(),
  promotionToken: z.string().min(32).max(256).optional(),
}).refine((value) => value.pin === value.pinConfirmation, { path: ["pinConfirmation"], message: "Los PIN no coinciden." });

export const submitPromotionVoucherInput = z.object({ id: z.string().uuid() });
export const promotionVoucherReviewsInput = z.object({ pin: z.string().regex(/^\d{4,12}$/) });
export const reviewPromotionVoucherInput = promotionVoucherReviewsInput.extend({ voucherId: z.string().uuid(), approved: z.boolean() });

type VoucherRow = { id: string; storage_key: string; status: string; content_type: "application/pdf" | "image/jpeg" | "image/png"; byte_size: number; full_name:string; email:string };
type ReviewRow = { id:string; full_name:string; email:string; phone_e164:string; original_filename:string; status:string; submitted_at:Date|null; promotion_contract_id:string|null; folio:string|null; profile:string|null; plan_id:string|null; billing_period:string|null; quoted_amount_cents:number|null };

async function requireMasterPin(pin:string){const result=await query<{id:string;pin_hash:string}>("SELECT id,pin_hash FROM users WHERE platform_role='master_admin' AND account_status='active' AND deleted_at IS NULL LIMIT 1");const admin=result.rows[0];if(!admin||!(await verifySecret(pin,admin.pin_hash)))throw new ApiError(401,"PIN administrativo no válido.");return admin.id;}

function validateState(country: z.infer<typeof countryCode>, state: string) {
  if (!countries[country].includes(state as never)) throw new ApiError(400, "Selecciona un estado o departamento válido.");
}

export async function createPromotionVoucher(input: z.infer<typeof createPromotionVoucherInput>) {
  validateState(input.countryCode, input.stateName);
  if (Boolean(input.promotionId) !== Boolean(input.promotionToken)) throw new ApiError(400, "Falta la referencia de la contratación promocional.");
  const contract = input.promotionId && input.promotionToken ? await requirePromotionContract(promotionAccessInput.parse({promotionId:input.promotionId,promotionToken:input.promotionToken})) : null;
  if (contract) {
    const prior = await query<{id:string}>(`SELECT voucher.id
      FROM promotion_vouchers voucher
      JOIN promotion_contracts prior_contract ON prior_contract.id = voucher.promotion_contract_id
      JOIN promotion_contracts current_contract ON current_contract.id = $1
      WHERE voucher.phone_e164 = $2
        AND prior_contract.plan_id = current_contract.plan_id
        AND prior_contract.quoted_amount_cents = current_contract.quoted_amount_cents
        AND voucher.status IN ('submitted','verified')
      LIMIT 1`, [contract.id, input.phoneE164]);
    if (prior.rows[0]) throw new ApiError(409, "Ya nos enviaste tu voucher. Aún estamos procesando tu suscripción; cuando validemos el pago procederemos a activar tu cuenta.");
  }
  const voucherId = crypto.randomUUID();
  const upload = await createPromotionVoucherUploadUrl({ voucherId, filename: input.filename, contentType: input.contentType });
  await transaction(async client => {
    if (contract) {
      const existing = await client.query<{ id:string; platform_role:string }>(
        "SELECT id,platform_role FROM users WHERE phone_e164=$1 AND deleted_at IS NULL LIMIT 1 FOR UPDATE",
        [input.phoneE164],
      );
      const known = existing.rows[0];
      if (!known || known.platform_role === "master_admin") throw new ApiError(404, "No encontramos una cuenta de YuppiFacts con este WhatsApp. Suscríbete para continuar.", "SUBSCRIPTION_NOT_FOUND");
      const linked = await client.query<{ user_id:string|null }>("SELECT user_id FROM promotion_contracts WHERE id=$1 FOR UPDATE", [contract.id]);
      if (linked.rows[0]?.user_id !== known.id) throw new ApiError(409, "Este WhatsApp no corresponde a la contratación seleccionada.");
      const pinHash = await hashSecret(input.pin);
      const userId = known.id;
      await client.query(
        "UPDATE users SET email=$2,full_name=$3,pin_hash=$4,account_status='pending_review',is_online=false,acquisition_source='promotion',promotion_price_locked=true WHERE id=$1",
        [userId,input.email,input.fullName,pinHash],
      );
      await client.query(
        "UPDATE promotion_contracts SET user_id=$2,full_name=$3,email=$4,phone_e164=$5,country_code=$6,state_name=$7,city_name=$8,pin_hash=$9,lifecycle_status=CASE WHEN lifecycle_status='checkout_started' THEN 'pending_payment' ELSE lifecycle_status END WHERE id=$1",
        [contract.id,userId,input.fullName,input.email,input.phoneE164,input.countryCode,input.stateName,input.cityName,pinHash],
      );
    }
    await client.query(
      `INSERT INTO promotion_vouchers (id, promotion_contract_id, full_name, email, phone_e164, country_code, state_name, city_name, amount_cents, currency, storage_key, original_filename, content_type, byte_size, sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'MXN', $10, $11, $12, $13, $14)`,
      [voucherId, contract?.id ?? null, input.fullName, input.email, input.phoneE164, input.countryCode, input.stateName, input.cityName, contract?.quoted_amount_cents ?? 390000, upload.key, input.filename, input.contentType, input.byteSize, input.sha256],
    );
  });
  return { voucherId, uploadUrl: upload.uploadUrl, expiresIn: upload.expiresIn };
}

export async function submitPromotionVoucher(input: z.infer<typeof submitPromotionVoucherInput>) {
  const pending = await query<VoucherRow & { promotion_contract_id:string|null }>(
    `SELECT id, promotion_contract_id, storage_key, status, content_type, byte_size, full_name, email FROM promotion_vouchers
      WHERE id = $1 AND status = 'upload_pending'`,
    [input.id],
  );
  const voucher = pending.rows[0];
  if (!voucher) throw new ApiError(409, "Este comprobante ya fue enviado o ya no está disponible.");
  const uploadIsValid = await verifyPromotionVoucherUpload({ key: voucher.storage_key, contentType: voucher.content_type, byteSize: voucher.byte_size });
  if (!uploadIsValid) throw new ApiError(400, "No encontramos un comprobante válido. Vuelve a cargarlo e inténtalo de nuevo.");
  const result = await transaction(async client => {
    const submitted = await client.query<{ id:string }>(
      `UPDATE promotion_vouchers SET status = 'submitted', submitted_at = now()
        WHERE id = $1 AND status = 'upload_pending'
        RETURNING id`,
      [input.id],
    );
    if (!submitted.rows[0]) throw new ApiError(409, "Este comprobante ya fue enviado o ya no está disponible.");
    if (voucher.promotion_contract_id) {
      const subscriber = await client.query<{ full_name:string; email:string; phone_e164:string; pin_hash:string|null }>(
        "SELECT full_name,email,phone_e164,pin_hash FROM promotion_contracts WHERE id=$1 FOR UPDATE",
        [voucher.promotion_contract_id],
      );
      const account = subscriber.rows[0];
      if (!account?.pin_hash) throw new ApiError(409, "Completa y confirma tu PIN de cuatro dígitos para enviar el comprobante.");
      const existing = await client.query<{ id:string; platform_role:string }>(
        "SELECT id,platform_role FROM users WHERE phone_e164=$1 LIMIT 1 FOR UPDATE",
        [account.phone_e164],
      );
      if (!existing.rows[0] || existing.rows[0].platform_role === "master_admin") throw new ApiError(409, "No encontramos una cuenta temporal válida para este comprobante.");
      const userId = existing.rows[0].id;
      await client.query(
        "UPDATE promotion_contracts SET user_id=$2,lifecycle_status='voucher_submitted' WHERE id=$1 AND lifecycle_status IN ('draft','pending_payment','checkout_started')",
        [voucher.promotion_contract_id, userId],
      );
    }
    return submitted.rows[0];
  });
  const emailId = await queuePromotionEmail({ voucherId:voucher.id, recipient:voucher.email, template:"voucher_received", payload:{fullName:voucher.full_name} });
  if(emailId) void deliverPromotionEmail(emailId);
  return { voucherId: result.id, status: "submitted" as const };
}

export async function listPromotionVoucherReviews(input:z.infer<typeof promotionVoucherReviewsInput>){await requireMasterPin(input.pin);const result=await query<ReviewRow>(`SELECT voucher.id,voucher.full_name,voucher.email,voucher.phone_e164,voucher.original_filename,voucher.status,voucher.submitted_at,voucher.promotion_contract_id,contract.folio,contract.plan_snapshot->>'mode' AS profile,contract.plan_id,contract.billing_period,contract.quoted_amount_cents FROM promotion_vouchers voucher LEFT JOIN promotion_contracts contract ON contract.id=voucher.promotion_contract_id WHERE voucher.status IN ('submitted','verified','rejected') ORDER BY voucher.submitted_at DESC NULLS LAST LIMIT 200`);return {vouchers:result.rows.map(voucher=>({id:voucher.id,fullName:voucher.full_name,email:voucher.email,phone:voucher.phone_e164,filename:voucher.original_filename,status:voucher.status,submittedAt:voucher.submitted_at?.toISOString()??null,promotionId:voucher.promotion_contract_id,folio:voucher.folio,profile:voucher.profile,planId:voucher.plan_id,billingPeriod:voucher.billing_period,quotedAmountCents:voucher.quoted_amount_cents}))};}

export async function reviewPromotionVoucher(input:z.infer<typeof reviewPromotionVoucherInput>){await requireMasterPin(input.pin);if(input.approved){const voucher=await query<{promotion_contract_id:string|null}>("SELECT promotion_contract_id FROM promotion_vouchers WHERE id=$1 AND status='submitted'",[input.voucherId]);const promotionId=voucher.rows[0]?.promotion_contract_id;if(!promotionId)throw new ApiError(409,"Este voucher ya fue revisado o no está disponible.");await moveSubscriberToReview(promotionId);return {status:"verified" as const};}const result=await query<{promotion_contract_id:string|null}>("UPDATE promotion_vouchers SET status='rejected',reviewed_at=now() WHERE id=$1 AND status='submitted' RETURNING promotion_contract_id",[input.voucherId]);const voucher=result.rows[0];if(!voucher)throw new ApiError(409,"Este voucher ya fue revisado o no está disponible.");if(voucher.promotion_contract_id)await query("UPDATE promotion_contracts SET lifecycle_status='pending_payment' WHERE id=$1 AND lifecycle_status='voucher_submitted'",[voucher.promotion_contract_id]);return {status:"rejected" as const};}
