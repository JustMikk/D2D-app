import { describe, expect, it, vi } from "vitest";
import { assignDoor, originFor, type AssignableDoor, type AssignableRep, type AssignmentSettings, type DriveTimesFn } from "@/lib/domain/assignment";
import type { LatLng } from "@/lib/domain/geo";
import { targetDate } from "@/lib/domain/targetDate";
import { parseWorkdays } from "@/lib/domain/time";

const SETTINGS: AssignmentSettings = {
  maxDriveMinutes: 120,
  shortlistSize: 5,
  cutoffLocalTime: "11:00",
  locationStalenessMinutes: 120,
  roadFactor: 1.3,
  avgSpeedMph: 30,
};

const MON_SAT = parseWorkdays("MON,TUE,WED,THU,FRI,SAT");
const MON_FRI = parseWorkdays("MON,TUE,WED,THU,FRI");

// Wednesday 2026-10-07, 09:00 in Chicago (before the cutoff).
const WED_9AM_CHICAGO = new Date("2026-10-07T14:00:00Z");

const door: AssignableDoor = { id: "d1", lat: 33.0, lng: -96.8, priority: "NORMAL" };

function rep(id: string, base: LatLng | null, over: Partial<AssignableRep> = {}): AssignableRep {
  return {
    id,
    name: `Rep ${id}`,
    active: true,
    timeZone: "America/Chicago",
    onShift: false,
    dailyCapacity: 20,
    base,
    last: null,
    load: {},
    workdays: MON_SAT,
    unavailableDates: [],
    ...over,
  };
}

/** Drive times looked up by origin; unknown origins get null (the estimate is used). */
function driveTable(table: Record<string, number>): DriveTimesFn & ReturnType<typeof vi.fn> {
  return vi.fn(async (origins: LatLng[]) => origins.map((o) => table[`${o.lat},${o.lng}`] ?? null));
}

describe("targetDate", () => {
  const chicago = { timeZone: "America/Chicago", onShift: false, workdays: MON_SAT, unavailableDates: [] };
  const newYork = { ...chicago, timeZone: "America/New_York" };
  // 15:30 UTC: 10:30 in Chicago (before 11:00), 11:30 in New York (after).
  const now = new Date("2026-10-07T15:30:00Z");

  it("uses today before the cutoff and the next workday after, per time zone", () => {
    expect(targetDate(chicago, { priority: "NORMAL" }, now, "11:00")).toBe("2026-10-07");
    expect(targetDate(newYork, { priority: "NORMAL" }, now, "11:00")).toBe("2026-10-08");
  });

  it("puts a hot door on today when the rep is on shift, even after the cutoff", () => {
    const afternoon = new Date("2026-10-07T19:00:00Z"); // 14:00 Chicago
    expect(targetDate({ ...chicago, onShift: true }, { priority: "HOT" }, afternoon, "11:00")).toBe("2026-10-07");
    expect(targetDate({ ...chicago, onShift: false }, { priority: "HOT" }, afternoon, "11:00")).toBe("2026-10-08");
    expect(targetDate({ ...chicago, onShift: true }, { priority: "NORMAL" }, afternoon, "11:00")).toBe("2026-10-08");
  });

  it("skips non-workdays and unavailable dates", () => {
    const saturdayAfternoon = new Date("2026-10-10T19:00:00Z");
    expect(targetDate({ ...chicago, workdays: MON_FRI }, { priority: "NORMAL" }, saturdayAfternoon, "11:00")).toBe("2026-10-12");
    expect(targetDate({ ...chicago, workdays: MON_FRI, unavailableDates: ["2026-10-12"] }, { priority: "NORMAL" }, saturdayAfternoon, "11:00")).toBe("2026-10-13");
    const sundayMorning = new Date("2026-10-11T14:00:00Z"); // before the cutoff, but Sunday is not a workday
    expect(targetDate(chicago, { priority: "NORMAL" }, sundayMorning, "11:00")).toBe("2026-10-12");
    const unavailableToday = { ...chicago, unavailableDates: ["2026-10-07"] };
    expect(targetDate(unavailableToday, { priority: "NORMAL" }, WED_9AM_CHICAGO, "11:00")).toBe("2026-10-08");
  });
});

describe("originFor", () => {
  const base = { lat: 32.0, lng: -96.0 };
  const last = { lat: 33.0, lng: -96.8 };
  it("uses a fresh location while on shift", () => {
    const r = rep("a", base, { onShift: true, last: { ...last, at: new Date(WED_9AM_CHICAGO.getTime() - 30 * 60_000) } });
    expect(originFor(r, WED_9AM_CHICAGO, 120)).toEqual(last);
  });
  it("falls back to the base when the location is stale or the rep is off shift", () => {
    const stale = rep("a", base, { onShift: true, last: { ...last, at: new Date(WED_9AM_CHICAGO.getTime() - 3 * 3600_000) } });
    expect(originFor(stale, WED_9AM_CHICAGO, 120)).toEqual(base);
    const offShift = rep("a", base, { onShift: false, last: { ...last, at: WED_9AM_CHICAGO } });
    expect(originFor(offShift, WED_9AM_CHICAGO, 120)).toEqual(base);
  });
});

describe("assignDoor", () => {
  it("picks the rep with the shortest drive time, not the shortest straight line", async () => {
    const a = rep("a", { lat: 33.01, lng: -96.8 }); // closest as the crow flies
    const b = rep("b", { lat: 33.05, lng: -96.8 });
    const drive = driveTable({ "33.01,-96.8": 40, "33.05,-96.8": 12 });
    const r = await assignDoor(door, [a, b], WED_9AM_CHICAGO, SETTINGS, drive);
    expect(r).toEqual({ kind: "assign", repId: "b", date: "2026-10-07", driveMinutes: 12, isToday: true, overCapacity: false });
  });

  it("overflows to the next rep when the fastest is at capacity", async () => {
    const a = rep("a", { lat: 33.01, lng: -96.8 }, { load: { "2026-10-07": 20 } });
    const b = rep("b", { lat: 33.1, lng: -96.8 });
    const r = await assignDoor(door, [a, b], WED_9AM_CHICAGO, SETTINGS, driveTable({}));
    expect(r).toMatchObject({ kind: "assign", repId: "b", date: "2026-10-07" });
  });

  it("tries the next batch when the whole shortlist is full", async () => {
    const full = { load: { "2026-10-07": 20 } };
    const reps = [
      rep("a", { lat: 33.01, lng: -96.8 }, full),
      rep("b", { lat: 33.02, lng: -96.8 }, full),
      rep("c", { lat: 33.2, lng: -96.8 }),
    ];
    const drive = driveTable({});
    const r = await assignDoor(door, reps, WED_9AM_CHICAGO, { ...SETTINGS, shortlistSize: 2 }, drive);
    expect(r).toMatchObject({ kind: "assign", repId: "c" });
    expect(drive).toHaveBeenCalledTimes(2);
  });

  it("flags a coverage gap when the best drive is over the maximum", async () => {
    const far = rep("far", { lat: 35.0, lng: -98.0 });
    const r = await assignDoor(door, [far], WED_9AM_CHICAGO, SETTINGS, driveTable({ "35,-98": 150 }));
    expect(r).toEqual({
      kind: "review",
      reason: "COVERAGE_GAP",
      evidence: { coverage: { nearestRepId: "far", nearestRepName: "Rep far", driveMinutes: 150, maxDriveMinutes: 120 } },
    });
  });

  it("is unassignable with no active reps", async () => {
    const inactive = rep("a", { lat: 33.01, lng: -96.8 }, { active: false });
    expect(await assignDoor(door, [inactive], WED_9AM_CHICAGO, SETTINGS, driveTable({}))).toEqual({ kind: "unassignable" });
    expect(await assignDoor(door, [], WED_9AM_CHICAGO, SETTINGS, driveTable({}))).toEqual({ kind: "unassignable" });
  });

  it("ignores reps without a deployment base", async () => {
    const noBase = rep("nobase", null);
    const b = rep("b", { lat: 33.1, lng: -96.8 });
    expect(await assignDoor(door, [noBase, b], WED_9AM_CHICAGO, SETTINGS, driveTable({}))).toMatchObject({ repId: "b" });
  });

  it("puts a hot door on today for an on-shift rep after the cutoff", async () => {
    const afternoon = new Date("2026-10-07T19:00:00Z");
    const onShift = rep("a", { lat: 33.01, lng: -96.8 }, { onShift: true });
    const hot = await assignDoor({ ...door, priority: "HOT" }, [onShift], afternoon, SETTINGS, driveTable({}));
    expect(hot).toMatchObject({ date: "2026-10-07", isToday: true });
    const normal = await assignDoor(door, [onShift], afternoon, SETTINGS, driveTable({}));
    expect(normal).toMatchObject({ date: "2026-10-08", isToday: false });
  });

  it("uses the deployment base when the last location is stale", async () => {
    const base = { lat: 32.5, lng: -96.5 };
    const stale = rep("a", base, { onShift: true, last: { lat: 33.0, lng: -96.8, at: new Date(WED_9AM_CHICAGO.getTime() - 3 * 3600_000) } });
    const drive = driveTable({});
    await assignDoor(door, [stale], WED_9AM_CHICAGO, SETTINGS, drive);
    expect(drive.mock.calls[0]![0]).toEqual([base]);
  });

  it("assigns a revisit to the preferred rep on the next-step date, over capacity", async () => {
    const preferred = rep("pref", { lat: 34.0, lng: -97.5 }, { load: { "2026-10-09": 20 } });
    const nearer = rep("near", { lat: 33.01, lng: -96.8 });
    const revisit: AssignableDoor = { ...door, isRevisit: true, preferredRepId: "pref", nextStepAt: new Date("2026-10-09T15:00:00Z") };
    const r = await assignDoor(revisit, [nearer, preferred], WED_9AM_CHICAGO, SETTINGS, driveTable({}));
    expect(r).toMatchObject({ kind: "assign", repId: "pref", date: "2026-10-09", overCapacity: true, isToday: false });
  });

  it("moves a revisit on a non-workday to the preferred rep's next workday", async () => {
    const preferred = rep("pref", { lat: 34.0, lng: -97.5 }, { workdays: MON_FRI });
    const revisit: AssignableDoor = { ...door, isRevisit: true, preferredRepId: "pref", nextStepAt: new Date("2026-10-10T15:00:00Z") };
    expect(await assignDoor(revisit, [preferred], WED_9AM_CHICAGO, SETTINGS, driveTable({}))).toMatchObject({ repId: "pref", date: "2026-10-12" });
  });

  it("falls back to the engine when the preferred rep is inactive", async () => {
    const preferred = rep("pref", { lat: 34.0, lng: -97.5 }, { active: false });
    const other = rep("b", { lat: 33.1, lng: -96.8 });
    const revisit: AssignableDoor = { ...door, isRevisit: true, preferredRepId: "pref", nextStepAt: new Date("2026-10-09T15:00:00Z") };
    expect(await assignDoor(revisit, [preferred, other], WED_9AM_CHICAGO, SETTINGS, driveTable({}))).toMatchObject({ repId: "b", date: "2026-10-07" });
  });

  it("uses the fastest rep's next workday with room when everyone is full", async () => {
    const a = rep("a", { lat: 33.01, lng: -96.8 }, { load: { "2026-10-07": 20, "2026-10-08": 20 } });
    const b = rep("b", { lat: 33.3, lng: -96.8 }, { load: { "2026-10-07": 20 } });
    const r = await assignDoor(door, [a, b], WED_9AM_CHICAGO, SETTINGS, driveTable({}));
    expect(r).toMatchObject({ kind: "assign", repId: "a", date: "2026-10-09" });
  });

  it("overflows a full in-range rep to the next day rather than to a distant rep with room", async () => {
    const local = rep("local", { lat: 33.05, lng: -96.8 }, { load: { "2026-10-07": 20 } });
    const distant = rep("distant", { lat: 39.7, lng: -105 }); // Denver, far outside 120 minutes, has capacity
    const r = await assignDoor(door, [local, distant], WED_9AM_CHICAGO, SETTINGS, driveTable({}));
    expect(r).toMatchObject({ kind: "assign", repId: "local", date: "2026-10-08" });
  });

  it("names the nearest rep when every rep is out of range", async () => {
    const a = rep("a", { lat: 36.0, lng: -97 }); // ~210 miles
    const b = rep("b", { lat: 39.7, lng: -105 });
    const r = await assignDoor(door, [b, a], WED_9AM_CHICAGO, SETTINGS, driveTable({}));
    expect(r).toMatchObject({ kind: "review", reason: "COVERAGE_GAP", evidence: { coverage: { nearestRepId: "a" } } });
  });

  it("falls back to the haversine estimate when drive times fail", async () => {
    const a = rep("a", { lat: 33.1, lng: -96.8 });
    const failing: DriveTimesFn = async () => {
      throw new Error("matrix down");
    };
    const r = await assignDoor(door, [a], WED_9AM_CHICAGO, SETTINGS, failing);
    // 0.1° latitude ≈ 6.9 miles × 1.3 / 30 mph ≈ 18 minutes.
    expect(r).toMatchObject({ kind: "assign", repId: "a", driveMinutes: 18 });
  });
});
