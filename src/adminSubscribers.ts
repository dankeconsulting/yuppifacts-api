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
  const profileKey=row.mode ?? row.plan_id;
  return { id:row.id, userId:row.user_id, userNumber:row.user_number, recordNumber:row.user_number ?? row.admin_reference, isTemporary, role:isTemporary ? "Registro temporal" : row.platform_role === "master_admin" ? "Administrador maestro" : "Suscriptor", fullName:row.full_name, email:row.email, phone:row.phone_e164, countryCode:row.country_code ?? "MX", state:row.state_name, city:row.city_name, profile:profileLabel(row.mode,row.plan_id), profileKey, planId:row.plan_id, billingPeriod:row.billing_period, quotedAmountCents:row.quoted_amount_cents, subscriptionTag:row.subscription_tag, registeredAt:row.created_at.toISOString(), renewalAt:row.renewal_at?.toISOString() ?? null, voucher:{ id:row.voucher_id, filename:row.voucher_filename, storageKey:row.voucher_key }, lifecycleStatus:row.lifecycle_status, accountStatus:row.account_status, online:Boolean(row.is_online) };
}
const base = `SELECT contract.id,contract.admin_reference,contract.full_name,contract.email,contract.phone_e164,contract.country_code,contract.state_name,contract.city_name,contract.plan_id,contract.billing_period,contract.quoted_amount_cents,contract.lifecycle_status,contract.subscription_tag,contract.created_at,contract.renewal_at,contract.user_id,user_record.user_number,user_record.platform_role,user_record.account_status,user_record.is_online,contract.plan_snapshot->>'mode' AS mode,voucher.id AS voucher_id,voucher.original_filename AS voucher_filename,voucher.storage_key AS voucher_key FROM promotion_contracts contract LEFT JOIN users user_record ON user_record.id=contract.user_id LEFT JOIN LATERAL (SELECT id,original_filename,storage_key FROM promotion_vouchers WHERE promotion_contract_id=contract.id ORDER BY submitted_at DESC NULLS LAST LIMIT 1) voucher ON true`;

export async function listAdminSubscribers(stage:z.infer<typeof subscriberStageInput>["stage"]) {
  // Legacy contracts created before the temporary-account flow have no user or
  // PIN. They intentionally stay visible in "Usuarios nuevos" so a master
  // administrator can review and remove them through the protected flow.
  const where = stage === "new" ? "(contract.lifecycle_status='voucher_submitted' OR contract.user_id IS NULL)" : stage === "review" ? "contract.lifecycle_status='payment_verified'" : "contract.lifecycle_status IN ('approved','active') AND user_record.account_status='active'";
  const result = await query<SubscriberRow>(`${base} WHERE ${where} ORDER BY contract.created_at ASC`);
  return { subscribers: result.rows.map(serialize) };
}
export async function getAdminSubscriber(id:string) {
  const result = await query<SubscriberRow>(`${base} WHERE contract.id=$1`,[id]);
  if(!result.rows[0]) throw new ApiError(404,"No encontramos este suscriptor.");
  return { subscriber:serialize(result.rows[0]) };
}

type OperationContractRow={id:string;user_id:string|null;full_name:string;email:string;phone_e164:string;mode:string|null;plan_snapshot:{seats?:unknown}|null};
type MembershipRow={id:string;full_name:string|null;email:string;phone_e164:string|null;role:string;avatar_object_key:string|null};

function approvedSeatCount(seats:unknown,mode:string|null) {
  const text=typeof seats==="string"?seats:"";
  const matches=[...text.matchAll(/(\d+)\s+asientos?/gi)].map(match=>Number(match[1]));
  if(!matches.length) return mode==="individual"?1:1;
  if(/por\s+sucursal/i.test(text)&&/sucursales?/i.test(text)) return matches.reduce((total,value)=>total*value,1);
  return Math.max(...matches);
}

export async function getAdminSubscriberOperations(id:string) {
  const contractResult=await query<OperationContractRow>(
    `SELECT id,user_id,full_name,email,phone_e164,plan_snapshot->>'mode' AS mode,plan_snapshot
       FROM promotion_contracts WHERE id=$1`,
    [id],
  );
  const contract=contractResult.rows[0];
  if(!contract) throw new ApiError(404,"No encontramos este suscriptor.");
  const seatLimit=approvedSeatCount(contract.plan_snapshot?.seats,contract.mode);
  const organizationResult=contract.user_id ? await query<{id:string;name:string;kind:string}>(
    `SELECT organization.id,organization.name,organization.kind
       FROM organizations organization
       JOIN organization_memberships membership ON membership.organization_id=organization.id
      WHERE membership.user_id=$1
      ORDER BY membership.created_at ASC
      LIMIT 1`,
    [contract.user_id],
  ) : {rows:[]};
  const organization=organizationResult.rows[0]??null;
  const memberResult=organization ? await query<MembershipRow>(
    `SELECT user_record.id,user_record.full_name,user_record.email,user_record.phone_e164,membership.role,user_record.avatar_object_key
       FROM organization_memberships membership
       JOIN users user_record ON user_record.id=membership.user_id
      WHERE membership.organization_id=$1
      ORDER BY CASE membership.role WHEN 'owner' THEN 0 ELSE 1 END,user_record.created_at ASC`,
    [organization.id],
  ) : {rows:contract.user_id ? [{id:contract.user_id,full_name:contract.full_name,email:contract.email,phone_e164:contract.phone_e164,role:"owner",avatar_object_key:null}] : []};
  const members=memberResult.rows;
  const occupiedSeats=members.length;
  const seats=Array.from({length:Math.max(seatLimit,occupiedSeats)},(_,index)=>{
    const member=members[index];
    return member ? {number:index+1,status:"assigned" as const,userId:member.id,name:member.full_name??"Usuario sin nombre",email:member.email,phone:member.phone_e164,role:member.role,hasAvatar:Boolean(member.avatar_object_key)} : {number:index+1,status:"available" as const,userId:null,name:null,email:null,phone:null,role:null,hasAvatar:false};
  });
  const contributorRows=organization ? await query<{id:string;name:string;rfc:string;tickets:number;requests:number;received:number;pending:number;failed:number}>(
    `SELECT fiscal.id,fiscal.legal_name AS name,fiscal.rfc,
       0::integer AS tickets,
       count(request.id)::integer AS requests,
       count(request.id) FILTER (WHERE request.status='received')::integer AS received,
       count(request.id) FILTER (WHERE request.status IN ('draft','ready_for_review','submitted'))::integer AS pending,
       count(request.id) FILTER (WHERE request.status='failed')::integer AS failed
       FROM fiscal_profiles fiscal
       LEFT JOIN invoice_requests request ON request.fiscal_profile_id=fiscal.id
      WHERE fiscal.organization_id=$1
      GROUP BY fiscal.id,fiscal.legal_name,fiscal.rfc
      ORDER BY fiscal.created_at ASC`,
    [organization.id],
  ) : {rows:[]};
  const totals=organization ? await query<{tickets:number;requests:number;received:number;pending:number;failed:number;documents:number}>(
    `SELECT 0::integer AS tickets,
       (SELECT count(*)::integer FROM invoice_requests WHERE organization_id=$1) AS requests,
       (SELECT count(*)::integer FROM invoice_requests WHERE organization_id=$1 AND status='received') AS received,
       (SELECT count(*)::integer FROM invoice_requests WHERE organization_id=$1 AND status IN ('draft','ready_for_review','submitted')) AS pending,
       (SELECT count(*)::integer FROM invoice_requests WHERE organization_id=$1 AND status='failed') AS failed,
       (SELECT count(*)::integer FROM documents WHERE organization_id=$1) AS documents`,
    [organization.id],
  ) : {rows:[{tickets:0,requests:0,received:0,pending:0,failed:0,documents:0}]};
  return { organization, planSeats:typeof contract.plan_snapshot?.seats==="string"?contract.plan_snapshot.seats:`${seatLimit} asiento${seatLimit===1?"":"s"}`, approvedSeats:seatLimit, occupiedSeats, availableSeats:Math.max(0,seatLimit-occupiedSeats), seats, contributors:contributorRows.rows, totals:totals.rows[0] };
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
  // Do not read the subscriber through the pool while this transaction holds a
  // FOR UPDATE lock. That second connection waits for this transaction to
  // commit, making the validation appear to freeze in the administrator UI.
  const transitioned = await transaction(async client => {
    const contract=await client.query<{user_id:string|null;lifecycle_status:string}>("SELECT user_id,lifecycle_status FROM promotion_contracts WHERE id=$1 FOR UPDATE",[id]);
    if(!contract.rows[0]?.user_id) throw new ApiError(409,"El comprobante o la cuenta pendiente no están disponibles.");
    // A repeated tap after a successful validation is harmless: return the
    // current subscriber instead of reporting a false failure.
    if(contract.rows[0].lifecycle_status==="payment_verified") return false;
    if(contract.rows[0].lifecycle_status!=="voucher_submitted") throw new ApiError(409,"El comprobante o la cuenta pendiente no están disponibles.");
    await client.query("UPDATE promotion_vouchers SET status='verified',reviewed_at=now() WHERE promotion_contract_id=$1 AND status='submitted'",[id]);
    await client.query("UPDATE promotion_contracts SET lifecycle_status='payment_verified' WHERE id=$1",[id]);
    await logSubscriberActivity(client,{contractId:id,actorUserId,action:"payment_verified",title:"Pago validado",detail:"El comprobante fue validado y la cuenta pasó a Usuarios en revisión."});
    return true;
  });
  const subscriber=await getAdminSubscriber(id);
  if(transitioned){
    const emailId = await queuePromotionEmail({ promotionId:id, recipient:subscriber.subscriber.email, template:"payment_verified", payload:{ fullName:subscriber.subscriber.fullName } });
    if (emailId) void deliverPromotionEmail(emailId);
  }
  return subscriber;
}
export async function approveSubscriber(id:string, actorUserId?:string) {
  await transaction(async client => {
    const result=await client.query<{user_id:string|null;lifecycle_status:string}>("SELECT user_id,lifecycle_status FROM promotion_contracts WHERE id=$1 FOR UPDATE",[id]);
    const contract=result.rows[0];
    if(!contract?.user_id) throw new ApiError(404,"No encontramos la cuenta que deseas activar.");
    // The action is idempotent: a repeated click after a successful activation
    // must return the current record rather than reporting a stale review error.
    if(contract.lifecycle_status==="approved"||contract.lifecycle_status==="active") return false;
    if(contract.lifecycle_status!=="payment_verified") throw new ApiError(409,"Esta cuenta debe estar en revisión antes de activarla.");
    await client.query("UPDATE users SET account_status='active',is_online=false WHERE id=$1",[contract.user_id]);
    await client.query("UPDATE promotion_contracts SET lifecycle_status='approved' WHERE id=$1",[id]);
    await logSubscriberActivity(client,{contractId:id,actorUserId,action:"account_approved",title:"Cuenta activada",detail:"La cuenta pasó a Usuarios y permanece fuera de línea."});
    return true;
  });
  // Read only after the transaction commits. Reading from another pooled
  // connection inside the transaction caused the activation to wait/retry.
  return getAdminSubscriber(id);
}
export async function setSubscriberOnline(id:string,online:boolean, options:{incidentId?:string;detail?:string;actorUserId?:string}={}) {
  await transaction(async client => {
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
  });
  // Do not query through a second connection until the locked transition has
  // committed. This keeps the action responsive on its first click.
  const subscriber = await getAdminSubscriber(id);
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
    await client.query("DELETE FROM subscriber_activity_log WHERE promotion_contract_id = ANY($1::uuid[])",[ids]);
    await client.query("DELETE FROM promotion_vouchers WHERE promotion_contract_id = ANY($1::uuid[])",[ids]);
    await client.query("DELETE FROM promotion_contracts WHERE id = ANY($1::uuid[])",[ids]);
    if(organizationIds.length) await client.query("DELETE FROM organizations WHERE id = ANY($1::uuid[])",[organizationIds]);
    if(userIds.length) await client.query("DELETE FROM contracting_sessions WHERE user_id = ANY($1::uuid[])",[userIds]);
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
  const result = await query<SubscriberRow>(`${base} WHERE ${newSubscriber} ORDER BY contract.created_at ASC`);
  return { subscribers: result.rows.map(serialize) };
}
