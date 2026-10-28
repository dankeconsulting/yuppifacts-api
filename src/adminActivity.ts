import { query } from "./db.js";

type AdminActivityInput = { action: string; title: string; detail?: string | null; route?: string | null; subjectUserId?: string | null };

export async function recordAdminActivity(adminUserId: string, input: AdminActivityInput) {
  await query(
    `INSERT INTO admin_activity_log (admin_user_id, subject_user_id, action, title, detail, route)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [adminUserId, input.subjectUserId ?? null, input.action, input.title, input.detail ?? null, input.route ?? null],
  );
}

export async function listAdministratorActivity(adminUserId: string) {
  const result = await query<{ id: string; action: string; title: string; detail: string | null; actor_name: string; subject_id: string | null; subject_name: string | null; subject_phone: string | null; created_at: Date }>(
    `SELECT log.id, log.action, log.title, log.detail, actor.full_name AS actor_name,
            subject.id AS subject_id, subject.full_name AS subject_name, subject.phone_e164 AS subject_phone,
            log.created_at
       FROM admin_activity_log log
       JOIN users actor ON actor.id = log.admin_user_id
       LEFT JOIN users subject ON subject.id = log.subject_user_id
      WHERE log.admin_user_id = $1
      ORDER BY log.created_at DESC
      LIMIT 500`,
    [adminUserId],
  );
  return { activities: result.rows.map((row) => ({
    id: row.id, action: row.action, title: row.title, detail: row.detail,
    actorName: row.actor_name,
    subscriber: row.subject_id ? { id: row.subject_id, reference: null, fullName: row.subject_name, phone: row.subject_phone, state: null, city: null } : null,
    createdAt: row.created_at.toISOString(), incident: null,
  })) };
}
