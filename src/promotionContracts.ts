import { z } from "zod";
import { ApiError } from "./contracting.js";
import { query } from "./db.js";
import { hashOpaqueToken, randomToken } from "./security.js";
import { getPromotionConfig } from "./promotionConfig.js";

const plans = {
  independent_accountant:{profile:"accountant",monthly:89900,quarterly:242700},
  accounting_firm:{profile:"accountant",monthly:199900,quarterly:539700},
  company:{profile:"company",monthly:299900,quarterly:809700},
  corporate:{profile:"corporate",monthly:499900,quarterly:1349700},
} as const;
const planId=z.enum(["independent_accountant","accounting_firm","company","corporate"]);
export const createPromotionContractInput=z.object({profile:z.enum(["accountant","company","corporate"]),planId,billingPeriod:z.enum(["monthly","quarterly"])});
export const promotionAccessInput=z.object({promotionId:z.string().uuid(),promotionToken:z.string().min(32).max(256)});
type ContractRow={id:string;folio:string;profile:keyof typeof plans[keyof typeof plans]["profile"] extends never ? never : string;plan_id:keyof typeof plans;billing_period:"monthly"|"quarterly";quoted_amount_cents:number;currency:string;lifecycle_status:string};
function folio(){return `YFP-${new Date().getUTCFullYear()}-${randomToken(6).toUpperCase()}`;}
export async function createPromotionContract(input:z.infer<typeof createPromotionContractInput>){const config=await getPromotionConfig();if(!config.isEnabled)throw new ApiError(409,"La promoción no está disponible o ya alcanzó su cupo.");const plan=plans[input.planId];if(plan.profile!==input.profile)throw new ApiError(400,"El plan no corresponde al perfil seleccionado.");const token=randomToken();const amount=plan[input.billingPeriod];const result=await query<ContractRow>(`INSERT INTO promotion_contracts(folio,access_token_hash,profile,plan_id,billing_period,quoted_amount_cents)
VALUES($1,$2,$3,$4,$5,$6) RETURNING id,folio,profile,plan_id,billing_period,quoted_amount_cents,currency,lifecycle_status`,[folio(),hashOpaqueToken(token),input.profile,input.planId,input.billingPeriod,amount]);const row=result.rows[0];return {promotion:{id:row.id,folio:row.folio,profile:row.profile,planId:row.plan_id,billingPeriod:row.billing_period,quotedAmountCents:row.quoted_amount_cents,currency:row.currency.trim(),promotionTag:"promo"},accessToken:token};}
export async function requirePromotionContract(input:z.infer<typeof promotionAccessInput>){const result=await query<ContractRow>(`SELECT id,folio,profile,plan_id,billing_period,quoted_amount_cents,currency,lifecycle_status FROM promotion_contracts WHERE id=$1 AND access_token_hash=$2`,[input.promotionId,hashOpaqueToken(input.promotionToken)]);const row=result.rows[0];if(!row)throw new ApiError(404,"No encontramos esta contratación promocional.");if(["active","rejected","cancelled"].includes(row.lifecycle_status))throw new ApiError(409,"Esta contratación ya no acepta comprobantes.");return row;}
export async function promotionPaymentStatus(input:z.infer<typeof promotionAccessInput>){const contract=await requirePromotionContract(input);return {status:contract.lifecycle_status,canSubmitVoucher:contract.lifecycle_status==="payment_verified"};}
