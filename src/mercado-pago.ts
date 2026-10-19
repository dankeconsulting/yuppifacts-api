import { createHmac } from "node:crypto";
import { z } from "zod";
import { decryptCredential, encryptCredential, maskCredential } from "./credentials.js";
import { ApiError } from "./contracting.js";
import { query, transaction } from "./db.js";
import { hashOpaqueToken, safeEqualSecret, verifySecret } from "./security.js";
import { promotionAccessInput, requirePromotionContract } from "./promotionContracts.js";

const environment = z.enum(["sandbox", "production"]);
export const credentialsInput = z.object({ pin: z.string().regex(/^\d{4,12}$/), environment, publicKey: z.string().trim().min(10).max(300), accessToken: z.string().trim().min(10).max(500), webhookSecret: z.string().trim().min(16).max(500) });
export const testConnectionInput = z.object({ pin: z.string().regex(/^\d{4,12}$/), environment });
export const activateInput = testConnectionInput;

type Configuration = { id: string; environment: "sandbox" | "production"; public_key_encrypted: string; access_token_encrypted: string; webhook_secret_encrypted: string; connection_status: "configured" | "tested" | "failed"; is_active: boolean; last_tested_at: Date | null };
type CheckoutSession = { id: string; folio: string; plan_id: string; billing_period: string; quoted_amount_cents: number; currency: string; lifecycle_status: string; access_token_hash: string };

async function requireMasterPin(pin: string) {
  const master = await query<{ id: string; pin_hash: string }>("SELECT id, pin_hash FROM users WHERE platform_role = 'master_admin' AND account_status = 'active' AND deleted_at IS NULL LIMIT 1");
  if (!master.rows[0] || !(await verifySecret(pin, master.rows[0].pin_hash))) throw new ApiError(401, "PIN administrativo no válido.");
  return master.rows[0].id;
}

function publicConfiguration(row: Configuration) {
  return { environment: row.environment, configured: true, connectionStatus: row.connection_status, isActive: row.is_active, lastTestedAt: row.last_tested_at?.toISOString() ?? null, publicKeyMasked: maskCredential(decryptCredential(row.public_key_encrypted)), accessTokenMasked: maskCredential(decryptCredential(row.access_token_encrypted)) };
}

export async function listConfigurations(pin: string) {
  await requireMasterPin(pin);
  const result = await query<Configuration>("SELECT * FROM payment_provider_configurations WHERE provider = 'mercado_pago' ORDER BY environment");
  return { environments: result.rows.map(publicConfiguration) };
}

export async function saveCredentials(input: z.infer<typeof credentialsInput>) {
  const actorId = await requireMasterPin(input.pin);
  await query(
    `INSERT INTO payment_provider_configurations (provider, environment, public_key_encrypted, access_token_encrypted, webhook_secret_encrypted, connection_status)
     VALUES ('mercado_pago', $1, $2, $3, $4, 'configured')
     ON CONFLICT (provider, environment) DO UPDATE SET public_key_encrypted = EXCLUDED.public_key_encrypted, access_token_encrypted = EXCLUDED.access_token_encrypted, webhook_secret_encrypted = EXCLUDED.webhook_secret_encrypted, connection_status = 'configured', is_active = false`,
    [input.environment, encryptCredential(input.publicKey), encryptCredential(input.accessToken), encryptCredential(input.webhookSecret)],
  );
  await query("INSERT INTO admin_security_events (actor_user_id, action, target_type, metadata) VALUES ($1, 'mercado_pago.credentials_saved', 'payment_provider', $2)", [actorId, JSON.stringify({ environment: input.environment })]);
}

async function configurationFor(environmentValue: z.infer<typeof environment>) {
  const result = await query<Configuration>("SELECT * FROM payment_provider_configurations WHERE provider = 'mercado_pago' AND environment = $1", [environmentValue]);
  const row = result.rows[0];
  if (!row) throw new ApiError(409, "Primero guarda las credenciales de Mercado Pago.");
  return row;
}

export async function testConnection(input: z.infer<typeof testConnectionInput>) {
  const actorId = await requireMasterPin(input.pin); const configuration = await configurationFor(input.environment);
  const response = await fetch("https://api.mercadopago.com/users/me", { headers: { Authorization: `Bearer ${decryptCredential(configuration.access_token_encrypted)}` } });
  if (!response.ok) { await query("UPDATE payment_provider_configurations SET connection_status = 'failed', last_tested_at = now() WHERE id = $1", [configuration.id]); throw new ApiError(400, "Mercado Pago rechazó las credenciales. Revisa el ambiente y el Access Token."); }
  await query("UPDATE payment_provider_configurations SET connection_status = 'tested', last_tested_at = now() WHERE id = $1", [configuration.id]);
  await query("INSERT INTO admin_security_events (actor_user_id, action, target_type, metadata) VALUES ($1, 'mercado_pago.connection_tested', 'payment_provider', $2)", [actorId, JSON.stringify({ environment: input.environment })]);
  return { message: "Conexión con Mercado Pago validada." };
}

export async function activateConfiguration(input: z.infer<typeof activateInput>) {
  const actorId = await requireMasterPin(input.pin); const configuration = await configurationFor(input.environment);
  if (configuration.connection_status !== "tested") throw new ApiError(409, "Primero valida la conexión con Mercado Pago.");
  await transaction(async (client) => { await client.query("UPDATE payment_provider_configurations SET is_active = false WHERE provider = 'mercado_pago'"); await client.query("UPDATE payment_provider_configurations SET is_active = true WHERE id = $1", [configuration.id]); });
  await query("INSERT INTO admin_security_events (actor_user_id, action, target_type, metadata) VALUES ($1, 'mercado_pago.activated', 'payment_provider', $2)", [actorId, JSON.stringify({ environment: input.environment })]);
}

async function activeConfiguration() {
  const result = await query<Configuration>("SELECT * FROM payment_provider_configurations WHERE provider = 'mercado_pago' AND is_active = true LIMIT 1");
  const configuration = result.rows[0];
  if (!configuration) throw new ApiError(503, "Mercado Pago todavía no está activo. Configúralo desde el Administrador Maestro.");
  return configuration;
}

export async function createCheckout(sessionId: string, accessToken: string) {
  const sessionResult = await query<CheckoutSession>("SELECT * FROM contracting_sessions WHERE id = $1", [sessionId]); const session = sessionResult.rows[0];
  if (!session || !safeEqualSecret(hashOpaqueToken(accessToken), session.access_token_hash)) throw new ApiError(404, "No encontramos esta contratación.");
  if (session.lifecycle_status !== "pending_payment") throw new ApiError(409, "Esta contratación no está lista para pago.");
  const existing = await query("SELECT 1 FROM payment_attempts WHERE contracting_session_id = $1 LIMIT 1", [sessionId]); if (existing.rowCount) throw new ApiError(409, "Ya existe un intento de pago para esta contratación.");
  const config = await activeConfiguration();
  const plan = await query<{ name: string }>("SELECT name FROM subscription_plans WHERE id = $1", [session.plan_id]);
  const webOrigin = (process.env.WEB_ORIGIN ?? "").split(",")[0]?.trim(); const apiUrl = process.env.API_PUBLIC_URL?.replace(/\/$/, "");
  if (!webOrigin || !apiUrl) throw new ApiError(503, "Faltan las URLs públicas para iniciar Mercado Pago.");
  const preferenceResponse = await fetch("https://api.mercadopago.com/checkout/preferences", { method: "POST", headers: { Authorization: `Bearer ${decryptCredential(config.access_token_encrypted)}`, "content-type": "application/json" }, body: JSON.stringify({ items: [{ title: `YuppiFacts · ${plan.rows[0]?.name ?? session.plan_id} · ${session.billing_period}`, quantity: 1, currency_id: session.currency.trim(), unit_price: session.quoted_amount_cents / 100 }], external_reference: session.folio, notification_url: `${apiUrl}/v1/webhooks/mercado-pago?session_id=${session.id}`, back_urls: { success: `${webOrigin}/registro/${session.folio}?payment=success`, failure: `${webOrigin}/registro/${session.folio}?payment=failure`, pending: `${webOrigin}/registro/${session.folio}?payment=pending` }, auto_return: "approved" }) });
  const preference = await preferenceResponse.json().catch(() => null) as { id?: string; init_point?: string; sandbox_init_point?: string; message?: string } | null;
  if (!preferenceResponse.ok || !preference?.id || !(preference.init_point || preference.sandbox_init_point)) throw new ApiError(502, preference?.message ?? "No fue posible crear el pago en Mercado Pago.");
  await transaction(async (client) => { await client.query("INSERT INTO payment_attempts (contracting_session_id, provider, provider_reference, amount_cents, currency, provider_payload) VALUES ($1, 'mercado_pago', $2, $3, $4, $5)", [session.id, preference.id, session.quoted_amount_cents, session.currency, JSON.stringify({ environment: config.environment })]); await client.query("UPDATE contracting_sessions SET lifecycle_status = 'checkout_started' WHERE id = $1", [session.id]); await client.query("INSERT INTO contracting_audit_events (contracting_session_id, event_type, metadata) VALUES ($1, 'mercado_pago.checkout_created', $2)", [session.id, JSON.stringify({ preferenceId: preference.id })]); });
  return { checkoutUrl: config.environment === "sandbox" ? preference.sandbox_init_point ?? preference.init_point : preference.init_point, preferenceId: preference.id };
}

const promotionTitles: Record<string, string> = { independent_accountant: "Contador independiente", accounting_firm: "Despacho contable", company: "Empresa", corporate: "Corporativo" };

export async function createPromotionCheckout(promotionId: string, accessToken: string) {
  const contract = await requirePromotionContract(promotionAccessInput.parse({ promotionId, promotionToken: accessToken }));
  if (!['pending_payment', 'checkout_started'].includes(contract.lifecycle_status)) throw new ApiError(409, "Esta contratación no está disponible para pago.");
  const config = await activeConfiguration();
  const apiUrl = process.env.API_PUBLIC_URL?.replace(/\/$/, "");
  const ticketsUrl = (process.env.PROMOTION_TICKETS_URL ?? "https://tickets.yuppifacts.com").replace(/\/$/, "");
  if (!apiUrl) throw new ApiError(503, "Falta la URL pública del API para iniciar Mercado Pago.");
  const reference = `${contract.folio}-${Date.now()}`;
  const returnUrl = `${ticketsUrl}/?payment=success#promo=${contract.id}.${accessToken}`;
  const preferenceResponse = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: { Authorization: `Bearer ${decryptCredential(config.access_token_encrypted)}`, "content-type": "application/json" },
    body: JSON.stringify({
      items: [{ title: `YuppiFacts · ${promotionTitles[contract.plan_id] ?? contract.plan_id} · ${contract.billing_period}`, quantity: 1, currency_id: contract.currency.trim(), unit_price: contract.quoted_amount_cents / 100 }],
      external_reference: contract.folio,
      notification_url: `${apiUrl}/v1/webhooks/mercado-pago/promotion?promotion_id=${contract.id}`,
      back_urls: { success: returnUrl, failure: `${ticketsUrl}/?payment=failure#promo=${contract.id}.${accessToken}`, pending: `${ticketsUrl}/?payment=pending#promo=${contract.id}.${accessToken}` },
      auto_return: "approved",
    }),
  });
  const preference = await preferenceResponse.json().catch(() => null) as { id?: string; init_point?: string; sandbox_init_point?: string; message?: string } | null;
  if (!preferenceResponse.ok || !preference?.id || !(preference.init_point || preference.sandbox_init_point)) throw new ApiError(502, preference?.message ?? "No fue posible crear el pago en Mercado Pago.");
  await transaction(async (client) => {
    await client.query("INSERT INTO promotion_payment_attempts (promotion_contract_id, provider_reference, amount_cents, currency, environment, provider_payload) VALUES ($1,$2,$3,$4,$5,$6)", [contract.id, preference.id, contract.quoted_amount_cents, contract.currency, config.environment, JSON.stringify({ reference })]);
    await client.query("UPDATE promotion_contracts SET lifecycle_status = 'checkout_started' WHERE id = $1", [contract.id]);
  });
  return { checkoutUrl: config.environment === "sandbox" ? preference.sandbox_init_point ?? preference.init_point : preference.init_point, preferenceId: preference.id };
}

function signatureValue(header: string | undefined, key: string) {
  return header?.split(",").map((part) => part.trim().split("=")).find(([name]) => name === key)?.[1];
}

export async function processWebhook(sessionId: string, paymentId: string, xSignature: string | undefined, xRequestId: string | undefined) {
  const attempt = await query<{ id: string; provider_payload: { environment?: "sandbox" | "production" } }>("SELECT id, provider_payload FROM payment_attempts WHERE contracting_session_id = $1 AND provider = 'mercado_pago' ORDER BY created_at DESC LIMIT 1", [sessionId]);
  const paymentAttempt = attempt.rows[0];
  if (!paymentAttempt) throw new ApiError(404, "Intento de pago no encontrado.");
  const config = await configurationFor(paymentAttempt.provider_payload.environment ?? "production");
  const timestamp = signatureValue(xSignature, "ts"); const expected = signatureValue(xSignature, "v1");
  if (!timestamp || !expected || !xRequestId) throw new ApiError(401, "Firma de Mercado Pago incompleta.");
  const manifest = `id:${paymentId};request-id:${xRequestId};ts:${timestamp};`;
  const calculated = createHmac("sha256", decryptCredential(config.webhook_secret_encrypted)).update(manifest).digest("hex");
  if (!safeEqualSecret(calculated, expected)) throw new ApiError(401, "Firma de Mercado Pago inválida.");
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: `Bearer ${decryptCredential(config.access_token_encrypted)}` } });
  const payment = await response.json().catch(() => null) as { status?: string; id?: number | string } | null;
  if (!response.ok || !payment?.status) throw new ApiError(502, "No fue posible verificar el pago con Mercado Pago.");
  const statusMap: Record<string, string> = { approved: "approved", rejected: "rejected", cancelled: "cancelled", refunded: "refunded", in_process: "under_review", pending: "pending" };
  const paymentStatus = statusMap[payment.status] ?? "under_review";
  const sessionStatus = payment.status === "approved" ? "payment_verified" : payment.status === "rejected" ? "pending_payment" : "checkout_started";
  await transaction(async (client) => { await client.query("UPDATE payment_attempts SET status = $2, provider_payload = provider_payload || $3::jsonb, approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END WHERE id = $1", [paymentAttempt.id, paymentStatus, JSON.stringify({ paymentId: String(payment.id), paymentStatus: payment.status })]); await client.query("UPDATE contracting_sessions SET lifecycle_status = $2 WHERE id = $1", [sessionId, sessionStatus]); await client.query("INSERT INTO contracting_audit_events (contracting_session_id, event_type, metadata) VALUES ($1, 'mercado_pago.webhook_processed', $2)", [sessionId, JSON.stringify({ paymentId, paymentStatus: payment.status })]); });
}

export async function processPromotionWebhook(promotionId: string, paymentId: string, xSignature: string | undefined, xRequestId: string | undefined) {
  const attempt = await query<{ id: string; environment: "sandbox" | "production" }>("SELECT id, environment FROM promotion_payment_attempts WHERE promotion_contract_id = $1 ORDER BY created_at DESC LIMIT 1", [promotionId]);
  const paymentAttempt = attempt.rows[0];
  if (!paymentAttempt) throw new ApiError(404, "Intento de pago promocional no encontrado.");
  const config = await configurationFor(paymentAttempt.environment);
  const timestamp = signatureValue(xSignature, "ts"); const expected = signatureValue(xSignature, "v1");
  if (!timestamp || !expected || !xRequestId) throw new ApiError(401, "Firma de Mercado Pago incompleta.");
  const manifest = `id:${paymentId};request-id:${xRequestId};ts:${timestamp};`;
  const calculated = createHmac("sha256", decryptCredential(config.webhook_secret_encrypted)).update(manifest).digest("hex");
  if (!safeEqualSecret(calculated, expected)) throw new ApiError(401, "Firma de Mercado Pago inválida.");
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: `Bearer ${decryptCredential(config.access_token_encrypted)}` } });
  const payment = await response.json().catch(() => null) as { status?: string; id?: number | string } | null;
  if (!response.ok || !payment?.status) throw new ApiError(502, "No fue posible verificar el pago con Mercado Pago.");
  const paymentStatus = ({ approved: "approved", rejected: "rejected", cancelled: "cancelled", refunded: "cancelled", in_process: "under_review", pending: "pending" } as Record<string, string>)[payment.status] ?? "under_review";
  const contractStatus = payment.status === "approved" ? "payment_verified" : payment.status === "rejected" ? "pending_payment" : "checkout_started";
  await transaction(async (client) => { await client.query("UPDATE promotion_payment_attempts SET status=$2, provider_payload=provider_payload || $3::jsonb, approved_at=CASE WHEN $2='approved' THEN now() ELSE approved_at END WHERE id=$1", [paymentAttempt.id, paymentStatus, JSON.stringify({ paymentId: String(payment.id), paymentStatus: payment.status })]); await client.query("UPDATE promotion_contracts SET lifecycle_status=$2 WHERE id=$1", [promotionId, contractStatus]); });
}
