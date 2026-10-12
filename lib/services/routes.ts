// Route planning service (backend spec §6.6, PRD RTE-1 to RTE-3): picks the start point and time, runs
// the provider (local heuristic, or Google with a local fallback), and writes the plan.
import { db } from "@/lib/db";
import type { RouteTrigger } from "@/lib/domain/enums";
import { estimateDriveMinutes, haversineMeters, type LatLng } from "@/lib/domain/geo";
import { planLocalRoute, routeLength, type PlannedStop, type RoutePlanResult } from "@/lib/domain/routing/local";
import { atLocal } from "@/lib/domain/time";
import { doorSnapshot, emit } from "@/lib/events";
import type { GoogleClients } from "@/lib/integrations/google";
import { enqueue } from "@/lib/jobs";
import { getSettings } from "@/lib/settings";

export type PlanOutcome = { kind: "planned"; planId: string; stops: number; status: "OK" | "PARTIAL"; provider: "LOCAL" | "GOOGLE"; fallback: string | null } | { kind: "skipped"; why: string };

const DAY_END = "20:00";

export async function planRoute(
  input: { repId: string; date: string; trigger: RouteTrigger; start?: LatLng; /** Skip Google: the rep's phone is waiting on this request. */ forceLocal?: boolean },
  google: Pick<GoogleClients, "optimizeTours">,
  now = new Date(),
): Promise<PlanOutcome> {
  const rep = await db().rep.findUnique({ where: { id: input.repId }, include: { user: { select: { id: true } } } });
  if (!rep || !rep.active) return { kind: "skipped", why: "rep is not active" };
  const settings = await getSettings();

  const all = await db().assignment.findMany({
    where: { repId: rep.id, scheduledFor: input.date, status: { in: ["ACTIVE", "COMPLETED", "SKIPPED"] } },
    include: { door: { select: { id: true, lat: true, lng: true, priority: true, preferredVisitWindow: true, name: true } } },
  });
  const active = all.filter((a) => a.status === "ACTIVE" && a.door.lat !== null && a.door.lng !== null);
  // Visited (or skipped) stops keep their order; the new plan continues after them.
  const firstOrder = Math.max(0, ...all.filter((a) => a.status !== "ACTIVE").map((a) => a.routeOrder ?? 0)) + 1;

  // Start: an explicit fix, or (when the rep is on shift with a fresh fix) where they are now, or the
  // deployment base at the start of the day.
  const staleMs = settings["assignment.locationStalenessMinutes"] * 60_000;
  const fresh = rep.onShift && rep.lastLat !== null && rep.lastLng !== null && rep.lastLocationAt && now.getTime() - rep.lastLocationAt.getTime() <= staleMs;
  const here: LatLng | null = input.start ?? (fresh ? { lat: rep.lastLat!, lng: rep.lastLng! } : null);
  const base: LatLng | null = rep.baseLat !== null && rep.baseLng !== null ? { lat: rep.baseLat, lng: rep.baseLng } : null;
  const start = here ?? base;
  if (!start && active.length > 0) return { kind: "skipped", why: "rep has no deployment base and no location" };

  const dayStart = atLocal(rep.timeZone, input.date, rep.dayStartLocal);
  const startAt = here ? now : new Date(Math.max(dayStart.getTime(), now.getTime()));

  const provider = input.forceLocal ? "LOCAL" : settings["routing.provider"];
  const travel = { roadFactor: settings["routing.roadFactor"], avgSpeedMph: settings["routing.avgSpeedMph"] };
  const visitMinutes = settings["routing.visitDurationMinutes"];
  const stops = active.map((a) => ({ id: a.id, lat: a.door.lat!, lng: a.door.lng!, priority: a.door.priority as "NORMAL" | "HOT", window: a.door.preferredVisitWindow as "MORNING" | "AFTERNOON" | "EVENING" | null }));
  const local = () =>
    planLocalRoute({ start: start!, startAt, timeZone: rep.timeZone, date: input.date, dayStartLocal: rep.dayStartLocal, stops, firstOrder, settings: { ...travel, visitDurationMinutes: visitMinutes } });

  let result: RoutePlanResult;
  let usedProvider: "LOCAL" | "GOOGLE" = "LOCAL";
  let fallback: string | null = null;
  let skippedCount = 0;
  if (stops.length === 0) {
    result = { stops: [], totalDriveMinutes: 0, totalDistanceM: 0, plannedFinish: null, status: "OK" };
  } else if (provider === "GOOGLE") {
    try {
      const g = await google.optimizeTours({
        start: start!,
        startAt,
        timeZone: rep.timeZone,
        date: input.date,
        dayStartLocal: rep.dayStartLocal,
        visitDurationMinutes: visitMinutes,
        stops: stops.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng, hot: s.priority === "HOT", window: s.window })),
      });
      const byId = new Map(stops.map((s) => [s.id, s]));
      const visited = g.visits.filter((v) => byId.has(v.id));
      const seen = new Set(visited.map((v) => v.id));
      const skipped = stops.filter((s) => !seen.has(s.id)).map((s) => s.id);
      skippedCount = skipped.length;
      // Skipped shipments keep their assignment and go at the end, flagged late.
      const order = [...visited.map((v) => ({ id: v.id, at: v.startTime })), ...skipped.map((id) => ({ id, at: null as Date | null }))];
      const dayEnd = atLocal(rep.timeZone, input.date, DAY_END);
      const planned: PlannedStop[] = [];
      let prev: LatLng = start!;
      let prevDepart = startAt.getTime();
      order.forEach((o, i) => {
        const s = byId.get(o.id)!;
        const leg = estimateDriveMinutes(prev, s, travel);
        const at = o.at ?? new Date(prevDepart + leg * 60_000);
        planned.push({ id: o.id, routeOrder: firstOrder + i, plannedArrival: at, travelMinutes: Math.round(leg), late: o.at === null || at.getTime() > dayEnd.getTime() });
        prevDepart = at.getTime() + visitMinutes * 60_000;
        prev = s;
      });
      const ordered = planned.map((p) => byId.get(p.id)!);
      result = {
        stops: planned,
        totalDriveMinutes: Math.round(routeLength(start!, ordered, (a, b) => estimateDriveMinutes(a, b, travel))),
        totalDistanceM: Math.round(ordered.reduce((m, s, i) => m + haversineMeters(i === 0 ? start! : ordered[i - 1]!, s) * travel.roadFactor, 0)),
        plannedFinish: new Date(prevDepart),
        status: planned.some((p) => p.late) ? "PARTIAL" : "OK",
      };
      usedProvider = "GOOGLE";
    } catch (error) {
      fallback = error instanceof Error ? error.message : String(error);
      console.warn(`[route] Google route optimization failed, using the local planner: ${fallback}`);
      result = local();
    }
  } else {
    result = local();
  }

  const byAssignment = new Map(active.map((a) => [a.id, a]));
  const planId = await db().$transaction(async (tx) => {
    const plan = await tx.routePlan.create({
      data: {
        repId: rep.id,
        date: input.date,
        provider: usedProvider,
        trigger: input.trigger,
        status: result.status,
        startLat: start?.lat ?? 0,
        startLng: start?.lng ?? 0,
        totalDriveMinutes: result.totalDriveMinutes,
        totalDistanceM: result.totalDistanceM,
        skippedCount,
        detail: JSON.stringify({ plannedFinish: result.plannedFinish?.toISOString() ?? null, late: result.stops.filter((s) => s.late).length, fallback, startedFrom: here ? "location" : "base" }),
      },
    });
    for (const s of result.stops) {
      const a = byAssignment.get(s.id)!;
      // Skip anything that stopped being ACTIVE while the plan was computed.
      const updated = await tx.assignment.updateMany({
        where: { id: s.id, status: "ACTIVE" },
        data: { routeOrder: s.routeOrder, plannedArrival: s.plannedArrival, routePlanId: plan.id },
      });
      if (updated.count !== 1) continue;
      const changed = a.routeOrder !== s.routeOrder || a.plannedArrival?.getTime() !== s.plannedArrival.getTime();
      await tx.door.updateMany({ where: { id: a.doorId, status: { in: ["ASSIGNED", "SCHEDULED"] } }, data: { status: "SCHEDULED" } });
      if (changed) await emit(tx, "door.upserted", { door: await doorSnapshot(tx, a.doorId) }, now);
    }
    // The rep is told when their route changed under them; the scheduled 06:30 plan and their own
    // re-plan are not news, and a hot door has its own push.
    if ((input.trigger === "MANAGER" || input.trigger === "NEW_TODAY") && result.stops.length > 0) {
      await enqueue(tx, "push.send", { userId: rep.user.id, title: "Your route changed", body: `${result.stops.length} stops left today`, url: "/today", tag: `route-${input.date}` });
    }
    return plan.id;
  });

  return { kind: "planned", planId, stops: result.stops.length, status: result.status, provider: usedProvider, fallback };
}
