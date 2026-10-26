import { z } from "zod";
import { ApiError } from "./contracting.js";
import { query } from "./db.js";

const priority=z.enum(["alta","media","baja"]);
export const incidentCatalogCreateInput=z.object({name:z.string().trim().min(3).max(180),priority,description:z.string().trim().max(800).optional()});
export const incidentCatalogUpdateInput=incidentCatalogCreateInput.partial().extend({id:z.string().uuid(),isActive:z.boolean().optional()});
export const incidentCatalogDeleteInput=z.object({ids:z.array(z.string().uuid()).min(1).max(100)});
type Row={id:string;code:string;name:string;priority:"alta"|"media"|"baja";description:string|null;is_active:boolean;created_at:Date};
const serialize=(row:Row)=>({id:row.id,code:row.code,name:row.name,priority:row.priority,description:row.description??"",isActive:row.is_active,createdAt:row.created_at.toISOString()});
export async function listIncidentCatalog(activeOnly=false){const result=await query<Row>(`SELECT id,code,name,priority,description,is_active,created_at FROM subscriber_incidents ${activeOnly?"WHERE is_active=true":""} ORDER BY code`);return {incidents:result.rows.map(serialize)};}
export async function createIncidentCatalog(input:z.infer<typeof incidentCatalogCreateInput>){const next=await query<{n:number}>("SELECT count(*)::int AS n FROM subscriber_incidents");const code=`INC-${String((next.rows[0]?.n??0)+1).padStart(3,"0")}`;const result=await query<Row>("INSERT INTO subscriber_incidents(code,name,priority,description) VALUES($1,$2,$3,$4) RETURNING id,code,name,priority,description,is_active,created_at",[code,input.name,input.priority,input.description||null]);return {incident:serialize(result.rows[0])};}
export async function updateIncidentCatalog(input:z.infer<typeof incidentCatalogUpdateInput>){const result=await query<Row>("UPDATE subscriber_incidents SET name=COALESCE($2,name),priority=COALESCE($3,priority),description=COALESCE($4,description),is_active=COALESCE($5,is_active),updated_at=now() WHERE id=$1 RETURNING id,code,name,priority,description,is_active,created_at",[input.id,input.name??null,input.priority??null,input.description??null,input.isActive??null]);if(!result.rows[0])throw new ApiError(404,"No encontramos esta incidencia.");return {incident:serialize(result.rows[0])};}
export async function deleteIncidentCatalog(ids:string[]){await query("DELETE FROM subscriber_incidents WHERE id=ANY($1::uuid[])",[ids]);return {deleted:ids.length};}
