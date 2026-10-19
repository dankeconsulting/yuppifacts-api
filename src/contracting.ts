import type { PoolClient } from "pg";
import { z } from "zod";
import { query, transaction } from "./db.js";
import { hashOpaqueToken, hashSecret, randomOtp, randomToken, verifySecret } from "./security.js";

const billingPeriods = z.enum(["monthly", "quarterly", "annual"]);
const planId = z.enum(["individual", "accounting_firm", "company"]);
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/, "Número de WhatsApp inválido");

export const createSessionInput = z.object({ planId, billingPeriod: billingPeriods });
export const issueOtpInput = z.object({ phoneE164: phone });
export const verifyOtpInput = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{4}$/) });
export const createAccountInput = z.object({
  fullName: z.string().trim().min(3).max(160),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,29}$/),
  password: z.string().min(12).max(128),
  pin: z.string().regex(/^\d{4}$/),
});

type PlanRow = {
  id: string;
  name: string;
  audience_copy: string;
  organization_kind: string;
  monthly_amount_cents: number;
  currency: string;
  display_order: number;
};

type ContractingRow = {
  id: string;
  folio: string;
  plan_id: string;
  billing_period: "monthly" | "quarterly" | "annual";
  quoted_amount_cents: number;
  currency: string;
  lifecycle_status: string;
  phone_e164: string | null;
  expires_at: Date | null;
};

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function amountForPeriod(monthlyAmountCents: number, period: z.infer<typeof billingPeriods>) {
  if (period === "monthly") return monthlyAmountCents;
  if (period === "quarterly") return Math.round(monthlyAmountCents * 3 * 0.9);
  return Math.round(monthlyAmountCents * 12 * 0.8);
}

function newFolio() {
  return `YF-${new Date().getUTCFullYear()}-${randomToken(6).toUpperCase()}`;
}

function publicSession(row: ContractingRow, plan?: PlanRow) {
  return {
    id: row.id,
    folio: row.folio,
    planId: row.plan_id,
    billingPeriod: row.billing_period,
    quotedAmountCents: row.quoted_amount_cents,
    currency: row.currency.trim(),
    lifecycleStatus: row.lifecycle_status,
    phoneE164: row.phone_e164,
    expiresAt: row.expires_at?.toISOString() ?? null,
    plan: plan && {
      id: plan.id,
      name: plan.name,
      audienceCopy: plan.audience_copy,
      organizationKind: plan.organization_kind,
    },
  };
}

async function requireSession(id: string, accessToken: string, client?: PoolClient) {
  const sql =
    `SELECT id, folio, plan_id, billing_period, quoted_amount_cents, currency, lifecycle_status, phone_e164, expires_at
       FROM contracting_sessions
      WHERE id = $1 AND access_token_hash = $2`;
  const values = [id, hashOpaqueToken(accessToken)];
  const result = client
    ? await client.query<ContractingRow>(sql, values)
    : await query<ContractingRow>(sql, values);
  const session = result.rows[0];
  if (!session) throw new ApiError(404, "No encontramos esta contratación.");
  return session;
}

async function audit(client: PoolClient, sessionId: string, eventType: string, metadata: Record<string, unknown> = {}) {
  await client.query(
    "INSERT INTO contracting_audit_events (contracting_session_id, event_type, metadata) VALUES ($1, $2, $3)",
    [sessionId, eventType, JSON.stringify(metadata)],
  );
}

export async function listPlans() {
  const result = await query<PlanRow>(
    `SELECT id, name, audience_copy, organization_kind, monthly_amount_cents, currency, display_order
       FROM subscription_plans WHERE active = true ORDER BY display_order`,
  );
  return result.rows.map((item) => ({
    id: item.id,
    name: item.name,
    audienceCopy: item.audience_copy,
    organizationKind: item.organization_kind,
    monthlyAmountCents: item.monthly_amount_cents,
    currency: item.currency.trim(),
  }));
}

export async function createContractingSession(input: z.infer<typeof createSessionInput>) {
  const planResult = await query<PlanRow>(
    `SELECT id, name, audience_copy, organization_kind, monthly_amount_cents, currency, display_order
       FROM subscription_plans WHERE id = $1 AND active = true`,
    [input.planId],
  );
  const plan = planResult.rows[0];
  if (!plan) throw new ApiError(400, "El plan seleccionado ya no está disponible.");
  const token = randomToken();
  const created = await query<ContractingRow>(
    `INSERT INTO contracting_sessions
      (folio, plan_id, billing_period, quoted_amount_cents, currency, lifecycle_status, access_token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'phone_pending', $6, now() + interval '30 days')
     RETURNING id, folio, plan_id, billing_period, quoted_amount_cents, currency, lifecycle_status, phone_e164, expires_at`,
    [newFolio(), plan.id, input.billingPeriod, amountForPeriod(plan.monthly_amount_cents, input.billingPeriod), plan.currency, hashOpaqueToken(token)],
  );
  return { session: publicSession(created.rows[0], plan), accessToken: token };
}

export async function issueOtp(id: string, accessToken: string, input: z.infer<typeof issueOtpInput>) {
  return transaction(async (client) => {
    const session = await requireSession(id, accessToken, client);
    if (!["phone_pending", "draft"].includes(session.lifecycle_status)) {
      throw new ApiError(409, "Este paso de verificación ya fue completado.");
    }
    const previous = await client.query<{ resend_available_at: Date }>(
      `SELECT resend_available_at FROM otp_challenges
        WHERE contracting_session_id = $1 AND verified_at IS NULL AND invalidated_at IS NULL
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [id],
    );
    const current = previous.rows[0];
    if (current && current.resend_available_at > new Date()) {
      throw new ApiError(429, "Espera un minuto antes de pedir otro código.");
    }
    await client.query(
      "UPDATE otp_challenges SET invalidated_at = now() WHERE contracting_session_id = $1 AND verified_at IS NULL AND invalidated_at IS NULL",
      [id],
    );
    const code = randomOtp();
    const challenge = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO otp_challenges (contracting_session_id, phone_e164, purpose, code_hash, expires_at, resend_available_at)
       VALUES ($1, $2, 'contracting_phone', $3, now() + interval '5 minutes', now() + interval '1 minute')
       RETURNING id, expires_at`,
      [id, input.phoneE164, await hashSecret(code)],
    );
    await client.query("UPDATE contracting_sessions SET phone_e164 = $2, lifecycle_status = 'phone_pending' WHERE id = $1", [id, input.phoneE164]);
    await audit(client, id, "otp.issued", { channel: "in_app", phoneLastFour: input.phoneE164.slice(-4) });
    // The product requirement is an in-app code. Only its hash is persisted and
    // this plaintext value is returned once over TLS; it is never logged.
    return { challengeId: challenge.rows[0].id, displayCode: code, expiresAt: challenge.rows[0].expires_at.toISOString(), resendAfterSeconds: 60 };
  });
}

export async function verifyOtp(id: string, accessToken: string, input: z.infer<typeof verifyOtpInput>) {
  return transaction(async (client) => {
    const session = await requireSession(id, accessToken, client);
    const result = await client.query<{ id: string; code_hash: string; expires_at: Date; attempts: number; max_attempts: number; verified_at: Date | null; invalidated_at: Date | null }>(
      "SELECT id, code_hash, expires_at, attempts, max_attempts, verified_at, invalidated_at FROM otp_challenges WHERE id = $1 AND contracting_session_id = $2 FOR UPDATE",
      [input.challengeId, id],
    );
    const challenge = result.rows[0];
    if (!challenge || challenge.verified_at || challenge.invalidated_at || challenge.expires_at <= new Date()) {
      throw new ApiError(400, "El código venció. Solicita uno nuevo.");
    }
    if (challenge.attempts >= challenge.max_attempts) throw new ApiError(429, "Se agotaron los intentos. Solicita un código nuevo.");
    if (!(await verifySecret(input.code, challenge.code_hash))) {
      await client.query("UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1", [challenge.id]);
      await audit(client, id, "otp.failed");
      throw new ApiError(400, "El código no coincide.");
    }
    await client.query("UPDATE otp_challenges SET verified_at = now() WHERE id = $1", [challenge.id]);
    const updated = await client.query<ContractingRow>(
      `UPDATE contracting_sessions SET lifecycle_status = 'phone_verified' WHERE id = $1
       RETURNING id, folio, plan_id, billing_period, quoted_amount_cents, currency, lifecycle_status, phone_e164, expires_at`,
      [id],
    );
    await audit(client, id, "otp.verified");
    return publicSession(updated.rows[0]);
  });
}

export async function createAccount(id: string, accessToken: string, input: z.infer<typeof createAccountInput>) {
  return transaction(async (client) => {
    const session = await requireSession(id, accessToken, client);
    if (session.lifecycle_status !== "phone_verified" || !session.phone_e164) {
      throw new ApiError(409, "Primero verifica tu número de WhatsApp.");
    }
    const conflict = await client.query("SELECT 1 FROM users WHERE email = $1 OR lower(username) = lower($2) OR phone_e164 = $3", [input.email, input.username, session.phone_e164]);
    if (conflict.rowCount) throw new ApiError(409, "Ya existe una cuenta con esos datos.");
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (email, full_name, username, phone_e164, password_hash, pin_hash, phone_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id`,
      [input.email, input.fullName, input.username, session.phone_e164, await hashSecret(input.password), await hashSecret(input.pin)],
    );
    const updated = await client.query<ContractingRow>(
      `UPDATE contracting_sessions SET user_id = $2, lifecycle_status = 'pending_payment' WHERE id = $1
       RETURNING id, folio, plan_id, billing_period, quoted_amount_cents, currency, lifecycle_status, phone_e164, expires_at`,
      [id, user.rows[0].id],
    );
    await audit(client, id, "account.created", { userId: user.rows[0].id });
    const recipients = [input.email, process.env.MASTER_ADMIN_EMAIL].filter((value): value is string => Boolean(value));
    for (const recipient of recipients) {
      await client.query(
        `INSERT INTO notification_outbox (contracting_session_id, recipient, template, payload)
         VALUES ($1, $2, 'account_created', $3)`,
        [id, recipient, JSON.stringify({ folio: session.folio, planId: session.plan_id, audience: recipient === input.email ? "customer" : "admin" })],
      );
    }
    return { session: publicSession(updated.rows[0]), user: { id: user.rows[0].id, email: input.email, fullName: input.fullName } };
  });
}
