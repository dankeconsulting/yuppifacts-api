import { z } from "zod";
import { ApiError } from "./contracting.js";
import { query } from "./db.js";

const color = z.enum(["azul","verde","amarillo","rojo","gris"]);
export const statusLabelCreateInput = z.object({ name:z.string().trim().min(2).max(120), type:z.enum(["estatus","etiqueta"]), category:z.string().trim().min(2).max(80).default("general"), color, description:z.string().trim().max(500).optional(), eventKey:z.string().trim().max(100).optional(), isActive:z.boolean().optional() });
export const statusLabelUpdateInput = statusLabelCreateInput.partial().extend({ id:z.string().uuid() });
export const statusLabelDeleteInput = z.object({ ids:z.array(z.string().uuid()).min(1).max(50) });
type Row={id:string;name:string;type:"estatus"|"etiqueta";category:string;color:"azul"|"verde"|"amarillo"|"rojo"|"gris";description:string|null;event_key:string|null;is_active:boolean};
const present=(row:Row)=>({id:row.id,name:row.name,type:row.type,category:row.category,color:row.color,description:row.description??"",eventKey:row.event_key,isActive:row.is_active});
export async function listStatusLabels(){const result=await query<Row>("SELECT id,name,type,category,color,description,event_key,is_active FROM status_labels ORDER BY name");return {labels:result.rows.map(present)};}
export async function createStatusLabel(input:z.infer<typeof statusLabelCreateInput>){const result=await query<Row>("INSERT INTO status_labels(name,type,category,color,description,event_key,is_active) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,type,category,color,description,event_key,is_active",[input.name,input.type,input.category,input.color,input.description||null,input.eventKey||null,input.isActive??true]);return {label:present(result.rows[0])};}
export async function updateStatusLabel(input:z.infer<typeof statusLabelUpdateInput>){const result=await query<Row>("UPDATE status_labels SET name=COALESCE($2,name),type=COALESCE($3,type),category=COALESCE($4,category),color=COALESCE($5,color),description=COALESCE($6,description),event_key=COALESCE($7,event_key),is_active=COALESCE($8,is_active),updated_at=now() WHERE id=$1 RETURNING id,name,type,category,color,description,event_key,is_active",[input.id,input.name??null,input.type??null,input.category??null,input.color??null,input.description??null,input.eventKey??null,input.isActive??null]);if(!result.rows[0])throw new ApiError(404,"No encontramos esta etiqueta.");return {label:present(result.rows[0])};}
export async function deleteStatusLabels(ids:string[]){await query("DELETE FROM status_labels WHERE id=ANY($1::uuid[])",[ids]);return {deleted:ids.length};}
