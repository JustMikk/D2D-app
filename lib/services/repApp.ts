// The rep's own day (backend spec §10.2, rep app): Today, start and end of the shift, location pings,
// arrival and re-plan. Every action carries a client-generated clientId, so a retried request returns the
// original result (PRD REP-7). Times come from the device (`recordedAt`), because an action queued
// offline is synced later; they are clamped so a wrong phone clock cannot write the future.
import { createHash } from "node:crypto";
import { z } from "zod";
import { audit, userActor } from "@/lib/api/audit";
import { forbidden, notFound } from "@/lib/api/errors";
import { replayOrRun } from "@/lib/api/idempotency";
import { db } from "@/lib/db";
import type { AssignmentStatus, Outcome } from "@/lib/domain/enums";
import { LOCATION_SOURCES } from "@/lib/domain/enums";
import { haversineMeters } from "@/lib/domain/geo";
import { localToday } from "@/lib/domain/time";
import { getSettings } from "@/lib/settings";
import { planRoute } from "./routes";

const CLOCK_SKEW_MS = 5 * 60_000;

export const FixSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).optional(),
  capturedAt: z.iso.datetime({ offset: true }),
});
export type Fix = z.infer<typeof FixSchema>;

const Stamp = z.iso.datetime({ offset: true });

export const ShiftAction = z.object({ clientId: z.uuid(), location: FixSchema.nullish(), recordedAt: Stamp.optional() });
export const ArriveAction = ShiftAction;
export const PingsBody = z.object({
  pings: z.array(FixSchema.extend({ clientId: z.uuid(), source: z.enum(LOCATION_SOURCES) })).min(1).max(100),
});
export const ReplanBody = z.object({ location: FixSchema.nullish() });

/** The device's time, but never later than now plus a few minutes of clock skew. */
export function deviceTime(stamp: string | undefined, now: Date): Date {
  if (!stamp) return now;
  const t = new Date(stamp);
  return Number.isNaN(t.getTime()) ? now : new Date(Math.min(t.getTime(), now.getTime() + CLOCK_SKEW_MS));
}

export async function repForUser(userId: string) {
  const rep = await db().rep.findUnique({ where: { userId }, include: { user: { select: { name: true, active: true } } } });
  if (!rep || !rep.active || !rep.user.active) throw forbidden("Your rep profile is not active.");
  return rep;
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

export type TodayStop = {
  assignmentId: string;
  status: AssignmentStatus;
  routeOrder: number | null;
  plannedArrival: string | null;
  arrivedAt: string | null;
  outcome: Outcome | null;
  door: {
    id: string;
    name: string;
    companyName: string;
    priority: "NORMAL" | "HOT";
    address: string;
    lat: number;
    lng: number;
    qualificationNotes: string;
    preferredVisitWindow: "MORNING" | "AFTERNOON" | "EVENING" | null;
    attempts: number;
    contactName: string | null;
    lastVisit: { recordedAt: string; outcome: Outcome; notes: string } | null;
  };
};

export type TodayResponse = {
  date: string;
  timeZone: string;
  shift: { id: string; startedAt: string; endedAt: string | null } | null;
  route: { planId: string | null; provider: "LOCAL" | "GOOGLE" | null; totalDriveMinutes: number | null; plannedFinish: string | null; updatedAt: string | null };
  stops: TodayStop[];
  /** Hash of the stop list: the client re-renders only when it changes. */
  pendingServerVersion: string;
};

export async function getToday(userId: string, requestedDate?: string, now = new Date()): Promise<TodayResponse> {
  const rep = await repForUser(userId);
  const date = requestedDate ?? localToday(rep.timeZone, now);
  const assignments = await db().assignment.findMany({
    where: { repId: rep.id, scheduledFor: date, status: { in: ["ACTIVE", "COMPLETED", "SKIPPED"] } },
    orderBy: [{ routeOrder: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    include: {
      door: { include: { company: { select: { name: true } }, visits: { orderBy: { recordedAt: "desc" }, take: 5, select: { recordedAt: true, outcome: true, notes: true, assignmentId: true } } } },
      visits: { orderBy: { recordedAt: "desc" }, take: 1, select: { outcome: true } },
    },
  });

  const stops: TodayStop[] = assignments
    .filter((a) => a.door.lat !== null && a.door.lng !== null)
    .map((a) => {
      const last = a.door.visits.find((v) => v.assignmentId !== a.id);
      return {
        assignmentId: a.id,
        status: a.status as AssignmentStatus,
        routeOrder: a.routeOrder,
        plannedArrival: a.plannedArrival?.toISOString() ?? null,
        arrivedAt: a.arrivedAt?.toISOString() ?? null,
        outcome: (a.visits[0]?.outcome as Outcome | undefined) ?? null,
        door: {
          id: a.door.id,
          name: a.door.name,
          companyName: a.door.company.name,
          priority: a.door.priority as "NORMAL" | "HOT",
          address: [a.door.street, a.door.city, [a.door.state, a.door.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
          lat: a.door.lat!,
          lng: a.door.lng!,
          qualificationNotes: a.door.qualificationNotes,
          preferredVisitWindow: a.door.preferredVisitWindow as TodayStop["door"]["preferredVisitWindow"],
          attempts: a.door.attempts,
          contactName: a.door.contactName,
          lastVisit: last ? { recordedAt: last.recordedAt.toISOString(), outcome: last.outcome as Outcome, notes: last.notes } : null,
        },
      };
    });

  const shift = (await db().shift.findFirst({ where: { repId: rep.id, endedAt: null }, orderBy: { startedAt: "desc" } })) ?? (await db().shift.findFirst({ where: { repId: rep.id, date }, orderBy: { startedAt: "desc" } }));
  const plan = await db().routePlan.findFirst({ where: { repId: rep.id, date }, orderBy: { createdAt: "desc" } });
  const detail = plan?.detail ? (JSON.parse(plan.detail) as { plannedFinish?: string | null }) : null;

  const version = createHash("sha256")
    .update(JSON.stringify(stops.map((s) => [s.assignmentId, s.status, s.routeOrder, s.plannedArrival, s.arrivedAt, s.outcome, s.door.priority])))
    .digest("hex")
    .slice(0, 16);

  return {
    date,
    timeZone: rep.timeZone,
    shift: shift ? { id: shift.id, startedAt: shift.startedAt.toISOString(), endedAt: shift.endedAt?.toISOString() ?? null } : null,
    route: { planId: plan?.id ?? null, provider: (plan?.provider as "LOCAL" | "GOOGLE" | undefined) ?? null, totalDriveMinutes: plan?.totalDriveMinutes ?? null, plannedFinish: detail?.plannedFinish ?? null, updatedAt: plan?.createdAt.toISOString() ?? null },
    stops,
    pendingServerVersion: version,
  };
}

// ---------------------------------------------------------------------------
// Shift
// ---------------------------------------------------------------------------

async function recordFix(tx: Parameters<Parameters<ReturnType<typeof db>["$transaction"]>[0]>[0], repId: string, clientId: string, source: (typeof LOCATION_SOURCES)[number], fix: Fix, now: Date) {
  const at = deviceTime(fix.capturedAt, now);
  await tx.locationPing.upsert({
    where: { clientId },
    create: { clientId, repId, lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM ?? null, source, recordedAt: at },
    update: {},
  });
  const rep = await tx.rep.findUniqueOrThrow({ where: { id: repId }, select: { lastLocationAt: true } });
  if (!rep.lastLocationAt || at > rep.lastLocationAt) {
    await tx.rep.update({ where: { id: repId }, data: { lastLat: fix.lat, lastLng: fix.lng, lastAccuracyM: fix.accuracyM ?? null, lastLocationAt: at, lastLocationSource: source } });
  }
}

export async function startShift(userId: string, input: unknown, now = new Date()) {
  const body = ShiftAction.parse(input);
  const rep = await repForUser(userId);
  return replayOrRun(userId, body.clientId, "POST", "/rep/shift/start", () =>
    db().$transaction(async (tx) => {
      const open = await tx.shift.findFirst({ where: { repId: rep.id, endedAt: null }, orderBy: { startedAt: "desc" } });
      if (open) return { status: 200, body: { shift: { id: open.id, startedAt: open.startedAt.toISOString(), endedAt: null } } };
      const at = deviceTime(body.recordedAt, now);
      const shift = await tx.shift.create({
        data: { repId: rep.id, date: localToday(rep.timeZone, at), startedAt: at, startLat: body.location?.lat ?? null, startLng: body.location?.lng ?? null },
      });
      await tx.rep.update({ where: { id: rep.id }, data: { onShift: true } });
      if (body.location) await recordFix(tx, rep.id, `${body.clientId}:start`, "START_DAY", body.location, now);
      await audit(tx, userActor(userId), "rep.day_started", "REP", rep.id, { date: shift.date });
      return { status: 201, body: { shift: { id: shift.id, startedAt: shift.startedAt.toISOString(), endedAt: null } } };
    }),
  );
}

export async function endShift(userId: string, input: unknown, now = new Date()) {
  const body = ShiftAction.parse(input);
  const rep = await repForUser(userId);
  return replayOrRun(userId, body.clientId, "POST", "/rep/shift/end", () =>
    db().$transaction(async (tx) => {
      const at = deviceTime(body.recordedAt, now);
      const open = await tx.shift.findFirst({ where: { repId: rep.id, endedAt: null }, orderBy: { startedAt: "desc" } });
      if (open) {
        await tx.shift.update({ where: { id: open.id }, data: { endedAt: at, endedBy: "REP", endLat: body.location?.lat ?? null, endLng: body.location?.lng ?? null } });
      }
      await tx.rep.update({ where: { id: rep.id }, data: { onShift: false } });
      if (body.location) await recordFix(tx, rep.id, `${body.clientId}:end`, "END_DAY", body.location, now);
      const date = open?.date ?? localToday(rep.timeZone, now);
      const remainingStops = await tx.assignment.count({ where: { repId: rep.id, scheduledFor: date, status: "ACTIVE" } });
      await audit(tx, userActor(userId), "rep.day_ended", "REP", rep.id, { date, remainingStops });
      return { status: 200, body: { remainingStops } };
    }),
  );
}

/**
 * Location pings (PRD REP-8): accepted only while on shift, except END_DAY. A ping outside a shift is
 * ignored rather than failing the batch, so a late queued ping can never wedge the app's queue.
 */
export async function recordPings(userId: string, input: unknown, now = new Date()) {
  const { pings } = PingsBody.parse(input);
  const rep = await repForUser(userId);
  const existing = new Set((await db().locationPing.findMany({ where: { clientId: { in: pings.map((p) => p.clientId) } }, select: { clientId: true } })).map((p) => p.clientId));
  const fresh = pings.filter((p) => !existing.has(p.clientId));
  const allowed = fresh.filter((p) => rep.onShift || p.source === "END_DAY");
  if (allowed.length > 0) {
    await db().$transaction(async (tx) => {
      for (const p of allowed.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))) await recordFix(tx, rep.id, p.clientId, p.source, p, now);
    });
  }
  return { accepted: allowed.length, duplicates: pings.length - fresh.length, ignored: fresh.length - allowed.length };
}

// ---------------------------------------------------------------------------
// Arrival and re-plan
// ---------------------------------------------------------------------------

export async function arrive(userId: string, assignmentId: string, input: unknown, now = new Date()) {
  const body = ArriveAction.parse(input);
  const rep = await repForUser(userId);
  const assignment = await db().assignment.findUnique({ where: { id: assignmentId }, include: { door: { select: { lat: true, lng: true } } } });
  if (!assignment || assignment.repId !== rep.id) throw notFound("That stop");
  const { "visit.arrivalRadiusMeters": radius } = await getSettings();

  return replayOrRun(userId, body.clientId, "POST", `/rep/assignments/${assignmentId}/arrive`, () =>
    db().$transaction(async (tx) => {
      // Arriving twice keeps the first arrival.
      if (assignment.arrivedAt) {
        const d = assignment.arrivedDistM;
        return { status: 200, body: { distanceM: d === null ? null : Math.round(d), offSite: d === null || d > radius } };
      }
      const distance = body.location && assignment.door.lat !== null && assignment.door.lng !== null ? haversineMeters(body.location, { lat: assignment.door.lat, lng: assignment.door.lng }) : null;
      const offSite = distance === null || distance > radius;
      await tx.assignment.update({
        where: { id: assignmentId },
        data: { arrivedAt: deviceTime(body.recordedAt ?? body.location?.capturedAt, now), arrivedLat: body.location?.lat ?? null, arrivedLng: body.location?.lng ?? null, arrivedDistM: distance },
      });
      if (body.location) await recordFix(tx, rep.id, `${body.clientId}:arrive`, "ARRIVED", body.location, now);
      await audit(tx, userActor(userId), "rep.arrived", "ASSIGNMENT", assignmentId, { distanceM: distance === null ? null : Math.round(distance), offSite });
      return { status: 200, body: { distanceM: distance === null ? null : Math.round(distance), offSite } };
    }),
  );
}

/** "Re-plan from here" (RTE-2): today's route from the rep's current fix, always with the built-in planner. */
export async function replanFromHere(userId: string, input: unknown, now = new Date()) {
  const { location } = ReplanBody.parse(input);
  const rep = await repForUser(userId);
  const date = localToday(rep.timeZone, now);
  await planRoute({ repId: rep.id, date, trigger: "REP", start: location ? { lat: location.lat, lng: location.lng } : undefined, forceLocal: true }, { optimizeTours: async () => Promise.reject(new Error("not used")) }, now);
  await audit(db(), userActor(userId), "rep.replan_requested", "REP", rep.id, { date });
  return getToday(userId, date, now);
}
