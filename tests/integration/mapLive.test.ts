import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getLiveMap } from "@/lib/services/mapLive";
import { createRep } from "./helpers";

const NOW = new Date("2026-10-07T15:00:00Z"); // 10:00 in Chicago, 08:00 in Seattle
let n = 0;

async function makeDoor(over: { status?: string; lat?: number | null; lng?: number | null; priority?: string } = {}) {
  n += 1;
  const company = await db().company.create({ data: { name: `Map Co ${n}`, nameKey: `map co ${n}` } });
  return db().door.create({
    data: { externalProspectId: `MAP-${n}`, companyId: company.id, name: `Map Co ${n}`, status: "GEOCODED", lat: 32.78 + n * 0.001, lng: -96.8, ...over },
  });
}

async function assign(doorId: string, repId: string, date: string, over: { status?: string; routeOrder?: number | null } = {}) {
  return db().assignment.create({ data: { doorId, repId, scheduledFor: date, assignedBy: "ENGINE", status: "ACTIVE", routeOrder: 1, ...over } });
}

describe("live map", () => {
  it("shows reps with freshness and progress, and each rep's own today by default", async () => {
    const dallas = await createRep("Dana Dallas", "America/Chicago", { lat: 32.7767, lng: -96.797 });
    const seattle = await createRep("Sam Seattle", "America/Los_Angeles", { lat: 47.6, lng: -122.3 });
    await db().rep.update({ where: { id: dallas.rep.id }, data: { onShift: true, lastLat: 32.8, lastLng: -96.8, lastLocationAt: new Date(NOW.getTime() - 5 * 60_000) } });
    const d1 = await makeDoor({ status: "SCHEDULED", priority: "HOT" });
    const d2 = await makeDoor({ status: "VISITED" });
    await assign(d1.id, dallas.rep.id, "2026-10-07", { routeOrder: 1 });
    await assign(d2.id, dallas.rep.id, "2026-10-07", { routeOrder: 2, status: "COMPLETED" });

    const live = await getLiveMap({}, NOW);
    const d = live.reps.find((r) => r.repId === dallas.rep.id)!;
    expect(d).toMatchObject({ name: "Dana Dallas", initials: "DD", onShift: true, freshness: "FRESH", todayDone: 1, todayTotal: 2, date: "2026-10-07", lat: 32.8 });
    const s = live.reps.find((r) => r.repId === seattle.rep.id)!;
    expect(s).toMatchObject({ onShift: false, freshness: "NONE", lat: null, todayTotal: 0, date: "2026-10-07" });
    expect(live.doors.find((p) => p.doorId === d1.id)).toMatchObject({ repId: dallas.rep.id, routeOrder: 1, status: "SCHEDULED", priority: "HOT" });
    expect(typeof live.reviewCount).toBe("number");
  });

  it("includes open doors with no rep, but not closed, unlocated or review doors", async () => {
    const waiting = await makeDoor({ status: "GEOCODED" });
    const noRep = await makeDoor({ status: "UNASSIGNABLE" });
    const closed = await makeDoor({ status: "CLOSED" });
    const unlocated = await makeDoor({ status: "GEOCODED", lat: null, lng: null });
    const review = await makeDoor({ status: "NEEDS_REVIEW" });
    const ids = (await getLiveMap({}, NOW)).doors.map((p) => p.doorId);
    expect(ids).toEqual(expect.arrayContaining([waiting.id, noRep.id]));
    for (const d of [closed, unlocated, review]) expect(ids).not.toContain(d.id);
  });

  it("filters by rep, by status and by date", async () => {
    const rep = await createRep("Filter Rep", "America/Chicago", { lat: 32.78, lng: -96.8 });
    const a = await makeDoor({ status: "SCHEDULED" });
    const b = await makeDoor({ status: "ASSIGNED" });
    await assign(a.id, rep.rep.id, "2026-10-08", { routeOrder: 1 });
    await assign(b.id, rep.rep.id, "2026-10-08", { routeOrder: null });

    const day = await getLiveMap({ repId: rep.rep.id, date: "2026-10-08" }, NOW);
    expect(day.reps.map((r) => r.repId)).toEqual([rep.rep.id]);
    expect(day.reps[0]).toMatchObject({ todayTotal: 2, date: "2026-10-08" });
    expect(day.doors.map((p) => p.doorId).sort()).toEqual([a.id, b.id].sort());
    // A rep filter shows only that rep's doors, not the waiting ones.
    expect(day.doors.every((p) => p.repId === rep.rep.id)).toBe(true);

    const scheduledOnly = await getLiveMap({ repId: rep.rep.id, date: "2026-10-08", status: "SCHEDULED" }, NOW);
    expect(scheduledOnly.doors.map((p) => p.doorId)).toEqual([a.id]);
    expect((await getLiveMap({ repId: rep.rep.id, date: "2026-10-09" }, NOW)).doors).toEqual([]);
  });

  it("leaves out deactivated reps", async () => {
    const gone = await createRep("Gone Rep", "America/Chicago", { lat: 32.78, lng: -96.8 });
    await db().rep.update({ where: { id: gone.rep.id }, data: { active: false } });
    expect((await getLiveMap({}, NOW)).reps.map((r) => r.repId)).not.toContain(gone.rep.id);
  });
});
