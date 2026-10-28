import { z } from "zod";
import { ApiError } from "./contracting.js";
import { query } from "./db.js";
export const cfdiUseCreateInput=z.object({code:z.string().trim().min(2).max(12).transform(value=>value.toUpperCase()),name:z.string().trim().min(2).max(160),description:z.string().trim().max(500).optional(),isActive:z.boolean().optional()});
export const cfdiUseUpdateInput=cfdiUseCreateInput.partial().extend({id:z.string().uuid()});
export const cfdiUseDeleteInput=z.object({ids:z.array(z.string().uuid()).min(1).max(50)});
type Row={id:string;code:string;name:string;description:string|null;is_active:boolean};const present=(row:Row)=>({id:row.id,code:row.code,name:row.name,description:row.description??"",isActive:row.is_active});
export async function listCfdiUses(activeOnly=false){const result=await query<Row>(`SELECT id,code,name,description,is_active FROM cfdi_uses ${activeOnly?"WHERE is_active=true":""} ORDER BY code`);return {uses:result.rows.map(present)};}
export async function createCfdiUse(input:z.infer<typeof cfdiUseCreateInput>){const result=await query<Row>("INSERT INTO cfdi_uses(code,name,description,is_active) VALUES($1,$2,$3,$4) RETURNING id,code,name,description,is_active",[input.code,input.name,input.description||null,input.isActive??true]);return {use:present(result.rows[0])};}
export async function updateCfdiUse(input:z.infer<typeof cfdiUseUpdateInput>){const result=await query<Row>("UPDATE cfdi_uses SET code=COALESCE($2,code),name=COALESCE($3,name),description=COALESCE($4,description),is_active=COALESCE($5,is_active),updated_at=now() WHERE id=$1 RETURNING id,code,name,description,is_active",[input.id,input.code??null,input.name??null,input.description??null,input.isActive??null]);if(!result.rows[0])throw new ApiError(404,"No encontramos este uso de CFDI.");return {use:present(result.rows[0])};}
export async function deleteCfdiUses(ids:string[]){await query("DELETE FROM cfdi_uses WHERE id=ANY($1::uuid[])",[ids]);return {deleted:ids.length};}
