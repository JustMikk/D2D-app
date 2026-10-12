// Audit log writer (backend spec §4.4 invariant 5): every manager or admin mutation writes a row.
import type { Db } from "@/lib/db";

export type Actor = { type: "USER"; userId: string } | { type: "API_KEY"; keyId: string } | { type: "SYSTEM" };

export const SYSTEM: Actor = { type: "SYSTEM" };
export const userActor = (userId: string): Actor => ({ type: "USER", userId });

export type AuditEntity = "DOOR" | "REP" | "COMPANY" | "ASSIGNMENT" | "VISIT" | "SETTING" | "API_KEY" | "USER" | "IMPORT" | "INVITE";

export async function audit(
  db: Db,
  actor: Actor,
  action: string,
  entityType: AuditEntity,
  entityId: string,
  data?: unknown,
): Promise<void> {
  await db.auditLog.create({
    data: {
      actorType: actor.type,
      actorUserId: actor.type === "USER" ? actor.userId : null,
      actorKeyId: actor.type === "API_KEY" ? actor.keyId : null,
      action,
      entityType,
      entityId,
      data: data === undefined ? null : JSON.stringify(data),
    },
  });
}
