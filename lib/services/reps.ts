// Reps (PRD MGR-4, MGR-5, ASN-7; backend spec §10.2): profile, deployment base, deactivation,
// unavailability, the day board and re-plan.
import { z } from "zod";
import { audit, userActor, type Actor } from "@/lib/api/audit";
import { conflict, notFound, validationFailed } from "@/lib/api/errors";
import { db, type Db } from "@/lib/db";
import type { ResolutionDeps } from "@/lib/domain/addressResolution";
import { WEEKDAYS } from "@/lib/domain/enums";
import { isValidTimeZone, localToday, parseWorkdays } from "@/lib/domain/time";
import { doorSnapshot, emit } from "@/lib/events";
import { enqueue } from "@/lib/jobs";

type Geocoder = Pick<ResolutionDeps, "geocode">;

/**
 * Geocode a deployment base. Any "OK" match is accepted (a rep may be deployed to a city, so a city
 * centre is fine), but a partial match or no match is refused. A missing Google key is reported
 * plainly rather than as a server error.
 */
export async function geocodeBase(address: string, deps: Geocoder, path = "baseAddress"): Promise<{ lat: number; lng: number }> {
  let geo;
  try {
    geo = await deps.geocode(address);
  } catch (error) {
    if (error instanceof Error && /GOOGLE_MAPS_API_KEY/.test(error.message)) throw conflict("Address lookup is not set up yet (no Google Maps key). Ask an admin.");
    throw error;
  }
  if (geo.status !== "OK" || !geo.location || geo.partialMatch) {
    throw validationFailed([{ path, message: `"${address}" could not be found. Check the street, city and state.` }], "The deployment base could not be located.");
  }
  return geo.location;
}

const HHmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm, for example 09:00");

export const RepUpdate = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    timeZone: z.string().refine(isValidTimeZone, "Pick a valid time zone").optional(),
    baseAddress: z.string().trim().min(5, "Enter the street address the rep starts from").max(300).optional(),
    dailyCapacity: z.number().int().min(1).max(100).optional(),
    workdays: z.array(z.enum(WEEKDAYS)).min(1, "Pick at least one working day").optional(),
    dayStartLocal: HHmm.optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Send at least one field");

/**
 * Deactivate or reactivate the rep side of an account inside a transaction: ends any shift, cancels open
 * assignments and sends their doors back through assignment (reason REP_CHANGE); reactivating re-tries
 * doors that had no rep. The caller updates the user (active flag and tokenVersion).
 */
export async function applyRepActive(tx: Db, repId: string, active: boolean, actor: Actor, now: Date): Promise<{ reassigned: number }> {
  const rep = await tx.rep.findUniqueOrThrow({ where: { id: repId } });
  if (rep.active === active) return { reassigned: 0 };
  await tx.rep.update({ where: { id: repId }, data: { active, ...(active ? {} : { onShift: false }) } });

  let reassigned = 0;
  if (!active) {
    await tx.shift.updateMany({ where: { repId, endedAt: null }, data: { endedAt: now, endedBy: "SYSTEM" } });
    const open = await tx.assignment.findMany({ where: { repId, status: "ACTIVE" }, select: { id: true, doorId: true } });
    for (const a of open) {
      await tx.assignment.update({ where: { id: a.id }, data: { status: "CANCELLED", reason: "Rep deactivated" } });
      await tx.door.update({ where: { id: a.doorId }, data: { status: "GEOCODED" } });
      await enqueue(tx, "door.assign", { doorId: a.doorId, reason: "REP_CHANGE" }, { dedupeKey: `assign:${a.doorId}` });
      await emit(tx, "door.upserted", { door: await doorSnapshot(tx, a.doorId) }, now);
      reassigned++;
    }
  } else {
    await enqueue(tx, "unassignable.retry", {}, { dedupeKey: "unassignable-retry" });
  }
  await audit(tx, actor, active ? "rep.reactivated" : "rep.deactivated", "REP", repId, { reassigned });
  return { reassigned };
}

export async function updateRep(actorUserId: string, repId: string, input: unknown, deps: Geocoder, now = new Date()) {
  const patch = RepUpdate.parse(input);
  const rep = await db().rep.findUnique({ where: { id: repId }, include: { user: true } });
  if (!rep) throw notFound("That rep");

  // The network call happens before the transaction.
  const located = patch.baseAddress && patch.baseAddress !== rep.baseAddress ? await geocodeBase(patch.baseAddress, deps) : null;

  await db().$transaction(async (tx) => {
    const { name, active, baseAddress, workdays, ...rest } = patch;
    await tx.rep.update({
      where: { id: repId },
      data: {
        ...rest,
        ...(workdays ? { workdays: workdays.join(",") } : {}),
        ...(baseAddress !== undefined ? { baseAddress, ...(located ? { baseLat: located.lat, baseLng: located.lng } : {}) } : {}),
      },
    });
    if (name) await tx.user.update({ where: { id: rep.userId }, data: { name } });
    if (active !== undefined && active !== rep.active) {
      await tx.user.update({ where: { id: rep.userId }, data: { active, tokenVersion: { increment: 1 } } });
      await applyRepActive(tx, repId, active, userActor(actorUserId), now);
    }
    await audit(tx, userActor(actorUserId), "rep.updated", "REP", repId, {
      before: { name: rep.user.name, phone: rep.phone, timeZone: rep.timeZone, baseAddress: rep.baseAddress, dailyCapacity: rep.dailyCapacity, workdays: rep.workdays, dayStartLocal: rep.dayStartLocal, active: rep.active },
      after: patch,
    });
  });
  return getRep(repId);
}

export async function listReps() {
  const reps = await db().rep.findMany({ include: { user: { select: { name: true, email: true, lastLoginAt: true } } }, orderBy: [{ active: "desc" }, { user: { name: "asc" } }] });
  return Promise.all(
    reps.map(async (r) => {
      const today = localToday(r.timeZone, new Date());
      const [total, done, daysOff] = await Promise.all([
        db().assignment.count({ where: { repId: r.id, scheduledFor: today, status: { in: ["ACTIVE", "COMPLETED"] } } }),
        db().assignment.count({ where: { repId: r.id, scheduledFor: today, status: "COMPLETED" } }),
        db().repUnavailability.findMany({ where: { repId: r.id, date: { gte: today } }, orderBy: { date: "asc" }, select: { date: true, reason: true } }),
      ]);
      return { ...repView(r), name: r.user.name, email: r.user.email, lastLoginAt: r.user.lastLoginAt, today: { date: today, total, done }, daysOff };
    }),
  );
}

function repView(r: { id: string; phone: string | null; timeZone: string; baseAddress: string | null; baseLat: number | null; baseLng: number | null; dailyCapacity: number; workdays: string; dayStartLocal: string; active: boolean; onShift: boolean; lastLat: number | null; lastLng: number | null; lastLocationAt: Date | null }) {
  return {
    id: r.id,
    phone: r.phone,
    timeZone: r.timeZone,
    baseAddress: r.baseAddress,
    baseLocated: r.baseLat !== null && r.baseLng !== null,
    dailyCapacity: r.dailyCapacity,
    workdays: parseWorkdays(r.workdays),
    dayStartLocal: r.dayStartLocal,
    active: r.active,
    onShift: r.onShift,
    lastLocation: r.lastLat !== null && r.lastLng !== null ? { lat: r.lastLat, lng: r.lastLng, at: r.lastLocationAt } : null,
  };
}

export async function getRep(repId: string) {
  const r = await db().rep.findUnique({ where: { id: repId }, include: { user: { select: { name: true, email: true, lastLoginAt: true } }, unavailability: { orderBy: { date: "asc" } } } });
  if (!r) throw notFound("That rep");
  return {
    ...repView(r),
    name: r.user.name,
    email: r.user.email,
    lastLoginAt: r.user.lastLoginAt,
    unavailability: r.unavailability.map((u) => ({ date: u.date, reason: u.reason })),
  };
}

const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const UnavailabilityCreate = z.object({ dates: z.array(LocalDate).min(1).max(60), reason: z.string().trim().max(200).optional() });

/** Mark dates off (ASN-7): the rep's open assignments on those dates go back through assignment. */
export async function addUnavailability(actorUserId: string, repId: string, input: unknown, now = new Date()) {
  const { dates, reason } = UnavailabilityCreate.parse(input);
  const rep = await db().rep.findUnique({ where: { id: repId } });
  if (!rep) throw notFound("That rep");
  const today = localToday(rep.timeZone, now);
  const future = [...new Set(dates)].filter((d) => d >= today);
  if (future.length === 0) throw validationFailed([{ path: "dates", message: "Pick today or a later date" }]);

  return db().$transaction(async (tx) => {
    for (const date of future) {
      await tx.repUnavailability.upsert({ where: { repId_date: { repId, date } }, create: { repId, date, reason: reason ?? null }, update: { reason: reason ?? null } });
    }
    const open = await tx.assignment.findMany({ where: { repId, status: "ACTIVE", scheduledFor: { in: future } }, select: { id: true, doorId: true } });
    for (const a of open) {
      await tx.assignment.update({ where: { id: a.id }, data: { status: "CANCELLED", reason: "Rep unavailable" } });
      await tx.door.update({ where: { id: a.doorId }, data: { status: "GEOCODED" } });
      await enqueue(tx, "door.assign", { doorId: a.doorId, reason: "REP_CHANGE" }, { dedupeKey: `assign:${a.doorId}` });
      await emit(tx, "door.upserted", { door: await doorSnapshot(tx, a.doorId) }, now);
    }
    await audit(tx, userActor(actorUserId), "rep.unavailability_added", "REP", repId, { dates: future, reason: reason ?? null, reassigned: open.length });
    return { dates: future, reassigned: open.length };
  });
}

export async function removeUnavailability(actorUserId: string, repId: string, date: string) {
  LocalDate.parse(date);
  const row = await db().repUnavailability.findUnique({ where: { repId_date: { repId, date } } });
  if (!row) throw notFound("That day off");
  await db().$transaction(async (tx) => {
    await tx.repUnavailability.delete({ where: { repId_date: { repId, date } } });
    await audit(tx, userActor(actorUserId), "rep.unavailability_removed", "REP", repId, { date });
  });
  return { date };
}

/** The rep's planned day for the console board (PRD MGR-5). */
export async function getRepDay(actorUserId: string, repId: string, date: string, now = new Date()) {
  LocalDate.parse(date);
  const rep = await db().rep.findUnique({ where: { id: repId }, include: { user: { select: { name: true } }, unavailability: { select: { date: true } } } });
  if (!rep) throw notFound("That rep");

  const assignments = await db().assignment.findMany({
    where: { repId, scheduledFor: date, status: { in: ["ACTIVE", "COMPLETED", "SKIPPED"] } },
    orderBy: [{ routeOrder: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    include: { door: { include: { company: { select: { name: true } } } }, visits: { select: { outcome: true, recordedAt: true }, orderBy: { recordedAt: "desc" }, take: 1 } },
  });
  const plan = await db().routePlan.findFirst({ where: { repId, date }, orderBy: { createdAt: "desc" } });
  const detail = plan?.detail ? (JSON.parse(plan.detail) as { plannedFinish?: string | null; late?: number; fallback?: string | null }) : null;
  const shift = await db().shift.findFirst({ where: { repId, date }, orderBy: { startedAt: "desc" } });
  const dayStart = new Date(`${date}T00:00:00Z`);
  const pings = await db().locationPing.findMany({ where: { repId, recordedAt: { gte: new Date(dayStart.getTime() - 14 * 3600_000), lt: new Date(dayStart.getTime() + 38 * 3600_000) } }, orderBy: { recordedAt: "asc" }, select: { lat: true, lng: true, source: true, recordedAt: true } });
  const sampled = pings.filter((_, i) => i % Math.max(1, Math.ceil(pings.length / 100)) === 0);
  // Viewing a rep's location history is audit-logged (backend spec §11).
  if (pings.length > 0) await audit(db(), userActor(actorUserId), "rep.location_viewed", "REP", repId, { date, points: sampled.length });

  const counted = assignments.filter((a) => a.status !== "SKIPPED").length;
  return {
    rep: { id: rep.id, name: rep.user.name, timeZone: rep.timeZone, dailyCapacity: rep.dailyCapacity, isToday: date === localToday(rep.timeZone, now), unavailable: rep.unavailability.some((u) => u.date === date) },
    date,
    overCapacity: counted > rep.dailyCapacity,
    route: plan ? { planId: plan.id, provider: plan.provider, trigger: plan.trigger, status: plan.status, totalDriveMinutes: plan.totalDriveMinutes, plannedFinish: detail?.plannedFinish ?? null, late: detail?.late ?? 0, fallback: detail?.fallback ?? null, createdAt: plan.createdAt } : null,
    shift: shift ? { startedAt: shift.startedAt, endedAt: shift.endedAt, endedBy: shift.endedBy } : null,
    stops: assignments.map((a) => ({
      assignmentId: a.id,
      doorId: a.doorId,
      status: a.status,
      routeOrder: a.routeOrder,
      plannedArrival: a.plannedArrival,
      arrivedAt: a.arrivedAt,
      assignedBy: a.assignedBy,
      driveMinutes: a.driveMinutes,
      name: a.door.company.name,
      address: [a.door.street, a.door.city].filter(Boolean).join(", "),
      priority: a.door.priority,
      doorStatus: a.door.status,
      outcome: a.visits[0]?.outcome ?? null,
    })),
    pings: sampled.map((p) => ({ lat: p.lat, lng: p.lng, source: p.source, at: p.recordedAt })),
  };
}

/** Queue a re-plan (RTE-2). The worker runs it; request handlers never call Google. */
export async function requestReplan(actorUserId: string, repId: string, date: string, now = new Date()) {
  LocalDate.parse(date);
  const rep = await db().rep.findUnique({ where: { id: repId } });
  if (!rep) throw notFound("That rep");
  if (!rep.active) throw conflict("This rep is deactivated.");
  if (date < localToday(rep.timeZone, now)) throw conflict("That day has already passed.");
  await enqueue(db(), "route.plan", { repId, date, trigger: "MANAGER" }, { dedupeKey: `plan:${repId}:${date}:manager` });
  await audit(db(), userActor(actorUserId), "rep.replan_requested", "REP", repId, { date });
  return { queued: true, date };
}


export async function repChoices() {
  const reps = await db().rep.findMany({ where: { active: true }, include: { user: { select: { name: true } } }, orderBy: { user: { name: "asc" } } });
  return reps.map((r) => ({ id: r.id, name: r.user.name, timeZone: r.timeZone, today: localToday(r.timeZone, new Date()) }));
}
