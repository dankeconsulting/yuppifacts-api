import { z } from "zod";
import { ApiError } from "./contracting.js";
import { query, transaction } from "./db.js";
import { createPromotionVoucherViewUrl, deletePrivateObjects, deletePromotionVoucherObjects, PromotionVoucherDeletionError } from "./storage.js";
import { deliverPromotionEmail, queuePromotionEmail } from "./promotionNotifications.js";
import { logSubscriberActivity } from "./subscriberActivity.js";
import { verifySecret } from "./security.js";

export const subscriberStageInput = z.object({ stage: z.enum(["new", "review", "active"]) });
export const subscriberIdInput = z.object({ id: z.string().uuid() });
export const onlineInput = subscriberIdInput.extend({ online: z.boolean(), incidentId:z.string().uuid().optional(), detail:z.string().trim().max(800).optional() });
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
  return { id:row.id, userId:row.user_id, userNumber:row.user_number, recordNumber:row.user_number ?? row.admin_reference, isTemporary, role:isTemporary ? "Registro temporal" : row.platform_role === "master_admin" ? "Administrador maestro" : "Suscriptor", fullName:row.full_name, email:row.email, phone:row.phone_e164, countryCode:row.country_code ?? "MX", state:row.state_name, city:row.city_name, profile:profileLabel(row.mode,row.plan_id), planId:row.plan_id, billingPeriod:row.billing_period, quotedAmountCents:row.quoted_amount_cents, subscriptionTag:row.subscription_tag, registeredAt:row.created_at.toISOString(), renewalAt:row.renewal_at?.toISOString() ?? null, voucher:{ id:row.voucher_id, filename:row.voucher_filename, storageKey:row.voucher_key }, lifecycleStatus:row.lifecycle_status, accountStatus:row.account_status, online:Boolean(row.is_online) };
}
const base = `SELECT contract.id,contract.admin_reference,contract.full_name,contract.email,contract.phone_e164,contract.country_code,contract.state_name,contract.city_name,contract.plan_id,contract.billing_period,contract.quoted_amount_cents,contract.lifecycle_status,contract.subscription_tag,contract.created_at,contract.renewal_at,contract.user_id,user_record.user_number,user_record.platform_role,user_record.account_status,user_record.is_online,contract.plan_snapshot->>'mode' AS mode,voucher.id AS voucher_id,voucher.original_filename AS voucher_filename,voucher.storage_key AS voucher_key FROM promotion_contracts contract LEFT JOIN users user_record ON user_record.id=contract.user_id LEFT JOIN LATERAL (SELECT id,original_filename,storage_key FROM promotion_vouchers WHERE promotion_contract_id=contract.id ORDER BY submitted_at DESC NULLS LAST LIMIT 1) voucher ON true`;

export async function listAdminSubscribers(stage:z.infer<typeof subscriberStageInput>["stage"]) {
  // Legacy contracts created before the temporary-account flow have no user or
  // PIN. They intentionally stay visible in "Usuarios nuevos" so a master
  // administrator can review and remove them through the protected flow.
  const where = stage === "new" ? "(contract.lifecycle_status='voucher_submitted' OR contract.user_id IS NULL)" : stage === "review" ? "contract.lifecycle_status='payment_verified'" : "contract.lifecycle_status IN ('approved','active') AND user_record.account_status='active'";
  const result = await query<SubscriberRow>(`${base} WHERE ${where} ORDER BY contract.created_at DESC`);
  return { subscribers: result.rows.map(serialize) };
}
export async function getAdminSubscriber(id:string) {
  const result = await query<SubscriberRow>(`${base} WHERE contract.id=$1`,[id]);
  if(!result.rows[0]) throw new ApiError(404,"No encontramos este suscriptor.");
  return { subscriber:serialize(result.rows[0]) };
}
export async function verifyAdminSubscriberPin(id:string,pin:string) {
  const result=await query<{pin_hash:string|null}>("SELECT pin_hash FROM promotion_contracts WHERE id=$1",[id]);
  const pinHash=result.rows[0]?.pin_hash;
  if(!pinHash) throw new ApiError(409,"Este suscriptor aún no tiene un PIN disponible para validar.");
  return { valid:await verifySecret(pin,pinHash) };
}
export async function getAdminSubscriberVoucherUrl(id:string) {
  const result=await query<{storage_key:string|null}>(
    `SELECT voucher.storage_key
       FROM promotion_contracts contract
       LEFT JOIN LATERAL (
         SELECT storage_key FROM promotion_vouchers
          WHERE promotion_contract_id=contract.id AND status IN ('submitted','verified')
          ORDER BY submitted_at DESC NULLS LAST LIMIT 1
       ) voucher ON true
      WHERE contract.id=$1`,
    [id],
  );
  const key=result.rows[0]?.storage_key;
  if(!key) throw new ApiError(404,"Este suscriptor no tiene un comprobante disponible.");
  return { url:await createPromotionVoucherViewUrl(key),expiresIn:300 };
}
export async function moveSubscriberToReview(id:string, actorUserId?:string) {
  const subscriber = await transaction(async client => {
    const contract=await client.query<{user_id:string|null}>("SELECT user_id FROM promotion_contracts WHERE id=$1 AND lifecycle_status='voucher_submitted' FOR UPDATE",[id]);
    if(!contract.rows[0]?.user_id) throw new ApiError(409,"El comprobante o la cuenta pendiente no están disponibles.");
    await client.query("UPDATE promotion_vouchers SET status='verified',reviewed_at=now() WHERE promotion_contract_id=$1 AND status='submitted'",[id]);
    await client.query("UPDATE promotion_contracts SET lifecycle_status='payment_verified' WHERE id=$1",[id]);
    await logSubscriberActivity(client,{contractId:id,actorUserId,action:"payment_verified",title:"Pago validado",detail:"El comprobante fue validado y la cuenta pasó a Usuarios en revisión."});
    return getAdminSubscriber(id);
  });
  const emailId = await queuePromotionEmail({ promotionId:id, recipient:subscriber.subscriber.email, template:"payment_verified", payload:{ fullName:subscriber.subscriber.fullName } });
  if (emailId) void deliverPromotionEmail(emailId);
  return subscriber;
}
export async function approveSubscriber(id:string, actorUserId?:string) {
  return transaction(async client => {
    const result=await client.query<{user_id:string|null}>("SELECT user_id FROM promotion_contracts WHERE id=$1 AND lifecycle_status='payment_verified' FOR UPDATE",[id]);
    if(!result.rows[0]?.user_id) throw new ApiError(409,"Esta cuenta debe estar en revisión antes de activarla.");
    await client.query("UPDATE users SET account_status='active',is_online=false WHERE id=$1",[result.rows[0].user_id]);
    await client.query("UPDATE promotion_contracts SET lifecycle_status='approved' WHERE id=$1",[id]);
    await logSubscriberActivity(client,{contractId:id,actorUserId,action:"account_approved",title:"Cuenta activada",detail:"La cuenta pasó a Usuarios y permanece fuera de línea."});
    return getAdminSubscriber(id);
  });
}
export async function setSubscriberOnline(id:string,online:boolean, options:{incidentId?:string;detail?:string;actorUserId?:string}={}) {
  const subscriber = await transaction(async client => {
    const result=await client.query<{user_id:string|null}>("SELECT user_id FROM promotion_contracts WHERE id=$1 AND lifecycle_status IN ('approved','active') FOR UPDATE",[id]);
    if(!result.rows[0]?.user_id) throw new ApiError(409,"Esta cuenta aún no está lista para ponerse en línea.");
    if(!online){
      if(!options.incidentId) throw new ApiError(400,"Selecciona una incidencia para poner la cuenta fuera de línea.");
      const incident=await client.query("SELECT id FROM subscriber_incidents WHERE id=$1 AND is_active=true",[options.incidentId]);
      if(!incident.rows[0]) throw new ApiError(400,"La incidencia seleccionada ya no está disponible.");
    }
    await client.query("UPDATE users SET account_status=$2,is_online=$3 WHERE id=$1",[result.rows[0].user_id,online ? "active" : "pending_review",online]);
    await client.query(online ? "UPDATE promotion_contracts SET lifecycle_status='active',subscription_started_at=COALESCE(subscription_started_at,now()),renewal_at=COALESCE(renewal_at,now() + CASE billing_period WHEN 'monthly' THEN interval '1 month' WHEN 'quarterly' THEN interval '3 months' WHEN 'semiannual' THEN interval '6 months' ELSE interval '1 year' END) WHERE id=$1" : "UPDATE promotion_contracts SET lifecycle_status='approved' WHERE id=$1",[id]);
    await logSubscriberActivity(client,{contractId:id,actorUserId:options.actorUserId,incidentId:options.incidentId,action:online?"account_online":"account_offline",title:online?"Cuenta puesta en línea":"Cuenta puesta fuera de línea",detail:online?"Se habilitó el acceso operativo e inició la vigencia de la membresía.":options.detail||"El acceso operativo fue puesto fuera de línea."});
    return getAdminSubscriber(id);
  });
  if (online) {
    const emailId = await queuePromotionEmail({ promotionId:id, recipient:subscriber.subscriber.email, template:"panel_access", payload:{ fullName:subscriber.subscriber.fullName } });
    if (emailId) void deliverPromotionEmail(emailId);
  }
  return subscriber;
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
    const expected = targets.rows.map(record => Number(record.record_number)).sort((a,b) => a-b);
    const provided = [...new Set(confirmationIds)].sort((a,b) => a-b);
    if (provided.length !== expected.length || provided.some((value,index) => value !== expected[index])) {
      throw new ApiError(400,"Los IDs de confirmación no corresponden exactamente a los registros seleccionados.");
    }
  }
  const records = await query<{contract_id:string; user_id:string|null; storage_key:string|null; avatar_object_key:string|null}>(
    `SELECT contract.id AS contract_id, contract.user_id, voucher.storage_key, user_record.avatar_object_key
       FROM promotion_contracts contract
       LEFT JOIN users user_record ON user_record.id=contract.user_id
       LEFT JOIN promotion_vouchers voucher ON voucher.promotion_contract_id=contract.id
      WHERE contract.id = ANY($1::uuid[])`, [ids],
  );
  if (new Set(records.rows.map(record => record.contract_id)).size !== ids.length) throw new ApiError(404,"No encontramos uno o más registros.");
  const userIds=[...new Set(records.rows.flatMap(record=>record.user_id?[record.user_id]:[]))];
  const exclusiveOrganizations = userIds.length ? await query<{id:string}>(
    `SELECT membership.organization_id AS id
       FROM organization_memberships membership
      WHERE membership.user_id = ANY($1::uuid[])
        AND NOT EXISTS (
          SELECT 1 FROM organization_memberships other_member
           WHERE other_member.organization_id = membership.organization_id
             AND other_member.user_id <> membership.user_id
        )`,
    [userIds],
  ) : { rows: [] };
  const organizationIds=exclusiveOrganizations.rows.map(organization=>organization.id);
  const organizationAssets=organizationIds.length ? await query<{storage_key:string|null}>(
    `SELECT storage_key FROM documents WHERE organization_id = ANY($1::uuid[])
     UNION ALL
     SELECT source_key AS storage_key FROM invoice_requests WHERE organization_id = ANY($1::uuid[]) AND source_key IS NOT NULL`,
    [organizationIds],
  ) : { rows: [] };
  const storageKeys=[...new Set([
    ...records.rows.flatMap(record=>[record.storage_key,record.avatar_object_key].filter((key):key is string=>Boolean(key))),
    ...organizationAssets.rows.flatMap(record=>record.storage_key?[record.storage_key]:[]),
  ])];
  try {
    await deletePrivateObjects(storageKeys);
  } catch (error) {
    if (error instanceof PromotionVoucherDeletionError) {
      throw new ApiError(502,"No se eliminó ningún registro: el almacenamiento de comprobantes rechazó la operación. Revisa los permisos de eliminación de vouchers.","VOUCHER_STORAGE_DELETE_FAILED");
    }
    throw error;
  }
  return transaction(async client => {
    const contracts=await client.query<{id:string;user_id:string|null;platform_role:string|null}>("SELECT contract.id,contract.user_id,user_record.platform_role FROM promotion_contracts contract LEFT JOIN users user_record ON user_record.id=contract.user_id WHERE contract.id = ANY($1::uuid[]) FOR UPDATE OF contract",[ids]);
    if(contracts.rows.length !== ids.length) throw new ApiError(404,"No encontramos uno o más registros.");
    if(contracts.rows.some(record=>record.platform_role === "master_admin")) throw new ApiError(403,"La cuenta administradora maestra no puede eliminarse.");
    await client.query(
      `DELETE FROM promotion_notification_outbox
        WHERE promotion_contract_id = ANY($1::uuid[])
           OR voucher_id IN (SELECT id FROM promotion_vouchers WHERE promotion_contract_id = ANY($1::uuid[]))`,
      [ids],
    );
    await client.query("DELETE FROM promotion_vouchers WHERE promotion_contract_id = ANY($1::uuid[])",[ids]);
    await client.query("DELETE FROM promotion_contracts WHERE id = ANY($1::uuid[])",[ids]);
    if(organizationIds.length) await client.query("DELETE FROM organizations WHERE id = ANY($1::uuid[])",[organizationIds]);
    if(userIds.length) await client.query("DELETE FROM users WHERE id = ANY($1::uuid[]) AND platform_role <> 'master_admin'",[userIds]);
    return { deleted:true, deletedContracts:ids.length, deletedUsers:userIds.length, deletedOrganizations:organizationIds.length, deletedStorageObjects:storageKeys.length };
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
  // This Dashboard block is a projection of the same pending-record table
  // used by "Usuarios nuevos". Keeping one source prevents records from
  // disappearing from the dashboard while they remain pending there.
  const newSubscriber = "(contract.lifecycle_status='voucher_submitted' OR contract.user_id IS NULL)";
  const result = await query<SubscriberRow>(`${base} WHERE ${newSubscriber} ORDER BY contract.created_at DESC`);
  return { subscribers: result.rows.map(serialize) };
}
