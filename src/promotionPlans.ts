import { z } from "zod";
import { ApiError } from "./contracting.js";
import { query } from "./db.js";
import { activeCampaignPlans } from "./promotionCampaigns.js";

const mode=z.enum(["independent_accountant","accounting_firm","company","corporate"]);
const billingPeriods=z.array(z.enum(["monthly","quarterly","annual"])).min(1).max(3).refine(items=>new Set(items).size===items.length,"No repitas una periodicidad.");
const planId = z.string().regex(/^[a-z0-9_]{2,80}$/);
const benefit = z.string().trim().min(2).max(300);

export const promotionPlanInput = z.object({
  mode, billingPeriods, name: z.string().trim().min(2).max(120), seats: z.string().trim().min(1).max(180),
  monthlyAmountCents: z.number().int().positive().nullable(), quarterlyAmountCents: z.number().int().positive().nullable(), annualAmountCents:z.number().int().positive().nullable(), regularMonthlyAmountCents: z.number().int().positive().nullable(),
  benefits: z.array(benefit).min(1).max(30), active: z.boolean(), displayOrder: z.number().int().min(0).max(32000),
});
export const promotionPlanCreateInput = promotionPlanInput.extend({ id: planId });
export const promotionPlanUpdateInput = promotionPlanInput.extend({ id: planId });

type Row = { id:string; profile:"accountant"|"company"|"corporate"; mode:"independent_accountant"|"accounting_firm"|"company"|"corporate"; name:string; seats:string; monthly_amount_cents:number|null; quarterly_amount_cents:number|null; annual_amount_cents:number|null; regular_monthly_amount_cents:number|null; benefits:string[]; active:boolean; display_order:number };

function publicPlan(row:Row) { const billingPeriods=[...(row.monthly_amount_cents?["monthly"]:[]),...(row.quarterly_amount_cents?["quarterly"]:[]),...(row.annual_amount_cents?["annual"]:[])];return { id:row.id, profile:row.profile, mode:row.mode, name:row.name, seats:row.seats, monthlyAmountCents:row.monthly_amount_cents, quarterlyAmountCents:row.quarterly_amount_cents, annualAmountCents:row.annual_amount_cents, billingPeriods, regularMonthlyAmountCents:row.regular_monthly_amount_cents, benefits:row.benefits, active:row.active, displayOrder:row.display_order }; }

export async function listPublicPromotionPlans() {
  return activeCampaignPlans();
}
export async function listPromotionPlans() {
  const result = await query<Row>("SELECT id,profile,mode,name,seats,monthly_amount_cents,quarterly_amount_cents,annual_amount_cents,regular_monthly_amount_cents,benefits,active,display_order FROM promotion_plans ORDER BY mode,display_order,id");
  return result.rows.map(publicPlan);
}
async function save(input:z.infer<typeof promotionPlanCreateInput>, exists:boolean) {
  const wants=(period:"monthly"|"quarterly"|"annual")=>input.billingPeriods.includes(period); if((wants("monthly")&&!input.monthlyAmountCents)||(wants("quarterly")&&!input.quarterlyAmountCents)||(wants("annual")&&!input.annualAmountCents))throw new ApiError(400,"Captura el monto de cada periodicidad seleccionada.");
  const planProfile=input.mode==="company"?"company":input.mode==="corporate"?"corporate":"accountant";
  const result = await query<Row>(exists
    ? "UPDATE promotion_plans SET profile=$2,mode=$3,name=$4,seats=$5,monthly_amount_cents=$6,quarterly_amount_cents=$7,annual_amount_cents=$8,regular_monthly_amount_cents=$9,benefits=$10,active=$11,display_order=$12 WHERE id=$1 RETURNING id,profile,mode,name,seats,monthly_amount_cents,quarterly_amount_cents,annual_amount_cents,regular_monthly_amount_cents,benefits,active,display_order"
    : "INSERT INTO promotion_plans(id,profile,mode,name,seats,monthly_amount_cents,quarterly_amount_cents,annual_amount_cents,regular_monthly_amount_cents,benefits,active,display_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,profile,mode,name,seats,monthly_amount_cents,quarterly_amount_cents,annual_amount_cents,regular_monthly_amount_cents,benefits,active,display_order",
    [input.id,planProfile,input.mode,input.name,input.seats,wants("monthly")?input.monthlyAmountCents:null,wants("quarterly")?input.quarterlyAmountCents:null,wants("annual")?input.annualAmountCents:null,input.regularMonthlyAmountCents,JSON.stringify(input.benefits),input.active,input.displayOrder]);
  if (!result.rows[0]) throw new ApiError(404, "No encontramos ese plan promocional.");
  return publicPlan(result.rows[0]);
}
export const createPromotionPlan = (input:z.infer<typeof promotionPlanCreateInput>) => save(input,false);
export const updatePromotionPlan = (input:z.infer<typeof promotionPlanUpdateInput>) => save(input,true);
