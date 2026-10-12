// Local route provider (backend spec §6.6, PRD RTE-1 to RTE-3): window buckets, nearest-neighbor
// construction with hot doors first, then 2-opt inside each bucket. Nothing is ever dropped.
import type { Priority, VisitWindow } from "../enums";
import { estimateDriveMinutes, haversineMeters, type LatLng } from "../geo";
import type { TravelSettings } from "../settings";
import { atLocal } from "../time";

export type RouteStopInput = LatLng & {
  /** Assignment ID. */
  id: string;
  priority: Priority;
  window: VisitWindow | null;
};

export type RoutePlanInput = {
  start: LatLng;
  /** When the rep leaves the start point (day start, or now for a re-plan). */
  startAt: Date;
  timeZone: string;
  /** Local date being planned (YYYY-MM-DD). */
  date: string;
  /** Local day start ("HH:mm"); the morning window opens here. */
  dayStartLocal: string;
  stops: readonly RouteStopInput[];
  /** routeOrder of the first planned stop. Visited stops keep their order, so a re-plan starts after them. */
  firstOrder?: number;
  settings: TravelSettings & { visitDurationMinutes: number };
  /** Travel minutes between two points. Defaults to the haversine estimate. */
  travelMinutes?: (a: LatLng, b: LatLng) => number;
  /** Run the 2-opt improvement pass (default true). Off only to compare against plain construction. */
  improve?: boolean;
};

export type PlannedStop = {
  id: string;
  routeOrder: number;
  plannedArrival: Date;
  travelMinutes: number;
  /** Planned after 20:00 local. */
  late: boolean;
};

export type RoutePlanResult = {
  stops: PlannedStop[];
  totalDriveMinutes: number;
  totalDistanceM: number;
  plannedFinish: Date | null;
  status: "OK" | "PARTIAL";
};

type Bucket = "MORNING" | "AFTERNOON" | "EVENING" | "ANY";
const BUCKET_ORDER: readonly Bucket[] = ["MORNING", "AFTERNOON", "EVENING", "ANY"];
const DAY_END = "20:00";

export function planLocalRoute(input: RoutePlanInput): RoutePlanResult {
  const travel = input.travelMinutes ?? ((a: LatLng, b: LatLng) => estimateDriveMinutes(a, b, input.settings));
  const firstOrder = input.firstOrder ?? 1;
  if (input.stops.length === 0) {
    return { stops: [], totalDriveMinutes: 0, totalDistanceM: 0, plannedFinish: null, status: "OK" };
  }

  // 1. Buckets. Unwindowed stops join the windowed bucket they are nearest to; with no windowed
  //    stops at all, everything is one "any time" bucket.
  const buckets = new Map<Bucket, RouteStopInput[]>(BUCKET_ORDER.map((b) => [b, []]));
  const unwindowed: RouteStopInput[] = [];
  for (const s of input.stops) {
    if (s.window) buckets.get(s.window)!.push(s);
    else unwindowed.push(s);
  }
  const windowed = (["MORNING", "AFTERNOON", "EVENING"] as const).filter((b) => buckets.get(b)!.length > 0);
  for (const s of unwindowed) {
    if (windowed.length === 0) {
      buckets.get("ANY")!.push(s);
      continue;
    }
    let bestBucket: Bucket = windowed[0]!;
    let bestDist = Infinity;
    for (const b of windowed) {
      for (const m of buckets.get(b)!) {
        const d = travel(s, m);
        if (d < bestDist) [bestDist, bestBucket] = [d, b];
      }
    }
    buckets.get(bestBucket)!.push(s);
  }

  // 2. Nearest-neighbor construction: within each bucket, hot stops first, then the rest.
  const segments: { hot: RouteStopInput[]; rest: RouteStopInput[] }[] = [];
  let cursor: LatLng = input.start;
  for (const b of BUCKET_ORDER) {
    const members = buckets.get(b)!;
    if (members.length === 0) continue;
    const hot = nearestNeighbor(cursor, members.filter((s) => s.priority === "HOT"), travel);
    const restStart = hot.at(-1) ?? cursor;
    const rest = nearestNeighbor(restStart, members.filter((s) => s.priority !== "HOT"), travel);
    segments.push({ hot, rest });
    cursor = rest.at(-1) ?? hot.at(-1) ?? cursor;
  }

  // 3. 2-opt on the non-hot part of each bucket; bucket order and hot-first never change.
  if (input.improve ?? true) twoOpt(input.start, segments, travel);

  // 4. Times: wait for a window to open; each visit takes visitDurationMinutes.
  const order = segments.flatMap((s) => [...s.hot, ...s.rest]);
  const windowOpen: Record<VisitWindow, Date> = {
    MORNING: atLocal(input.timeZone, input.date, input.dayStartLocal),
    AFTERNOON: atLocal(input.timeZone, input.date, "12:00"),
    EVENING: atLocal(input.timeZone, input.date, "17:00"),
  };
  const dayEnd = atLocal(input.timeZone, input.date, DAY_END);

  const stops: PlannedStop[] = [];
  let prev: LatLng = input.start;
  let departMs = input.startAt.getTime();
  let totalMinutes = 0;
  let totalMeters = 0;
  order.forEach((s, i) => {
    const minutes = travel(prev, s);
    totalMinutes += minutes;
    totalMeters += haversineMeters(prev, s) * input.settings.roadFactor;
    let arriveMs = departMs + minutes * 60_000;
    if (s.window) arriveMs = Math.max(arriveMs, windowOpen[s.window].getTime());
    const plannedArrival = new Date(Math.round(arriveMs / 60_000) * 60_000);
    stops.push({
      id: s.id,
      routeOrder: firstOrder + i,
      plannedArrival,
      travelMinutes: Math.round(minutes),
      late: plannedArrival.getTime() > dayEnd.getTime(),
    });
    departMs = arriveMs + input.settings.visitDurationMinutes * 60_000;
    prev = s;
  });

  return {
    stops,
    totalDriveMinutes: Math.round(totalMinutes),
    totalDistanceM: Math.round(totalMeters),
    plannedFinish: new Date(departMs),
    status: stops.some((s) => s.late) ? "PARTIAL" : "OK",
  };
}

function nearestNeighbor<T extends LatLng>(from: LatLng, items: readonly T[], travel: (a: LatLng, b: LatLng) => number): T[] {
  const remaining = [...items];
  const out: T[] = [];
  let here = from;
  while (remaining.length > 0) {
    let bestIndex = 0;
    let best = Infinity;
    remaining.forEach((s, i) => {
      const d = travel(here, s);
      if (d < best) [best, bestIndex] = [d, i];
    });
    const [next] = remaining.splice(bestIndex, 1);
    out.push(next!);
    here = next!;
  }
  return out;
}

/** Total travel along start → every stop in order. */
export function routeLength(start: LatLng, order: readonly LatLng[], travel: (a: LatLng, b: LatLng) => number): number {
  let total = 0;
  let prev = start;
  for (const s of order) {
    total += travel(prev, s);
    prev = s;
  }
  return total;
}

/**
 * Reverse sub-ranges of each bucket's non-hot tail while that shortens the whole route.
 * Passes repeat until one improves the total by 1% or less.
 */
function twoOpt(
  start: LatLng,
  segments: { hot: RouteStopInput[]; rest: RouteStopInput[] }[],
  travel: (a: LatLng, b: LatLng) => number,
): void {
  const flatten = () => segments.flatMap((s) => [...s.hot, ...s.rest]);
  let total = routeLength(start, flatten(), travel);
  for (let pass = 0; pass < 50; pass++) {
    const before = total;
    for (const seg of segments) {
      const n = seg.rest.length;
      for (let i = 0; i < n - 1; i++) {
        for (let j = i + 1; j < n; j++) {
          const original = seg.rest;
          seg.rest = [...original.slice(0, i), ...original.slice(i, j + 1).reverse(), ...original.slice(j + 1)];
          const candidate = routeLength(start, flatten(), travel);
          if (candidate < total - 1e-9) total = candidate;
          else seg.rest = original;
        }
      }
    }
    if (before - total <= before * 0.01) break;
  }
}
