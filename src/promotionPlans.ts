import { z } from "zod";
import { ApiError } from "./contracting.js";
import { query } from "./db.js";
import { activeCampaignPlans } from "./promotionCampaigns.js";

const profile = z.enum(["accountant", "company", "corporate"]);
const planId = z.string().regex(/^[a-z0-9_]{2,80}$/);
const benefit = z.string().trim().min(2).max(300);

export const promotionPlanInput = z.object({
  profile, name: z.string().trim().min(2).max(120), seats: z.string().trim().min(1).max(180),
  monthlyAmountCents: z.number().int().positive(), quarterlyAmountCents: z.number().int().positive(), regularMonthlyAmountCents: z.number().int().positive().nullable(),
  benefits: z.array(benefit).min(1).max(30), active: z.boolean(), displayOrder: z.number().int().min(0).max(32000),
});
export const promotionPlanCreateInput = promotionPlanInput.extend({ id: planId });
export const promotionPlanUpdateInput = promotionPlanInput.extend({ id: planId });

type Row = { id:string; profile:"accountant"|"company"|"corporate"; name:string; seats:string; monthly_amount_cents:number; quarterly_amount_cents:number; regular_monthly_amount_cents:number|null; benefits:string[]; active:boolean; display_order:number };

function publicPlan(row:Row) { return { id:row.id, profile:row.profile, name:row.name, seats:row.seats, monthlyAmountCents:row.monthly_amount_cents, quarterlyAmountCents:row.quarterly_amount_cents, regularMonthlyAmountCents:row.regular_monthly_amount_cents, benefits:row.benefits, active:row.active, displayOrder:row.display_order }; }

export async function listPublicPromotionPlans() {
  return activeCampaignPlans();
}
export async function listPromotionPlans() {
  const result = await query<Row>("SELECT id,profile,name,seats,monthly_amount_cents,quarterly_amount_cents,regular_monthly_amount_cents,benefits,active,display_order FROM promotion_plans ORDER BY profile,display_order,id");
  return result.rows.map(publicPlan);
}
async function save(input:z.infer<typeof promotionPlanCreateInput>, exists:boolean) {
  const result = await query<Row>(exists
    ? "UPDATE promotion_plans SET profile=$2,name=$3,seats=$4,monthly_amount_cents=$5,quarterly_amount_cents=$6,regular_monthly_amount_cents=$7,benefits=$8,active=$9,display_order=$10 WHERE id=$1 RETURNING id,profile,name,seats,monthly_amount_cents,quarterly_amount_cents,regular_monthly_amount_cents,benefits,active,display_order"
    : "INSERT INTO promotion_plans(id,profile,name,seats,monthly_amount_cents,quarterly_amount_cents,regular_monthly_amount_cents,benefits,active,display_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,profile,name,seats,monthly_amount_cents,quarterly_amount_cents,regular_monthly_amount_cents,benefits,active,display_order",
    [input.id,input.profile,input.name,input.seats,input.monthlyAmountCents,input.quarterlyAmountCents,input.regularMonthlyAmountCents,JSON.stringify(input.benefits),input.active,input.displayOrder]);
  if (!result.rows[0]) throw new ApiError(404, "No encontramos ese plan promocional.");
  return publicPlan(result.rows[0]);
}
export const createPromotionPlan = (input:z.infer<typeof promotionPlanCreateInput>) => save(input,false);
export const updatePromotionPlan = (input:z.infer<typeof promotionPlanUpdateInput>) => save(input,true);
