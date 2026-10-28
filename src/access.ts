import { z } from "zod";
import { query, transaction } from "./db.js";
import type { PoolClient } from "pg";
import { ApiError } from "./contracting.js";
import { hashOpaqueToken, hashSecret, randomOtp, randomToken, safeEqualSecret, verifySecret } from "./security.js";

const phone = z.string().regex(/^\+[1-9]\d{7,14}$/, "Número de WhatsApp inválido");
export const issueLoginCodeInput = z.object({ phoneE164: phone });
export const verifyLoginCodeInput = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{4}$/) });
export const completeLoginInput = z.object({ challengeId: z.string().uuid(), verificationToken: z.string().min(32).max(200), pin: z.string().regex(/^\d{4}$/) });
export const changePinInput = z.object({ currentPin: z.string().regex(/^\d{4}$/), pin: z.string().regex(/^\d{4}$/), pinConfirmation: z.string().regex(/^\d{4}$/) }).refine((value) => value.pin === value.pinConfirmation, { path: ["pinConfirmation"], message: "Los PIN no coinciden." });
export const adminPasswordLoginInput = z.object({ username: z.string().trim().min(3).max(254), password: z.string().min(12).max(128) });

type UserRow = { id: string; full_name: string; username: string | null; phone_e164: string; password_hash: string | null; pin_hash: string; platform_role: string; account_status: string; is_online: boolean; subscription_mode?: string | null; avatar_object_key?: string | null };
type ChallengeRow = { id: string; user_id: string; code_hash: string; verification_token_hash: string | null; expires_at: Date; attempts: number; max_attempts: number; verified_at: Date | null; completed_at: Date | null; invalidated_at: Date | null };

function accountSummary(user: Pick<UserRow, "full_name" | "username" | "phone_e164" | "platform_role" | "account_status" | "is_online" | "subscription_mode">) {
  const profile = ["individual", "independent_accountant", "accounting_firm", "company", "corporate"].includes(user.subscription_mode ?? "") ? user.subscription_mode : "individual";
  return { fullName: user.full_name, username: user.username, phoneE164: user.phone_e164, role: user.platform_role, accountStatus: user.account_status, online: user.is_online, profile };
}

function canUsePanel(user: UserRow) {
  if (user.platform_role === "master_admin") return user.account_status === "active" && user.is_online;
  return user.platform_role === "subscriber" && ["pending_review", "active"].includes(user.account_status);
}

async function createApplicationSession(client: PoolClient, user: UserRow, metadata: { ipHash: string | null; userAgent: string | undefined }) {
  const token = randomToken();
  const session = await client.query<{ expires_at: Date }>(
    `INSERT INTO application_sessions (user_id, token_hash, expires_at, ip_hash, user_agent)
     VALUES ($1, $2, now() + interval '12 hours', $3, $4) RETURNING expires_at`,
    [user.id, hashOpaqueToken(token), metadata.ipHash, metadata.userAgent?.slice(0, 500) ?? null],
  );
  await client.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
  return { accessToken: token, expiresAt: session.rows[0].expires_at.toISOString(), account: accountSummary(user) };
}

export async function issueLoginCode(input: z.infer<typeof issueLoginCodeInput>) {
  return transaction(async (client) => {
    const found = await client.query<UserRow>(
      `SELECT id, full_name, username, phone_e164, password_hash, pin_hash, platform_role, account_status, is_online
         FROM users WHERE phone_e164 = $1 AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,
      [input.phoneE164],
    );
    const user = found.rows[0];
    if (!user) throw new ApiError(404, "Aún no tienes una cuenta. Puedes crearla ahora o continuar después con tu registro.", "ACCOUNT_NOT_FOUND");
    if (!canUsePanel(user)) throw new ApiError(403, "Tu cuenta existe, pero aún no está disponible para entrar.", "ACCOUNT_NOT_READY");

    const prior = await client.query<{ resend_available_at: Date }>(
      `SELECT resend_available_at FROM access_challenges
        WHERE user_id = $1 AND purpose = 'login_phone' AND verified_at IS NULL AND invalidated_at IS NULL
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [user.id],
    );
    if (prior.rows[0] && prior.rows[0].resend_available_at > new Date()) throw new ApiError(429, "Espera un minuto antes de pedir otro código.");
    await client.query("UPDATE access_challenges SET invalidated_at = now() WHERE user_id = $1 AND purpose = 'login_phone' AND completed_at IS NULL AND invalidated_at IS NULL", [user.id]);

    const code = randomOtp();
    const created = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO access_challenges (user_id, phone_e164, purpose, code_hash, expires_at, resend_available_at)
       VALUES ($1, $2, 'login_phone', $3, now() + interval '1 minute', now() + interval '1 minute')
       RETURNING id, expires_at`,
      [user.id, user.phone_e164, await hashSecret(code)],
    );
    // This product deliberately presents its internally-generated code in-app.
    // Only its hash is stored; the plaintext is returned once over TLS and never logged.
    return { challengeId: created.rows[0].id, displayCode: code, expiresAt: created.rows[0].expires_at.toISOString(), resendAfterSeconds: 60 };
  });
}

export async function verifyLoginCode(input: z.infer<typeof verifyLoginCodeInput>) {
  return transaction(async (client) => {
    const result = await client.query<ChallengeRow>("SELECT id, user_id, code_hash, verification_token_hash, expires_at, attempts, max_attempts, verified_at, completed_at, invalidated_at FROM access_challenges WHERE id = $1 FOR UPDATE", [input.challengeId]);
    const challenge = result.rows[0];
    if (!challenge || challenge.invalidated_at || challenge.completed_at || challenge.verified_at || challenge.expires_at <= new Date()) throw new ApiError(400, "El código venció. Solicita uno nuevo.");
    if (challenge.attempts >= challenge.max_attempts) throw new ApiError(429, "Se agotaron los intentos. Solicita un código nuevo.");
    if (!(await verifySecret(input.code, challenge.code_hash))) {
      await client.query("UPDATE access_challenges SET attempts = attempts + 1 WHERE id = $1", [challenge.id]);
      throw new ApiError(400, "El código no coincide.");
    }
    const verificationToken = randomToken();
    await client.query("UPDATE access_challenges SET verified_at = now(), verification_token_hash = $2 WHERE id = $1", [challenge.id, hashOpaqueToken(verificationToken)]);
    return { verificationToken };
  });
}

export async function completeLogin(input: z.infer<typeof completeLoginInput>, metadata: { ipHash: string | null; userAgent: string | undefined }) {
  return transaction(async (client) => {
    const challengeResult = await client.query<ChallengeRow>("SELECT id, user_id, code_hash, verification_token_hash, expires_at, attempts, max_attempts, verified_at, completed_at, invalidated_at FROM access_challenges WHERE id = $1 FOR UPDATE", [input.challengeId]);
    const challenge = challengeResult.rows[0];
    if (!challenge || challenge.invalidated_at || challenge.completed_at || !challenge.verified_at || challenge.expires_at <= new Date() || !challenge.verification_token_hash || !safeEqualSecret(hashOpaqueToken(input.verificationToken), challenge.verification_token_hash)) throw new ApiError(401, "La verificación ya no es válida. Solicita un código nuevo.");
    const userResult = await client.query<UserRow>("SELECT u.id, u.full_name, u.username, u.phone_e164, u.password_hash, u.pin_hash, u.platform_role, u.account_status, u.is_online, contract.plan_snapshot->>'mode' AS subscription_mode FROM users u LEFT JOIN LATERAL (SELECT plan_snapshot FROM promotion_contracts WHERE user_id=u.id ORDER BY created_at DESC LIMIT 1) contract ON true WHERE u.id = $1 AND u.deleted_at IS NULL FOR UPDATE OF u", [challenge.user_id]);
    const user = userResult.rows[0];
    if (!user || !canUsePanel(user)) throw new ApiError(403, "Tu cuenta no está disponible para entrar.", "ACCOUNT_NOT_READY");
    if (!(await verifySecret(input.pin, user.pin_hash))) throw new ApiError(401, "El PIN no coincide.");
    await client.query("UPDATE access_challenges SET completed_at = now(), invalidated_at = now() WHERE id = $1", [challenge.id]);
    return createApplicationSession(client, user, metadata);
  });
}

export async function loginAdministrator(input: z.infer<typeof adminPasswordLoginInput>, metadata: { ipHash: string | null; userAgent: string | undefined }) {
  return transaction(async (client) => {
    const result = await client.query<UserRow>(
      `SELECT id, full_name, username, phone_e164, password_hash, pin_hash, platform_role, account_status, is_online
         FROM users
        WHERE (lower(username) = lower($1) OR lower(email) = lower($1))
          AND platform_role = 'master_admin' AND deleted_at IS NULL
        LIMIT 1 FOR UPDATE`,
      [input.username],
    );
    const user = result.rows[0];
    if (!user || !user.password_hash || !(await verifySecret(input.password, user.password_hash))) throw new ApiError(401, "Usuario o contraseña no válidos.");
    if (user.account_status !== "active" || !user.is_online) throw new ApiError(403, "Tu cuenta administrativa no está habilitada.", "ACCOUNT_NOT_READY");
    return createApplicationSession(client, user, metadata);
  });
}

export async function getAccessSession(token: string) {
  const result = await query<UserRow>(
    `SELECT u.id, u.full_name, u.username, u.phone_e164, u.password_hash, u.pin_hash, u.platform_role, u.account_status, u.is_online, contract.plan_snapshot->>'mode' AS subscription_mode
       FROM application_sessions s JOIN users u ON u.id = s.user_id
       LEFT JOIN LATERAL (SELECT plan_snapshot FROM promotion_contracts WHERE user_id=u.id ORDER BY created_at DESC LIMIT 1) contract ON true
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.deleted_at IS NULL
      LIMIT 1`,
    [hashOpaqueToken(token)],
  );
  const user = result.rows[0];
  if (!user || !canUsePanel(user)) throw new ApiError(401, "Tu sesión ya no está disponible.");
  return { account: accountSummary(user) };
}

export async function requireApplicationUser(token: string) {
  const result = await query<UserRow>(
    `SELECT u.id, u.full_name, u.username, u.phone_e164, u.password_hash, u.pin_hash, u.platform_role, u.account_status, u.is_online, u.avatar_object_key
       FROM application_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.deleted_at IS NULL
      LIMIT 1`,
    [hashOpaqueToken(token)],
  );
  const user = result.rows[0];
  if (!user || !canUsePanel(user)) throw new ApiError(401, "Tu sesión ya no está disponible.");
  return user;
}

export async function changePin(token: string, input: z.infer<typeof changePinInput>) {
  return transaction(async (client) => {
    const result = await client.query<UserRow>(
      `SELECT u.id, u.full_name, u.username, u.phone_e164, u.password_hash, u.pin_hash, u.platform_role, u.account_status, u.is_online
         FROM application_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.deleted_at IS NULL
        FOR UPDATE OF s, u`,
      [hashOpaqueToken(token)],
    );
    const user = result.rows[0];
    if (!user || user.account_status !== "active" || !user.is_online) throw new ApiError(401, "Tu sesión ya no está disponible.");
    if (!(await verifySecret(input.currentPin, user.pin_hash))) throw new ApiError(401, "El PIN actual no coincide.");
    await client.query("UPDATE users SET pin_hash = $2 WHERE id = $1", [user.id, await hashSecret(input.pin)]);
    await client.query("UPDATE application_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [user.id]);
    return { message: "PIN actualizado. Inicia sesión nuevamente." };
  });
}

export async function requireMasterAdministrator(token: string) {
  const session = await getAccessSession(token);
  if (session.account.role !== "master_admin") throw new ApiError(403, "Esta acción requiere una sesión de administrador maestro.");
  const result = await query<{ id: string }>(
    "SELECT user_id AS id FROM application_sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1",
    [hashOpaqueToken(token)],
  );
  if (!result.rows[0]) throw new ApiError(401, "Tu sesión ya no está disponible.");
  return { ...session.account, id: result.rows[0].id };
}

export async function confirmMasterPin(token: string, pin: string) {
  const result = await query<UserRow>(
    `SELECT u.id, u.full_name, u.username, u.phone_e164, u.password_hash, u.pin_hash, u.platform_role, u.account_status, u.is_online
       FROM application_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.deleted_at IS NULL
      LIMIT 1`,
    [hashOpaqueToken(token)],
  );
  const user = result.rows[0];
  if (!user || user.platform_role !== "master_admin" || !(await verifySecret(pin, user.pin_hash))) throw new ApiError(401, "PIN administrativo no válido.");
  return user.id;
}
