import { z } from "zod";
import { transaction } from "./db.js";
import { ApiError } from "./contracting.js";
import { hashSecret, safeEqualSecret } from "./security.js";

export const bootstrapInput = z.object({
  bootstrapToken: z.string().min(24).max(256),
  fullName: z.string().trim().min(3).max(160),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,29}$/),
  phoneE164: z.string().regex(/^\+[1-9]\d{7,14}$/),
  password: z.string().min(12).max(128),
  pin: z.string().regex(/^\d{4}$/),
});

export async function bootstrapStatus() {
  return transaction(async (client) => {
    const [claimed, master] = await Promise.all([
      client.query<{ value: boolean }>("SELECT value FROM platform_settings WHERE key = 'master_admin_claimed'"),
      client.query("SELECT 1 FROM users WHERE platform_role = 'master_admin' AND deleted_at IS NULL LIMIT 1"),
    ]);
    return { enabled: !Boolean(claimed.rows[0]?.value) && master.rowCount === 0 };
  });
}

export async function claimMasterAdministrator(input: z.infer<typeof bootstrapInput>) {
  const configuredToken = process.env.ADMIN_BOOTSTRAP_TOKEN;
  if (!configuredToken) throw new ApiError(503, "La activación inicial aún no está configurada.");
  if (!safeEqualSecret(input.bootstrapToken, configuredToken)) throw new ApiError(401, "El código de activación no es válido.");

  return transaction(async (client) => {
    const claimed = await client.query<{ value: boolean }>(
      "SELECT value FROM platform_settings WHERE key = 'master_admin_claimed' FOR UPDATE",
    );
    const master = await client.query("SELECT 1 FROM users WHERE platform_role = 'master_admin' AND deleted_at IS NULL LIMIT 1 FOR UPDATE");
    if (Boolean(claimed.rows[0]?.value) || master.rowCount) throw new ApiError(409, "El administrador maestro ya fue creado.");
    const conflict = await client.query(
      "SELECT 1 FROM users WHERE email = $1 OR lower(username) = lower($2) OR phone_e164 = $3",
      [input.email, input.username, input.phoneE164],
    );
    if (conflict.rowCount) throw new ApiError(409, "Ya existe una cuenta con esos datos.");
    const user = await client.query<{ id: string }>(
      `INSERT INTO users
        (email, full_name, username, phone_e164, password_hash, pin_hash, platform_role, account_status, is_online, phone_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'master_admin', 'active', true, now())
       RETURNING id`,
      [input.email, input.fullName, input.username, input.phoneE164, await hashSecret(input.password), await hashSecret(input.pin)],
    );
    await client.query(
      "UPDATE platform_settings SET value = 'true'::jsonb, updated_by_user_id = $1 WHERE key = 'master_admin_claimed'",
      [user.rows[0].id],
    );
    await client.query(
      "INSERT INTO admin_security_events (actor_user_id, action, target_type, target_id) VALUES ($1, 'master_admin.claimed', 'user', $1)",
      [user.rows[0].id],
    );
    return { user: { id: user.rows[0].id, email: input.email, fullName: input.fullName, username: input.username } };
  });
}
