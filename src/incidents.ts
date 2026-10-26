import { z } from "zod";
import { ApiError } from "./contracting.js";
import { query } from "./db.js";

const name = z.string().trim().min(3).max(160);
export const incidentCreateInput = z.object({ name });
export const incidentUpdateInput = z.object({ id:z.string().uuid(), name: name.optional(), isActive:z.boolean().optional() });
export const incidentDeleteInput = z.object({ ids:z.array(z.string().uuid()).min(1).max(100) });
type Row={id:string;code:string;name:string;is_active:boolean;created_at:Date};
const serialize=(row:Row)=>({id:row.id,code:row.code,name:row.name,isActive:row.is_active,createdAt:row.created_at.toISOString()});
export async function listIncidents(activeOnly=false){const result=await query<Row>(`SELECT id,code,name,is_active,created_at FROM subscriber_incidents ${activeOnly?"WHERE is_active=true":""} ORDER BY code`);return {incidents:result.rows.map(serialize)};}
export async function createIncident(input:z.infer<typeof incidentCreateInput>){const next=await query<{n:number}>("SELECT count(*)::int AS n FROM subscriber_incidents");const code=`INC-${String((next.rows[0]?.n??0)+1).padStart(3,"0")}`;const result=await query<Row>("INSERT INTO subscriber_incidents(code,name) VALUES($1,$2) RETURNING id,code,name,is_active,created_at",[code,input.name]);return {incident:serialize(result.rows[0])};}
export async function updateIncident(input:z.infer<typeof incidentUpdateInput>){const result=await query<Row>("UPDATE subscriber_incidents SET name=COALESCE($2,name),is_active=COALESCE($3,is_active),updated_at=now() WHERE id=$1 RETURNING id,code,name,is_active,created_at",[input.id,input.name??null,input.isActive??null]);if(!result.rows[0])throw new ApiError(404,"No encontramos esta incidencia.");return {incident:serialize(result.rows[0])};}
export async function deleteIncidents(ids:string[]){await query("DELETE FROM subscriber_incidents WHERE id=ANY($1::uuid[])",[ids]);return {deleted:ids.length};}
