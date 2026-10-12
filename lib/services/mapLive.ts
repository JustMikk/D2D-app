// The manager's live map (PRD MGR-1; backend spec §10.2 GET /map/live, §10.4 RepMarker and DoorPin).
import { z } from "zod";
import { db } from "@/lib/db";
import { DoorStatus } from "@/lib/domain/enums";
import { localToday } from "@/lib/domain/time";
import type { Prisma } from "@/lib/generated/prisma/client";

export const MapLiveQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  repId: z.string().optional(),
  status: DoorStatus.optional(),
});

export type Freshness = "FRESH" | "AGING" | "STALE" | "NONE";

/** Under 15 minutes is fresh, up to 120 is aging, older is stale; no location at all is none. */
export function freshnessOf(lastLocationAt: Date | null, now: Date): Freshness {
  if (!lastLocationAt) return "NONE";
  const minutes = (now.getTime() - lastLocationAt.getTime()) / 60_000;
  return minutes < 15 ? "FRESH" : minutes <= 120 ? "AGING" : "STALE";
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase();
}

export type RepMarker = {
  repId: string;
  name: string;
  initials: string;
  onShift: boolean;
  lat: number | null;
  lng: number | null;
  lastLocationAt: string | null;
  freshness: Freshness;
  todayDone: number;
  todayTotal: number;
  date: string;
};

export type DoorPin = {
  doorId: string;
  lat: number;
  lng: number;
  status: DoorStatus;
  priority: "NORMAL" | "HOT";
  repId: string | null;
  routeOrder: number | null;
  name: string;
};

const MAX_PINS = 2000;

/**
 * Reps with their last known location and the day's progress, and the doors to draw: those on a rep's route
 * for the date, plus open doors still waiting for a rep. `date` defaults to each rep's own local today.
 */
export async function getLiveMap(query: z.infer<typeof MapLiveQuery>, now = new Date()) {
  const reps = await db().rep.findMany({
    where: { active: true, ...(query.repId ? { id: query.repId } : {}) },
    include: { user: { select: { name: true } } },
    orderBy: { user: { name: "asc" } },
  });

  const dateFor = new Map(reps.map((r) => [r.id, query.date ?? localToday(r.timeZone, now)]));
  const markers: RepMarker[] = [];
  const pins = new Map<string, DoorPin>();

  for (const r of reps) {
    const date = dateFor.get(r.id)!;
    const assignments = await db().assignment.findMany({
      where: { repId: r.id, scheduledFor: date, status: { in: ["ACTIVE", "COMPLETED"] }, ...(query.status ? { door: { status: query.status } } : {}) },
      include: { door: { select: { id: true, name: true, lat: true, lng: true, status: true, priority: true } } },
      orderBy: [{ routeOrder: { sort: "asc", nulls: "last" } }],
    });
    const all = await db().assignment.findMany({ where: { repId: r.id, scheduledFor: date, status: { in: ["ACTIVE", "COMPLETED"] } }, select: { status: true } });
    markers.push({
      repId: r.id,
      name: r.user.name,
      initials: initialsOf(r.user.name),
      onShift: r.onShift,
      lat: r.lastLat,
      lng: r.lastLng,
      lastLocationAt: r.lastLocationAt?.toISOString() ?? null,
      freshness: freshnessOf(r.lastLocationAt, now),
      todayDone: all.filter((a) => a.status === "COMPLETED").length,
      todayTotal: all.length,
      date,
    });
    for (const a of assignments) {
      if (a.door.lat === null || a.door.lng === null) continue;
      pins.set(a.door.id, { doorId: a.door.id, lat: a.door.lat, lng: a.door.lng, status: a.door.status as DoorStatus, priority: a.door.priority as "NORMAL" | "HOT", repId: r.id, routeOrder: a.routeOrder, name: a.door.name });
    }
  }

  // Open doors nobody has yet (waiting, or no rep nearby): shown unless the map is filtered to one rep.
  if (!query.repId) {
    const where: Prisma.DoorWhereInput = {
      lat: { not: null },
      lng: { not: null },
      assignments: { none: { status: "ACTIVE" } },
      status: query.status ? query.status : { in: ["GEOCODED", "UNASSIGNABLE"] },
    };
    for (const d of await db().door.findMany({ where, take: MAX_PINS - pins.size, orderBy: { updatedAt: "desc" }, select: { id: true, name: true, lat: true, lng: true, status: true, priority: true } })) {
      if (!pins.has(d.id)) pins.set(d.id, { doorId: d.id, lat: d.lat!, lng: d.lng!, status: d.status as DoorStatus, priority: d.priority as "NORMAL" | "HOT", repId: null, routeOrder: null, name: d.name });
    }
  }

  const reviewCount = await db().door.count({ where: { status: "NEEDS_REVIEW" } });
  return { reps: markers, doors: [...pins.values()].slice(0, MAX_PINS), reviewCount, generatedAt: now.toISOString() };
}
