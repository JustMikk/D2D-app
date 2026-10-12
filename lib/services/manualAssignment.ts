// Manual assign, reassign and unassign (PRD ASN-3, backend spec §10.2). The engine never overrides a
// manual assignment, and every change is logged with the actor and a reason.
import { z } from "zod";
import { audit, userActor } from "@/lib/api/audit";
import { conflict, notFound, validationFailed } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { doorSnapshot, emit } from "@/lib/events";
import { enqueue } from "@/lib/jobs";
import { localToday } from "@/lib/domain/time";
import { createAssignment, hotDoorPush } from "./assignment";

export const ManualAssign = z.object({
  repId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  reason: z.string().trim().max(300).optional(),
});

export const ManualUnassign = z.object({ reason: z.string().trim().min(1, "Say why").max(300) });

/** Doors a manager may hand to a rep: located, and still open. */
const ASSIGNABLE = ["GEOCODED", "ASSIGNED", "SCHEDULED", "VISITED", "UNASSIGNABLE"];

export async function manualAssign(actorUserId: string, doorId: string, input: unknown, now = new Date()) {
  const { repId, date, reason } = ManualAssign.parse(input);
  const door = await db().door.findUnique({ where: { id: doorId }, include: { company: { select: { name: true } } } });
  if (!door) throw notFound("That door");
  if (!ASSIGNABLE.includes(door.status) || door.lat === null || door.lng === null) {
    throw conflict(door.status === "CLOSED" ? "This door is closed." : "Resolve the door's address first. It needs a location before it can be assigned.");
  }
  const rep = await db().rep.findUnique({ where: { id: repId }, include: { user: { select: { id: true, active: true } } } });
  if (!rep || !rep.active || !rep.user.active) throw notFound("That rep");
  if (date < localToday(rep.timeZone, now)) throw validationFailed([{ path: "date", message: "Pick today or a later date" }]);

  return db().$transaction(async (tx) => {
    const fresh = await tx.door.findUnique({ where: { id: doorId }, select: { status: true } });
    if (!fresh || !ASSIGNABLE.includes(fresh.status)) throw conflict("This door changed. Refresh and try again.");
    const { assignment } = await createAssignment(tx, { doorId, repId, date, assignedBy: "MANAGER", assignedById: actorUserId, reason }, now);
    await audit(tx, userActor(actorUserId), "door.assigned_manually", "DOOR", doorId, { repId, date, reason: reason ?? null, previousStatus: door.status });
    if (door.priority === "HOT" && date === localToday(rep.timeZone, now)) {
      await enqueue(tx, "push.send", { userId: rep.user.id, ...hotDoorPush(door.company.name, null) });
    }
    return { assignmentId: assignment.id, door: await doorSnapshot(tx, doorId) };
  });
}

/** Back to Ready without re-running the engine: the manager decides what happens next. */
export async function manualUnassign(actorUserId: string, doorId: string, input: unknown, now = new Date()) {
  const { reason } = ManualUnassign.parse(input);
  return db().$transaction(async (tx) => {
    const door = await tx.door.findUnique({ where: { id: doorId }, select: { status: true } });
    if (!door) throw notFound("That door");
    const active = await tx.assignment.findMany({ where: { doorId, status: "ACTIVE" }, include: { rep: { select: { id: true, timeZone: true } } } });
    if (active.length === 0) throw conflict("This door has no active assignment.");
    await tx.assignment.updateMany({ where: { id: { in: active.map((a) => a.id) } }, data: { status: "CANCELLED", reason: `Unassigned: ${reason}` } });
    await tx.door.update({ where: { id: doorId }, data: { status: "GEOCODED" } });
    for (const a of active) {
      if (a.scheduledFor === localToday(a.rep.timeZone, now)) {
        await enqueue(tx, "route.plan", { repId: a.repId, date: a.scheduledFor, trigger: "MANAGER" }, { dedupeKey: `plan:${a.repId}:${a.scheduledFor}:today` });
      }
    }
    const snapshot = await doorSnapshot(tx, doorId);
    await emit(tx, "door.upserted", { door: snapshot }, now);
    await audit(tx, userActor(actorUserId), "door.unassigned", "DOOR", doorId, { reason, assignments: active.map((a) => ({ repId: a.repId, date: a.scheduledFor })) });
    return snapshot;
  });
}
