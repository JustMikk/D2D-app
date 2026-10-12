// A manager reorders a rep's remaining stops on the day board (PRD MGR-5, P1). The new order is saved with
// planned arrival times worked out from it (same travel and visit-time rules as the route planner).
import { z } from "zod";
import { audit, userActor } from "@/lib/api/audit";
import { conflict, notFound, validationFailed } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { estimateDriveMinutes, haversineMeters, type LatLng } from "@/lib/domain/geo";
import { atLocal, localToday } from "@/lib/domain/time";
import { doorSnapshot, emit } from "@/lib/events";
import { getSettings } from "@/lib/settings";

export const ReorderBody = z.object({ assignmentIds: z.array(z.string()).min(1).max(100) });

export async function reorderStops(actorUserId: string, repId: string, date: string, input: unknown, now = new Date()) {
  const { assignmentIds } = ReorderBody.parse(input);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw validationFailed([{ path: "date", message: "Use YYYY-MM-DD" }]);
  const rep = await db().rep.findUnique({ where: { id: repId } });
  if (!rep) throw notFound("That rep");
  if (date < localToday(rep.timeZone, now)) throw conflict("That day has already passed.");
  const settings = await getSettings();

  return db().$transaction(async (tx) => {
    const all = await tx.assignment.findMany({
      where: { repId, scheduledFor: date, status: { in: ["ACTIVE", "COMPLETED", "SKIPPED"] } },
      include: { door: { select: { lat: true, lng: true } } },
    });
    const open = all.filter((a) => a.status === "ACTIVE");
    // The list must be exactly the stops that are still open: a stale screen cannot silently drop or add one.
    const same = open.length === assignmentIds.length && open.every((a) => assignmentIds.includes(a.id)) && new Set(assignmentIds).size === assignmentIds.length;
    if (!same) throw conflict("This day changed while you were editing. Refresh and try again.");

    const firstOrder = Math.max(0, ...all.filter((a) => a.status !== "ACTIVE").map((a) => a.routeOrder ?? 0)) + 1;
    const byId = new Map(open.map((a) => [a.id, a]));
    const base: LatLng | null = rep.baseLat !== null && rep.baseLng !== null ? { lat: rep.baseLat, lng: rep.baseLng } : null;
    const dayStart = atLocal(rep.timeZone, date, rep.dayStartLocal);
    const travel = { roadFactor: settings["routing.roadFactor"], avgSpeedMph: settings["routing.avgSpeedMph"] };

    let prev: LatLng | null = base;
    let clock = Math.max(dayStart.getTime(), date === localToday(rep.timeZone, now) ? now.getTime() : 0);
    let totalMinutes = 0;
    let totalMeters = 0;
    for (const [i, id] of assignmentIds.entries()) {
      const a = byId.get(id)!;
      const here: LatLng | null = a.door.lat !== null && a.door.lng !== null ? { lat: a.door.lat, lng: a.door.lng } : null;
      if (prev && here) {
        const minutes = estimateDriveMinutes(prev, here, travel);
        totalMinutes += minutes;
        totalMeters += haversineMeters(prev, here) * travel.roadFactor;
        clock += minutes * 60_000;
      }
      const arrival = new Date(Math.round(clock / 60_000) * 60_000);
      const changed = a.routeOrder !== firstOrder + i || a.plannedArrival?.getTime() !== arrival.getTime();
      await tx.assignment.update({ where: { id }, data: { routeOrder: firstOrder + i, plannedArrival: arrival } });
      await tx.door.updateMany({ where: { id: a.doorId, status: { in: ["ASSIGNED", "SCHEDULED"] } }, data: { status: "SCHEDULED" } });
      if (changed) await emit(tx, "door.upserted", { door: await doorSnapshot(tx, a.doorId) }, now);
      clock += settings["routing.visitDurationMinutes"] * 60_000;
      if (here) prev = here;
    }
    await tx.routePlan.create({
      data: { repId, date, provider: "LOCAL", trigger: "MANAGER", status: "OK", startLat: base?.lat ?? 0, startLng: base?.lng ?? 0, totalDriveMinutes: Math.round(totalMinutes), totalDistanceM: Math.round(totalMeters), detail: JSON.stringify({ manualOrder: true, plannedFinish: new Date(clock).toISOString() }) },
    });
    await audit(tx, userActor(actorUserId), "route.reordered", "REP", repId, { date, order: assignmentIds });
    return { date, stops: assignmentIds.length };
  });
}
