// Users and the signed-in user's own profile (backend spec §10.2, auth and account).
import { z } from "zod";
import { audit, userActor } from "@/lib/api/audit";
import { conflict, notFound } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { Role } from "@/lib/domain/enums";
import { getSettings } from "@/lib/settings";
import { applyRepActive } from "./reps";

export const Preferences = z.object({
  theme: z.enum(["day", "dusk", "auto"]).optional(),
  mapsApp: z.enum(["apple", "google"]).optional(),
});
export type Preferences = z.infer<typeof Preferences>;

export function parsePreferences(json: string | null | undefined): Preferences {
  try {
    const r = Preferences.safeParse(JSON.parse(json ?? "{}"));
    return r.success ? r.data : {};
  } catch {
    return {};
  }
}

export async function getMe(userId: string) {
  const user = await db().user.findUnique({ where: { id: userId }, include: { rep: true } });
  if (!user) throw notFound("Your account");
  const settings = await getSettings();
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: Role.parse(user.role),
      preferences: parsePreferences(user.preferences),
      monitoringAckAt: user.monitoringAckAt,
    },
    rep: user.rep
      ? {
          id: user.rep.id,
          timeZone: user.rep.timeZone,
          baseAddress: user.rep.baseAddress,
          dailyCapacity: user.rep.dailyCapacity,
          workdays: user.rep.workdays.split(","),
          dayStartLocal: user.rep.dayStartLocal,
          onShift: user.rep.onShift,
        }
      : null,
    client: {
      foregroundPingSeconds: settings["location.foregroundPingSeconds"],
      arrivalRadiusMeters: settings["visit.arrivalRadiusMeters"],
      vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
    },
  };
}

export async function updatePreferences(userId: string, input: unknown): Promise<Preferences> {
  const patch = Preferences.parse(input);
  const user = await db().user.findUnique({ where: { id: userId } });
  if (!user) throw notFound("Your account");
  const next = { ...parsePreferences(user.preferences), ...patch };
  await db().user.update({ where: { id: userId }, data: { preferences: JSON.stringify(next) } });
  return next;
}

export async function acknowledgeMonitoring(userId: string, now = new Date()) {
  const user = await db().user.update({ where: { id: userId }, data: { monitoringAckAt: now } });
  await audit(db(), userActor(userId), "user.monitoring_ack", "USER", userId);
  return { monitoringAckAt: user.monitoringAckAt };
}

export async function listUsers() {
  const users = await db().user.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { rep: { select: { id: true, timeZone: true, baseAddress: true, dailyCapacity: true, active: true } } },
  });
  return users.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: Role.parse(u.role),
    active: u.active,
    lastLoginAt: u.lastLoginAt,
    rep: u.rep,
  }));
}

export const UserUpdate = z.object({ role: Role.optional(), active: z.boolean().optional() });

/**
 * Admin-only role and active changes. Either change bumps tokenVersion, which signs the user out
 * everywhere. The last active admin cannot be demoted or deactivated.
 */
export async function updateUser(actorUserId: string, userId: string, input: unknown) {
  const patch = UserUpdate.parse(input);
  return db().$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, include: { rep: true } });
    if (!user) throw notFound("That user");

    const losingAdmin = user.role === "ADMIN" && user.active && ((patch.role && patch.role !== "ADMIN") || patch.active === false);
    if (losingAdmin) {
      const admins = await tx.user.count({ where: { role: "ADMIN", active: true } });
      if (admins <= 1) throw conflict("Keep at least one active admin.");
    }
    if (patch.role && patch.role !== user.role && (patch.role === "REP" || user.role === "REP")) {
      throw conflict("Reps and console users are set up differently. Invite a new account instead of changing this role.");
    }

    const changed = (patch.role !== undefined && patch.role !== user.role) || (patch.active !== undefined && patch.active !== user.active);
    const updated = await tx.user.update({
      where: { id: userId },
      data: { ...patch, ...(changed ? { tokenVersion: { increment: 1 } } : {}) },
    });
    if (user.rep && patch.active !== undefined) {
      // Cancels open assignments and sends the doors back through assignment.
      await applyRepActive(tx, user.rep.id, patch.active, userActor(actorUserId), new Date());
    }
    await audit(tx, userActor(actorUserId), "user.updated", "USER", userId, {
      before: { role: user.role, active: user.active },
      after: { role: updated.role, active: updated.active },
    });
    return { id: updated.id, role: Role.parse(updated.role), active: updated.active };
  });
}
