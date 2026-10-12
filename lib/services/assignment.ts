// Assignment service (backend spec §6.4, PRD ASN-1, ASN-2, ASN-4, ASN-6): loads the reps and their load,
// asks the pure engine for a decision, and applies it in one transaction.
import { audit, SYSTEM } from "@/lib/api/audit";
import { db, type Db } from "@/lib/db";
import { assignDoor, originFor, type AssignableRep, type DriveTimesFn } from "@/lib/domain/assignment";
import type { AssignReason } from "@/lib/domain/enums";
import { haversineMiles } from "@/lib/domain/geo";
import { addDays, localToday, parseWorkdays } from "@/lib/domain/time";
import { doorSnapshot, emit } from "@/lib/events";
import { enqueue } from "@/lib/jobs";
import { getSettings } from "@/lib/settings";
import { applyReview } from "./addressResolution";

/** ACTIVE and COMPLETED assignments per rep and local date (backend spec §4.4, invariant 2). */
export async function loadByRep(client: Db, fromDate: string): Promise<Map<string, Record<string, number>>> {
  const rows = await client.assignment.groupBy({
    by: ["repId", "scheduledFor"],
    where: { status: { in: ["ACTIVE", "COMPLETED"] }, scheduledFor: { gte: fromDate } },
    _count: { _all: true },
  });
  const out = new Map<string, Record<string, number>>();
  for (const r of rows) out.set(r.repId, { ...(out.get(r.repId) ?? {}), [r.scheduledFor]: r._count._all });
  return out;
}

export async function loadAssignableReps(client: Db, now: Date): Promise<AssignableRep[]> {
  const reps = await client.rep.findMany({
    where: { active: true, user: { active: true } },
    include: { user: { select: { name: true } }, unavailability: { select: { date: true } } },
  });
  // Cover every local date from "yesterday somewhere" onward.
  const loads = await loadByRep(client, addDays(now.toISOString().slice(0, 10), -2));
  return reps.map((r) => ({
    id: r.id,
    name: r.user.name,
    active: r.active,
    timeZone: r.timeZone,
    onShift: r.onShift,
    dailyCapacity: r.dailyCapacity,
    base: r.baseLat !== null && r.baseLng !== null ? { lat: r.baseLat, lng: r.baseLng } : null,
    last: r.lastLat !== null && r.lastLng !== null && r.lastLocationAt ? { lat: r.lastLat, lng: r.lastLng, at: r.lastLocationAt } : null,
    load: loads.get(r.id) ?? {},
    workdays: parseWorkdays(r.workdays),
    unavailableDates: r.unavailability.map((u) => u.date),
  }));
}

export type AssignOutcome =
  | { kind: "assigned"; repId: string; date: string; driveMinutes: number; overCapacity: boolean }
  | { kind: "review"; reason: "COVERAGE_GAP" }
  | { kind: "unassignable" }
  | { kind: "skipped"; why: string };

export type AssignOptions = { reason: AssignReason; ignoreDriveLimit?: boolean; avoid?: { repId: string; date: string } };

/** Create an ACTIVE assignment, cancelling any other for the door (invariant 1), and queue follow-up work. */
export async function createAssignment(
  tx: Db,
  input: { doorId: string; repId: string; date: string; assignedBy: "ENGINE" | "MANAGER"; assignedById?: string; reason?: string; driveMinutes?: number },
  now: Date,
) {
  const replaced = await tx.assignment.findMany({ where: { doorId: input.doorId, status: "ACTIVE" }, select: { id: true, repId: true, scheduledFor: true } });
  if (replaced.length) {
    await tx.assignment.updateMany({ where: { id: { in: replaced.map((a) => a.id) } }, data: { status: "CANCELLED", reason: "REASSIGNED" } });
  }
  const assignment = await tx.assignment.create({
    data: {
      doorId: input.doorId,
      repId: input.repId,
      scheduledFor: input.date,
      assignedBy: input.assignedBy,
      assignedById: input.assignedById ?? null,
      reason: input.reason ?? null,
      driveMinutes: input.driveMinutes ?? null,
    },
  });
  await tx.door.update({ where: { id: input.doorId }, data: { status: "ASSIGNED", reviewReason: null, reviewDetail: null } });
  const door = await doorSnapshot(tx, input.doorId);
  const rep = await tx.rep.findUniqueOrThrow({ where: { id: input.repId }, include: { user: { select: { id: true, name: true } } } });
  await emit(
    tx,
    "door.assigned",
    {
      door,
      assignment: { id: assignment.id, repId: rep.id, repName: rep.user.name, repCrmId: rep.crmId, scheduledFor: input.date, assignedBy: input.assignedBy, driveMinutes: input.driveMinutes ?? null },
    },
    now,
  );
  await emit(tx, "door.upserted", { door }, now);

  // The rep's own today: re-plan the route (the rep and the old rep, if the door moved).
  const today = localToday(rep.timeZone, now);
  const plans = new Set<string>();
  if (input.date === today) plans.add(`${rep.id}|${input.date}`);
  for (const r of replaced) {
    const old = await tx.rep.findUnique({ where: { id: r.repId }, select: { timeZone: true } });
    if (old && r.scheduledFor === localToday(old.timeZone, now)) plans.add(`${r.repId}|${r.scheduledFor}`);
  }
  for (const key of plans) {
    const [repId, date] = key.split("|") as [string, string];
    const trigger = repId === rep.id && door.priority === "HOT" ? "HOT_DOOR" : repId === rep.id ? "NEW_TODAY" : "MANAGER";
    await enqueue(tx, "route.plan", { repId, date, trigger }, { dedupeKey: `plan:${repId}:${date}:today` });
  }
  return { assignment, door, rep, today };
}

/** The hot-door push (ASN-4): "New hot door: Bluebonnet Dental, 2.1 mi away". */
export function hotDoorPush(companyName: string, miles: number | null) {
  return {
    title: "New hot door",
    body: miles === null ? `New hot door: ${companyName}` : `New hot door: ${companyName}, ${miles.toFixed(1)} mi away`,
    url: "/today",
    tag: "hot-door",
  };
}

export async function assignDoorById(
  doorId: string,
  options: AssignOptions,
  driveTimes: DriveTimesFn,
  now = new Date(),
): Promise<AssignOutcome> {
  const door = await db().door.findUnique({ where: { id: doorId }, include: { company: { select: { name: true } } } });
  if (!door) return { kind: "skipped", why: "door no longer exists" };
  const revisit = options.reason === "REVISIT";
  // Only doors waiting for a rep: Ready, or a visited door whose re-visit is due. A manager's manual
  // assignment (ASSIGNED or SCHEDULED) is never overridden by the engine.
  if (!(door.status === "GEOCODED" || (revisit && door.status === "VISITED"))) return { kind: "skipped", why: `door is ${door.status}` };
  if (door.lat === null || door.lng === null) return { kind: "skipped", why: "door has no coordinates" };

  const settings = await getSettings();
  const reps = (await loadAssignableReps(db(), now)).map((r) =>
    // The rep who skipped this door is treated as unavailable for that one date, so the engine picks their next working day or another rep.
    options.avoid && r.id === options.avoid.repId ? { ...r, unavailableDates: [...(r.unavailableDates ?? []), options.avoid.date] } : r,
  );
  const decision = await assignDoor(
    { id: door.id, lat: door.lat, lng: door.lng, priority: door.priority as "NORMAL" | "HOT", isRevisit: revisit, nextStepAt: door.nextStepAt, preferredRepId: door.preferredRepId },
    reps,
    now,
    {
      maxDriveMinutes: options.ignoreDriveLimit ? Number.POSITIVE_INFINITY : settings["assignment.maxDriveMinutes"],
      shortlistSize: settings["assignment.shortlistSize"],
      cutoffLocalTime: settings["assignment.cutoffLocalTime"],
      locationStalenessMinutes: settings["assignment.locationStalenessMinutes"],
      roadFactor: settings["routing.roadFactor"],
      avgSpeedMph: settings["routing.avgSpeedMph"],
    },
    driveTimes,
  );

  return db().$transaction(async (tx): Promise<AssignOutcome> => {
    const fresh = await tx.door.findUnique({ where: { id: doorId }, select: { status: true } });
    if (fresh?.status !== door.status) return { kind: "skipped", why: "door changed while assigning" };

    if (decision.kind === "unassignable") {
      await tx.door.update({ where: { id: doorId }, data: { status: "UNASSIGNABLE" } });
      const snapshot = await doorSnapshot(tx, doorId);
      await emit(tx, "door.unassignable", { door: snapshot }, now);
      await emit(tx, "door.upserted", { door: snapshot }, now);
      await audit(tx, SYSTEM, "door.unassignable", "DOOR", doorId);
      return { kind: "unassignable" };
    }
    if (decision.kind === "review") {
      await applyReview(tx, doorId, decision.reason, decision.evidence, now);
      return { kind: "review", reason: "COVERAGE_GAP" };
    }

    await createAssignment(
      tx,
      { doorId, repId: decision.repId, date: decision.date, assignedBy: "ENGINE", driveMinutes: decision.driveMinutes, reason: options.reason },
      now,
    );
    await audit(tx, SYSTEM, "door.assigned", "DOOR", doorId, { repId: decision.repId, date: decision.date, driveMinutes: decision.driveMinutes, reason: options.reason, overCapacity: decision.overCapacity });

    // ASN-4: a hot door for today also reaches the rep's phone.
    if (decision.isToday && door.priority === "HOT") {
      const repRow = reps.find((r) => r.id === decision.repId);
      const origin = repRow ? originFor(repRow, now, settings["assignment.locationStalenessMinutes"]) : null;
      const miles = origin ? haversineMiles(origin, { lat: door.lat!, lng: door.lng! }) : null;
      const rep = await tx.rep.findUniqueOrThrow({ where: { id: decision.repId }, select: { userId: true } });
      await enqueue(tx, "push.send", { userId: rep.userId, ...hotDoorPush(door.company.name, miles) });
    }
    return { kind: "assigned", repId: decision.repId, date: decision.date, driveMinutes: decision.driveMinutes, overCapacity: decision.overCapacity };
  });
}
