import type { PoolClient } from "pg";
import { query } from "./db.js";

export async function logSubscriberActivity(client: PoolClient, input: { contractId: string; action: string; title: string; detail?: string; incidentId?: string; actorUserId?: string }) {
  await client.query(
    "INSERT INTO subscriber_activity_log (promotion_contract_id,actor_user_id,action,title,detail,incident_id) VALUES($1,$2,$3,$4,$5,$6)",
    [input.contractId, input.actorUserId ?? null, input.action, input.title, input.detail ?? null, input.incidentId ?? null],
  );
}

export async function listSubscriberActivity(contractId: string) {
  const result = await query<{id:string;action:string;title:string;detail:string|null;incident_code:string|null;incident_name:string|null;actor_name:string|null;created_at:Date}>(
    `SELECT log.id,log.action,log.title,log.detail,incident.code AS incident_code,incident.name AS incident_name,actor.full_name AS actor_name,log.created_at
       FROM subscriber_activity_log log
       LEFT JOIN subscriber_incidents incident ON incident.id=log.incident_id
       LEFT JOIN users actor ON actor.id=log.actor_user_id
      WHERE log.promotion_contract_id=$1
      ORDER BY log.created_at DESC`,
    [contractId],
  );
  return { activities: result.rows.map(row=>({ id:row.id,action:row.action,title:row.title,detail:row.detail,incident:row.incident_code?{code:row.incident_code,name:row.incident_name}:null,actorName:row.actor_name,createdAt:row.created_at.toISOString() })) };
}
