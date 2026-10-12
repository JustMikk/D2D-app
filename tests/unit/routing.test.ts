import { describe, expect, it } from "vitest";
import type { LatLng } from "@/lib/domain/geo";
import { planLocalRoute, routeLength, type RoutePlanInput, type RouteStopInput } from "@/lib/domain/routing/local";
import { estimateDriveMinutes } from "@/lib/domain/geo";

const TZ = "America/Chicago";
const DATE = "2026-10-07";
const START = { lat: 32.78, lng: -96.8 }; // Dallas
const SETTINGS = { visitDurationMinutes: 20, roadFactor: 1.3, avgSpeedMph: 30 };
const DAY_START = new Date("2026-10-07T14:00:00Z"); // 09:00 CDT

function plan(stops: RouteStopInput[], over: Partial<RoutePlanInput> = {}) {
  return planLocalRoute({ start: START, startAt: DAY_START, timeZone: TZ, date: DATE, dayStartLocal: "09:00", stops, settings: SETTINGS, ...over });
}

const stop = (id: string, lat: number, lng: number, over: Partial<RouteStopInput> = {}): RouteStopInput => ({
  id,
  lat,
  lng,
  priority: "NORMAL",
  window: null,
  ...over,
});

/** A deterministic pseudo-random generator so the property test is reproducible. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s / 2 ** 31;
  };
}

describe("planLocalRoute", () => {
  it("returns an empty plan for no stops", () => {
    expect(plan([])).toEqual({ stops: [], totalDriveMinutes: 0, totalDistanceM: 0, plannedFinish: null, status: "OK" });
  });

  it("keeps window buckets in order: morning, afternoon, evening", () => {
    const r = plan([
      stop("eve", 32.79, -96.8, { window: "EVENING" }),
      stop("aft", 32.781, -96.8, { window: "AFTERNOON" }),
      stop("mor", 33.2, -96.8, { window: "MORNING" }), // far, but morning goes first
    ]);
    expect(r.stops.map((s) => s.id)).toEqual(["mor", "aft", "eve"]);
  });

  it("puts hot doors first in their bucket", () => {
    const r = plan([stop("near", 32.781, -96.8), stop("mid", 32.85, -96.8), stop("hotfar", 33.1, -96.8, { priority: "HOT" })]);
    expect(r.stops[0]!.id).toBe("hotfar");
    expect(r.stops).toHaveLength(3);
  });

  it("places unwindowed stops in the bucket they are nearest to", () => {
    const r = plan([
      stop("mor", 32.8, -96.8, { window: "MORNING" }),
      stop("aft", 33.3, -96.8, { window: "AFTERNOON" }),
      stop("free", 33.31, -96.8), // right next to the afternoon stop
    ]);
    expect(r.stops.map((s) => s.id)).toEqual(["mor", "aft", "free"]);
  });

  it("waits for a window to open", () => {
    const r = plan([stop("aft", 32.79, -96.8, { window: "AFTERNOON" })]);
    expect(r.stops[0]!.plannedArrival.toISOString()).toBe("2026-10-07T17:00:00.000Z"); // 12:00 CDT
  });

  it("computes arrivals from travel and visit time", () => {
    const a = stop("a", 32.88, -96.8);
    const b = stop("b", 32.98, -96.8);
    const r = plan([a, b]);
    const legA = estimateDriveMinutes(START, a, SETTINGS);
    const legB = estimateDriveMinutes(a, b, SETTINGS);
    expect(r.stops[0]!.plannedArrival.getTime()).toBe(Math.round((DAY_START.getTime() + legA * 60_000) / 60_000) * 60_000);
    const expectedB = DAY_START.getTime() + (legA + 20 + legB) * 60_000;
    expect(Math.abs(r.stops[1]!.plannedArrival.getTime() - expectedB)).toBeLessThanOrEqual(30_000);
    expect(r.totalDriveMinutes).toBe(Math.round(legA + legB));
  });

  it("flags late stops and never drops them", () => {
    const stops = Array.from({ length: 12 }, (_, i) => stop(`s${i}`, 32.78 + i * 0.05, -96.8));
    const r = plan(stops, { settings: { ...SETTINGS, visitDurationMinutes: 75 } });
    expect(r.stops).toHaveLength(12);
    expect(r.status).toBe("PARTIAL");
    expect(r.stops.some((s) => s.late)).toBe(true);
    expect(r.stops.at(-1)!.late).toBe(true);
    expect(r.stops[0]!.late).toBe(false);
  });

  it("numbers stops from firstOrder", () => {
    const r = plan([stop("a", 32.8, -96.8), stop("b", 32.9, -96.8)], { firstOrder: 4 });
    expect(r.stops.map((s) => s.routeOrder)).toEqual([4, 5]);
  });

  it("2-opt is never worse than nearest-neighbor", () => {
    const travel = (a: LatLng, b: LatLng) => estimateDriveMinutes(a, b, SETTINGS);
    for (let seed = 1; seed <= 40; seed++) {
      const rand = rng(seed);
      const stops = Array.from({ length: 4 + Math.floor(rand() * 18) }, (_, i) =>
        stop(`s${i}`, 32.6 + rand() * 0.6, -97.1 + rand() * 0.6, {
          priority: rand() < 0.15 ? "HOT" : "NORMAL",
          window: rand() < 0.3 ? (["MORNING", "AFTERNOON", "EVENING"] as const)[Math.floor(rand() * 3)]! : null,
        }),
      );
      const byId = new Map(stops.map((s) => [s.id, s]));
      const length = (r: ReturnType<typeof plan>) => routeLength(START, r.stops.map((s) => byId.get(s.id)!), travel);
      const nn = plan(stops, { improve: false });
      const improved = plan(stops);
      expect(length(improved)).toBeLessThanOrEqual(length(nn) + 1e-9);
      expect(improved.stops).toHaveLength(stops.length);
      // Hot stops still lead their bucket after 2-opt.
      const firstNonHot = improved.stops.findIndex((s) => byId.get(s.id)!.priority !== "HOT");
      const order = improved.stops.map((s) => byId.get(s.id)!);
      if (!order.some((s) => s.window)) {
        expect(order.slice(firstNonHot === -1 ? order.length : firstNonHot).some((s) => s.priority === "HOT")).toBe(false);
      }
    }
  });

  it("2-opt removes an obvious crossing", () => {
    // Four corners of a square; nearest-neighbor from the corner can cross, 2-opt must not be longer.
    const travel = (a: LatLng, b: LatLng) => estimateDriveMinutes(a, b, SETTINGS);
    const sq = [stop("a", 32.8, -96.8), stop("b", 32.8, -96.7), stop("c", 32.9, -96.7), stop("d", 32.9, -96.8), stop("e", 32.85, -96.75)];
    const byId = new Map(sq.map((s) => [s.id, s]));
    const r = plan(sq, { start: { lat: 32.8, lng: -96.81 } });
    const len = routeLength({ lat: 32.8, lng: -96.81 }, r.stops.map((s) => byId.get(s.id)!), travel);
    const perimeter = travel(sq[0]!, sq[1]!) * 4;
    expect(len).toBeLessThan(perimeter * 1.5);
  });
});
