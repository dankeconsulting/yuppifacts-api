import { z } from "zod";
import { ApiError } from "./contracting.js";
import { query, transaction } from "./db.js";
import { deletePromotionVoucherObjects } from "./storage.js";

export const subscriberStageInput = z.object({ stage: z.enum(["new", "review", "active"]) });
export const subscriberIdInput = z.object({ id: z.string().uuid() });
export const onlineInput = subscriberIdInput.extend({ online: z.boolean() });
export const deleteSubscribersInput = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
  confirmationIds: z.array(z.coerce.number().int().positive()).min(1).max(100),
});

type SubscriberRow = { id:string; admin_reference:number; full_name:string; email:string; phone_e164:string; country_code:string|null; state_name:string|null; city_name:string|null; plan_id:string; billing_period:string; quoted_amount_cents:number; lifecycle_status:string; subscription_tag:string; created_at:Date; renewal_at:Date|null; voucher_id:string|null; voucher_filename:string|null; voucher_key:string|null; mode:string|null; user_id:string|null; user_number:number|null; platform_role:string|null; account_status:string|null; is_online:boolean|null };

function profileLabel(mode:string|null, planId:string) {
  const key = mode ?? planId;
  return ({ individual:"Persona física", independent_accountant:"Contador independiente", accounting_firm:"Despacho contable", company:"Empresa", corporate:"Corporativo" } as Record<string,string>)[key] ?? key;
}
function serialize(row:SubscriberRow) {
  const isTemporary = !row.user_id;
  return { id:row.id, userId:row.user_id, userNumber:row.user_number, recordNumber:row.user_number ?? row.admin_reference, isTemporary, role:isTemporary ? "Registro temporal" : row.platform_role === "master_admin" ? "Administrador maestro" : "Suscriptor", fullName:row.full_name, email:row.email, phone:row.phone_e164, countryCode:row.country_code ?? "MX", state:row.state_name, city:row.city_name, profile:profileLabel(row.mode,row.plan_id), planId:row.plan_id, billingPeriod:row.billing_period, quotedAmountCents:row.quoted_amount_cents, subscriptionTag:row.subscription_tag, registeredAt:row.created_at.toISOString(), renewalAt:row.renewal_at?.toISOString() ?? null, voucher:{ id:row.voucher_id, filename:row.voucher_filename, storageKey:row.voucher_key }, accountStatus:row.account_status, online:Boolean(row.is_online) };
}
const base = `SELECT contract.id,contract.admin_reference,contract.full_name,contract.email,contract.phone_e164,contract.country_code,contract.state_name,contract.city_name,contract.plan_id,contract.billing_period,contract.quoted_amount_cents,contract.lifecycle_status,contract.subscription_tag,contract.created_at,contract.renewal_at,contract.user_id,user_record.user_number,user_record.platform_role,user_record.account_status,user_record.is_online,contract.plan_snapshot->>'mode' AS mode,voucher.id AS voucher_id,voucher.original_filename AS voucher_filename,voucher.storage_key AS voucher_key FROM promotion_contracts contract LEFT JOIN users user_record ON user_record.id=contract.user_id LEFT JOIN LATERAL (SELECT id,original_filename,storage_key FROM promotion_vouchers WHERE promotion_contract_id=contract.id ORDER BY submitted_at DESC NULLS LAST LIMIT 1) voucher ON true`;

export async function listAdminSubscribers(stage:z.infer<typeof subscriberStageInput>["stage"]) {
  // Legacy contracts created before the temporary-account flow have no user or
  // PIN. They intentionally stay visible in "Usuarios nuevos" so a master
  // administrator can review and remove them through the protected flow.
  const where = stage === "new" ? "(contract.lifecycle_status='voucher_submitted' OR contract.user_id IS NULL)" : stage === "review" ? "contract.lifecycle_status='payment_verified' AND COALESCE(user_record.is_online,false)=false" : "user_record.account_status='active' AND user_record.is_online=true";
  const result = await query<SubscriberRow>(`${base} WHERE ${where} ORDER BY contract.created_at DESC`);
  return { subscribers: result.rows.map(serialize) };
}
export async function getAdminSubscriber(id:string) {
  const result = await query<SubscriberRow>(`${base} WHERE contract.id=$1`,[id]);
  if(!result.rows[0]) throw new ApiError(404,"No encontramos este suscriptor.");
  return { subscriber:serialize(result.rows[0]) };
}
export async function moveSubscriberToReview(id:string) {
  return transaction(async client => {
    const contract=await client.query<{user_id:string|null}>("SELECT user_id FROM promotion_contracts WHERE id=$1 AND lifecycle_status='voucher_submitted' FOR UPDATE",[id]);
    if(!contract.rows[0]?.user_id) throw new ApiError(409,"El comprobante o la cuenta pendiente no están disponibles.");
    await client.query("UPDATE promotion_vouchers SET status='verified',reviewed_at=now() WHERE promotion_contract_id=$1 AND status='submitted'",[id]);
    await client.query("UPDATE promotion_contracts SET lifecycle_status='payment_verified',subscription_started_at=COALESCE(subscription_started_at,now()),renewal_at=COALESCE(renewal_at,now() + CASE billing_period WHEN 'monthly' THEN interval '1 month' WHEN 'quarterly' THEN interval '3 months' WHEN 'semiannual' THEN interval '6 months' ELSE interval '1 year' END) WHERE id=$1",[id]);
    return getAdminSubscriber(id);
  });
}
export async function setSubscriberOnline(id:string,online:boolean) {
  return transaction(async client => {
    const result=await client.query<{user_id:string|null}>("SELECT user_id FROM promotion_contracts WHERE id=$1 AND lifecycle_status='payment_verified' FOR UPDATE",[id]);
    if(!result.rows[0]?.user_id) throw new ApiError(409,"Esta cuenta aún no está lista para ponerse en línea.");
    await client.query("UPDATE users SET account_status=$2,is_online=$3 WHERE id=$1",[result.rows[0].user_id,online ? "active" : "pending_review",online]);
    if(online) await client.query("UPDATE promotion_contracts SET lifecycle_status='active' WHERE id=$1",[id]);
    return getAdminSubscriber(id);
  });
}
export async function deleteAdminSubscribers(ids:string[], confirmationIds?:number[]) {
  const targets = await query<{id:string; record_number:number; platform_role:string|null}>(
    `SELECT contract.id, COALESCE(user_record.user_number, contract.admin_reference) AS record_number, user_record.platform_role
       FROM promotion_contracts contract
       LEFT JOIN users user_record ON user_record.id=contract.user_id
      WHERE contract.id = ANY($1::uuid[])`,
    [ids],
  );
  if (targets.rows.length !== ids.length) throw new ApiError(404,"No encontramos uno o más registros.");
  if (targets.rows.some(record => record.platform_role === "master_admin")) throw new ApiError(403,"La cuenta administradora maestra no puede eliminarse.");
  if (confirmationIds) {
    const expected = targets.rows.map(record => record.record_number).sort((a,b) => a-b);
    const provided = [...new Set(confirmationIds)].sort((a,b) => a-b);
    if (provided.length !== expected.length || provided.some((value,index) => value !== expected[index])) {
      throw new ApiError(400,"Los IDs de confirmación no corresponden exactamente a los registros seleccionados.");
    }
  }
  const records = await query<{user_id:string|null; storage_key:string|null}>(
    `SELECT contract.user_id, voucher.storage_key
       FROM promotion_contracts contract
       LEFT JOIN promotion_vouchers voucher ON voucher.promotion_contract_id=contract.id
      WHERE contract.id = ANY($1::uuid[])`, [ids],
  );
  if (records.rows.length !== ids.length) throw new ApiError(404,"No encontramos uno o más registros.");
  await deletePromotionVoucherObjects(records.rows.flatMap(record => record.storage_key ? [record.storage_key] : []));
  return transaction(async client => {
    const contracts=await client.query<{id:string;user_id:string|null;platform_role:string|null}>("SELECT contract.id,contract.user_id,user_record.platform_role FROM promotion_contracts contract LEFT JOIN users user_record ON user_record.id=contract.user_id WHERE contract.id = ANY($1::uuid[]) FOR UPDATE",[ids]);
    if(contracts.rows.length !== ids.length) throw new ApiError(404,"No encontramos uno o más registros.");
    if(contracts.rows.some(record=>record.platform_role === "master_admin")) throw new ApiError(403,"La cuenta administradora maestra no puede eliminarse.");
    const userIds=[...new Set(contracts.rows.flatMap(record=>record.user_id?[record.user_id]:[]))];
    await client.query("DELETE FROM promotion_vouchers WHERE promotion_contract_id = ANY($1::uuid[])",[ids]);
    await client.query("DELETE FROM promotion_contracts WHERE id = ANY($1::uuid[])",[ids]);
    if(userIds.length) await client.query("DELETE FROM users WHERE id = ANY($1::uuid[]) AND platform_role <> 'master_admin'",[userIds]);
    return { deleted:true, deletedContracts:ids.length, deletedUsers:userIds.length };
  });
}

export async function deleteUnlinkedPromotionTestData() {
  const records = await query<{id:string; storage_key:string|null}>(
    `SELECT contract.id, voucher.storage_key
       FROM promotion_contracts contract
       LEFT JOIN promotion_vouchers voucher ON voucher.promotion_contract_id=contract.id
      WHERE contract.user_id IS NULL`,
  );
  const ids = [...new Set(records.rows.map(record => record.id))];
  await deletePromotionVoucherObjects(records.rows.flatMap(record => record.storage_key ? [record.storage_key] : []));
  return transaction(async client => {
    if (ids.length) {
      await client.query("DELETE FROM promotion_contracts WHERE id = ANY($1::uuid[])", [ids]);
    }
    return { deletedContracts: ids.length, deletedVouchers: records.rows.filter(record => record.storage_key).length };
  });
}

export async function listRecentAdminSubscribers() {
  // The latest pending registration is the reference point, rather than the
  // current time. This keeps the last one-hour cohort visible until a newer
  // registration arrives, as requested for the dashboard projection.
  const newSubscriber = "(contract.lifecycle_status='voucher_submitted' OR contract.user_id IS NULL)";
  const result = await query<SubscriberRow>(`${base}
    WHERE ${newSubscriber}
      AND contract.created_at >= (
        SELECT max(recent_contract.created_at) - interval '1 hour'
        FROM promotion_contracts recent_contract
        WHERE recent_contract.lifecycle_status='voucher_submitted' OR recent_contract.user_id IS NULL
      )
    ORDER BY contract.created_at DESC`);
  return { subscribers: result.rows.map(serialize) };
}
