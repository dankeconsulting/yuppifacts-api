import { z } from "zod";
import { ApiError } from "./contracting.js";
import { query, transaction } from "./db.js";
import { activeCampaignPlans } from "./promotionCampaigns.js";

const mode=z.enum(["individual","independent_accountant","accounting_firm","company","corporate"]);
const billingPeriods=z.array(z.enum(["monthly","quarterly","semiannual","annual"])).min(1).max(4).refine(items=>new Set(items).size===items.length,"No repitas una periodicidad.");
const planId = z.string().regex(/^[a-z0-9_]{2,80}$/);
const benefit = z.string().trim().min(2).max(2000);

export const promotionPlanInput = z.object({
  mode, billingPeriods, name: z.string().trim().min(2).max(120), seats: z.string().trim().min(1).max(180),
  monthlyAmountCents: z.number().int().positive().nullable(), quarterlyAmountCents: z.number().int().positive().nullable(), semiannualAmountCents:z.number().int().positive().nullable(), annualAmountCents:z.number().int().positive().nullable(), regularMonthlyAmountCents: z.number().int().positive().nullable(),
  benefits: z.array(benefit).min(1).max(50), active: z.boolean(), displayOrder: z.number().int().min(0).max(32000),
});
export const promotionPlanCreateInput = promotionPlanInput.extend({ id: planId });
export const promotionPlanUpdateInput = promotionPlanInput.extend({ id: planId });
export const promotionPlanIdInput=z.object({id:planId});
export const promotionPlanOrderInput=z.object({ids:z.array(planId).min(1).max(100)});

type Row = { id:string; profile:"accountant"|"company"|"corporate"; mode:"individual"|"independent_accountant"|"accounting_firm"|"company"|"corporate"; name:string; seats:string; monthly_amount_cents:number|null; quarterly_amount_cents:number|null; semiannual_amount_cents:number|null; annual_amount_cents:number|null; regular_monthly_amount_cents:number|null; benefits:string[]; active:boolean; display_order:number };

function publicPlan(row:Row) { const billingPeriods=[...(row.monthly_amount_cents?["monthly"]:[]),...(row.quarterly_amount_cents?["quarterly"]:[]),...(row.semiannual_amount_cents?["semiannual"]:[]),...(row.annual_amount_cents?["annual"]:[])];return { id:row.id, profile:row.profile, mode:row.mode, name:row.name, seats:row.seats, monthlyAmountCents:row.monthly_amount_cents, quarterlyAmountCents:row.quarterly_amount_cents, semiannualAmountCents:row.semiannual_amount_cents, annualAmountCents:row.annual_amount_cents, billingPeriods, regularMonthlyAmountCents:row.regular_monthly_amount_cents, benefits:row.benefits, active:row.active, displayOrder:row.display_order }; }

export async function listPublicPromotionPlans() {
  return activeCampaignPlans();
}
export async function listPromotionPlans() {
  const result = await query<Row>("SELECT id,profile,mode,name,seats,monthly_amount_cents,quarterly_amount_cents,semiannual_amount_cents,annual_amount_cents,regular_monthly_amount_cents,benefits,active,display_order FROM promotion_plans ORDER BY display_order,id");
  return result.rows.map(publicPlan);
}
async function save(input:z.infer<typeof promotionPlanCreateInput>, exists:boolean) {
  const wants=(period:"monthly"|"quarterly"|"semiannual"|"annual")=>input.billingPeriods.includes(period); if((wants("monthly")&&!input.monthlyAmountCents)||(wants("quarterly")&&!input.quarterlyAmountCents)||(wants("semiannual")&&!input.semiannualAmountCents)||(wants("annual")&&!input.annualAmountCents))throw new ApiError(400,"Captura el monto de cada periodicidad seleccionada.");
  const planProfile=input.mode==="company"?"company":input.mode==="corporate"?"corporate":"accountant";
  const result = await query<Row>(exists
    ? "UPDATE promotion_plans SET profile=$2,mode=$3,name=$4,seats=$5,monthly_amount_cents=$6,quarterly_amount_cents=$7,semiannual_amount_cents=$8,annual_amount_cents=$9,regular_monthly_amount_cents=$10,benefits=$11,active=$12,display_order=$13 WHERE id=$1 RETURNING id,profile,mode,name,seats,monthly_amount_cents,quarterly_amount_cents,semiannual_amount_cents,annual_amount_cents,regular_monthly_amount_cents,benefits,active,display_order"
    : "INSERT INTO promotion_plans(id,profile,mode,name,seats,monthly_amount_cents,quarterly_amount_cents,semiannual_amount_cents,annual_amount_cents,regular_monthly_amount_cents,benefits,active,display_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id,profile,mode,name,seats,monthly_amount_cents,quarterly_amount_cents,semiannual_amount_cents,annual_amount_cents,regular_monthly_amount_cents,benefits,active,display_order",
    [input.id,planProfile,input.mode,input.name,input.seats,wants("monthly")?input.monthlyAmountCents:null,wants("quarterly")?input.quarterlyAmountCents:null,wants("semiannual")?input.semiannualAmountCents:null,wants("annual")?input.annualAmountCents:null,input.regularMonthlyAmountCents,JSON.stringify(input.benefits),input.active,input.displayOrder]);
  if (!result.rows[0]) throw new ApiError(404, "No encontramos ese plan promocional.");
  return publicPlan(result.rows[0]);
}
export const createPromotionPlan = (input:z.infer<typeof promotionPlanCreateInput>) => save(input,false);
export const updatePromotionPlan = (input:z.infer<typeof promotionPlanUpdateInput>) => save(input,true);
export async function deletePromotionPlan(id:string){return transaction(async client=>{const mappings=await client.query("DELETE FROM promotion_campaign_plans WHERE plan_id=$1",[id]);const deleted=await client.query<{id:string}>("DELETE FROM promotion_plans WHERE id=$1 RETURNING id",[id]);if(!deleted.rows[0])throw new ApiError(404,"No encontramos ese plan promocional.");return {id:deleted.rows[0].id,removedFromCampaigns:mappings.rowCount??0};});}
export async function reorderPromotionPlans(ids:string[]){return transaction(async client=>{for(const[index,planId]of ids.entries())await client.query("UPDATE promotion_plans SET display_order=$1 WHERE id=$2",[index+1,planId]);return {ids};});}
