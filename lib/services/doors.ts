// Doors table and detail (PRD MGR-3; backend spec §10.2 GET/PATCH /doors, POST /doors/{id}/close).
import { z } from "zod";
import { audit, userActor } from "@/lib/api/audit";
import { conflict, notFound } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { DoorSource, DoorStatus, Priority, VisitWindow } from "@/lib/domain/enums";
import { localToday } from "@/lib/domain/time";
import { doorSnapshot, emit, visitSnapshot } from "@/lib/events";
import { enqueue } from "@/lib/jobs";
import { hotDoorPush } from "./assignment";
import type { Prisma } from "@/lib/generated/prisma/client";
import { parseEvidence } from "./review";

export const DoorListQuery = z.object({
  status: DoorStatus.optional(),
  source: DoorSource.optional(),
  repId: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  q: z.string().trim().max(100).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type DoorListQuery = z.infer<typeof DoorListQuery>;

export async function listDoors(query: DoorListQuery) {
  const where: Prisma.DoorWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.source ? { source: query.source } : {}),
    ...(query.repId || query.date
      ? { assignments: { some: { ...(query.repId ? { repId: query.repId } : {}), ...(query.date ? { scheduledFor: query.date } : {}) } } }
      : {}),
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q } },
            { company: { name: { contains: query.q } } },
            { street: { contains: query.q } },
            { city: { contains: query.q } },
            { externalProspectId: { contains: query.q } },
          ],
        }
      : {}),
  };
  const rows = await db().door.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    include: {
      company: { select: { name: true } },
      assignments: { where: { status: "ACTIVE" }, take: 1, include: { rep: { include: { user: { select: { name: true } } } } } },
    },
  });
  const items = rows.slice(0, query.limit).map((d) => ({
    id: d.id,
    name: d.name,
    companyName: d.company.name,
    status: d.status as DoorStatus,
    reviewReason: d.reviewReason,
    priority: d.priority,
    source: d.source,
    address: [d.street, d.city, [d.state, d.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    jobLocation: d.jobCity ? [d.jobCity, d.jobState].filter(Boolean).join(", ") : null,
    rep: d.assignments[0] ? { id: d.assignments[0].repId, name: d.assignments[0].rep.user.name, scheduledFor: d.assignments[0].scheduledFor } : null,
    updatedAt: d.updatedAt,
  }));
  return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.id : null };
}

export async function getDoorDetail(doorId: string) {
  const door = await db().door.findUnique({
    where: { id: doorId },
    include: {
      company: true,
      assignments: { orderBy: { createdAt: "desc" }, include: { rep: { include: { user: { select: { name: true } } } } } },
      visits: { orderBy: { recordedAt: "desc" }, select: { id: true } },
    },
  });
  if (!door) throw notFound("That door");
  const timeline = await db().auditLog.findMany({
    where: { entityType: "DOOR", entityId: doorId },
    orderBy: { createdAt: "asc" },
    include: { actorUser: { select: { name: true } } },
  });
  return {
    door: await doorSnapshot(db(), doorId),
    contact: { name: door.contactName, phone: door.contactPhone, email: door.contactEmail, linkedinUrl: door.contactLinkedinUrl },
    source: door.source,
    createdAt: door.createdAt,
    workplaceType: door.workplaceType,
    placeId: door.placeId,
    evidence: door.reviewDetail ? parseEvidence(door.reviewDetail) : null,
    assignments: door.assignments.map((a) => ({
      id: a.id,
      repId: a.repId,
      repName: a.rep.user.name,
      scheduledFor: a.scheduledFor,
      status: a.status,
      assignedBy: a.assignedBy,
      reason: a.reason,
      driveMinutes: a.driveMinutes,
      routeOrder: a.routeOrder,
      plannedArrival: a.plannedArrival,
      arrivedAt: a.arrivedAt,
    })),
    visits: await Promise.all(door.visits.map((v) => visitSnapshot(db(), v.id))),
    timeline: timeline.map((t) => ({
      id: t.id,
      at: t.createdAt,
      action: t.action,
      actor: t.actorType === "USER" ? (t.actorUser?.name ?? "A user") : t.actorType === "API_KEY" ? "API key" : "Canvass",
      data: t.data ? (JSON.parse(t.data) as unknown) : null,
    })),
  };
}

export const DoorUpdate = z
  .object({
    priority: Priority.optional(),
    qualificationNotes: z.string().max(4000).optional(),
    preferredVisitWindow: VisitWindow.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Send at least one field");

/**
 * A door just became hot (ASN-4). On a rep's route for today: re-plan and, if they are on shift, push.
 * Engine-assigned for a later day: back through assignment, so a hot door can land on today.
 * A manager's own assignment is never moved.
 */
async function onBecameHot(tx: Parameters<Parameters<ReturnType<typeof db>["$transaction"]>[0]>[0], doorId: string, now: Date) {
  const a = await tx.assignment.findFirst({
    where: { doorId, status: "ACTIVE" },
    include: { rep: { select: { id: true, timeZone: true, userId: true, onShift: true } }, door: { select: { company: { select: { name: true } } } } },
  });
  if (!a) return;
  const today = localToday(a.rep.timeZone, now);
  if (a.scheduledFor === today) {
    await enqueue(tx, "route.plan", { repId: a.rep.id, date: today, trigger: "HOT_DOOR" }, { dedupeKey: `plan:${a.rep.id}:${today}:today` });
    if (a.rep.onShift) await enqueue(tx, "push.send", { userId: a.rep.userId, ...hotDoorPush(a.door.company.name, null) });
  } else if (a.assignedBy === "ENGINE" && a.scheduledFor > today) {
    await tx.assignment.update({ where: { id: a.id }, data: { status: "CANCELLED", reason: "Marked hot: re-assigning" } });
    await tx.door.update({ where: { id: doorId }, data: { status: "GEOCODED" } });
    await enqueue(tx, "door.assign", { doorId, reason: "NEW" }, { dedupeKey: `assign:${doorId}` });
  }
}

/** Manager edits. Marking a door hot re-runs the hot-door rules. */
export async function updateDoor(actorUserId: string, doorId: string, input: unknown, now = new Date()) {
  const patch = DoorUpdate.parse(input);
  return db().$transaction(async (tx) => {
    const before = await tx.door.findUnique({ where: { id: doorId }, select: { priority: true, qualificationNotes: true, preferredVisitWindow: true } });
    if (!before) throw notFound("That door");
    await tx.door.update({ where: { id: doorId }, data: patch });
    if (patch.priority === "HOT" && before.priority !== "HOT") await onBecameHot(tx, doorId, now);
    const snapshot = await doorSnapshot(tx, doorId);
    await emit(tx, "door.upserted", { door: snapshot }, now);
    await audit(tx, userActor(actorUserId), "door.updated", "DOOR", doorId, { before, after: patch });
    return snapshot;
  });
}

export const DoorClose = z.object({ reason: z.enum(["NO_VISIT", "MANUAL"]), note: z.string().max(500).optional() });

export async function closeDoor(actorUserId: string, doorId: string, input: unknown, now = new Date()) {
  const { reason, note } = DoorClose.parse(input);
  return db().$transaction(async (tx) => {
    const door = await tx.door.findUnique({ where: { id: doorId }, select: { status: true } });
    if (!door) throw notFound("That door");
    if (door.status === "CLOSED") throw conflict("This door is already closed.");
    await tx.door.update({ where: { id: doorId }, data: { status: "CLOSED", closedReason: reason, closedAt: now, reviewReason: null, reviewDetail: null } });
    await tx.assignment.updateMany({ where: { doorId, status: "ACTIVE" }, data: { status: "CANCELLED", reason: "Door closed" } });
    const snapshot = await doorSnapshot(tx, doorId);
    await emit(tx, "door.upserted", { door: snapshot }, now);
    await audit(tx, userActor(actorUserId), "door.closed", "DOOR", doorId, { reason, note: note ?? null, before: door.status });
    return snapshot;
  });
}
