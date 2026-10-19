import { ApiError } from "./contracting.js";
import { query } from "./db.js";
import { verifySecret } from "./security.js";

async function requireMasterPin(pin:string){const result=await query<{pin_hash:string}>("SELECT pin_hash FROM users WHERE platform_role = 'master_admin' AND account_status = 'active' AND deleted_at IS NULL LIMIT 1");if(!result.rows[0]||!(await verifySecret(pin,result.rows[0].pin_hash)))throw new ApiError(401,"PIN administrativo no válido.");}
export async function getPromotionConfig(pin?:string){if(pin!==undefined)await requireMasterPin(pin);const result=await query<{is_enabled:boolean}>("SELECT is_enabled FROM promotion_configuration WHERE singleton = true");return {isEnabled:result.rows[0]?.is_enabled??true};}
export async function savePromotionConfig(input:{pin:string;isEnabled:boolean}){await requireMasterPin(input.pin);await query("INSERT INTO promotion_configuration(singleton,is_enabled) VALUES(true,$1) ON CONFLICT(singleton) DO UPDATE SET is_enabled=EXCLUDED.is_enabled,updated_at=now()",[input.isEnabled]);}
