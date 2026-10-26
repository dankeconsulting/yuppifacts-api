import { z } from "zod";
import { ApiError } from "./contracting.js";
import { query, transaction } from "./db.js";
import { createPrivateViewUrl, createUserAvatarUploadUrl, deletePrivateObject, verifyUserAvatarUpload } from "./storage.js";

const avatarContentType = z.enum(["image/jpeg", "image/png", "image/webp"]);
export const avatarUploadInput = z.object({ filename: z.string().min(1).max(180), contentType: avatarContentType });
export const avatarConfirmInput = z.object({ key: z.string().min(1).max(600), contentType: avatarContentType, byteSize: z.number().int().positive().max(8 * 1024 * 1024) });

type AvatarRow = { avatar_object_key: string | null };

function assertAvatarKeyBelongsToUser(key: string, userId: string) {
  if (!key.includes(`/users/${userId}/avatar/`)) throw new ApiError(400, "El archivo no corresponde a esta cuenta.");
}

export async function createAvatarUpload(userId: string, input: z.infer<typeof avatarUploadInput>) {
  return createUserAvatarUploadUrl({ userId, ...input });
}

export async function confirmAvatarUpload(userId: string, input: z.infer<typeof avatarConfirmInput>) {
  assertAvatarKeyBelongsToUser(input.key, userId);
  const valid = await verifyUserAvatarUpload(input);
  if (!valid) throw new ApiError(400, "No fue posible verificar la foto cargada.");

  const previous = await transaction(async (client) => {
    const result = await client.query<AvatarRow>("SELECT avatar_object_key FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [userId]);
    const user = result.rows[0];
    if (!user) throw new ApiError(404, "No encontramos esta cuenta.");
    await client.query("UPDATE users SET avatar_object_key = $2, avatar_updated_at = now() WHERE id = $1", [userId, input.key]);
    return user.avatar_object_key;
  });
  if (previous && previous !== input.key) await deletePrivateObject(previous).catch(() => undefined);
  return { avatarUrl: await createPrivateViewUrl(input.key) };
}

export async function getAvatar(userId: string) {
  const result = await query<AvatarRow>("SELECT avatar_object_key FROM users WHERE id = $1 AND deleted_at IS NULL", [userId]);
  const key = result.rows[0]?.avatar_object_key;
  return { avatarUrl: key ? await createPrivateViewUrl(key) : null };
}

export async function removeAvatar(userId: string) {
  const oldKey = await transaction(async (client) => {
    const result = await client.query<AvatarRow>("SELECT avatar_object_key FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [userId]);
    const user = result.rows[0];
    if (!user) throw new ApiError(404, "No encontramos esta cuenta.");
    await client.query("UPDATE users SET avatar_object_key = NULL, avatar_updated_at = now() WHERE id = $1", [userId]);
    return user.avatar_object_key;
  });
  if (oldKey) await deletePrivateObject(oldKey);
}
