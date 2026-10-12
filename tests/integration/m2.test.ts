// Milestone M2 (PRD §11): doors from M1 are assigned and routed for 3 test reps in different time zones.
// Wednesday 2026-10-07 14:00 UTC is 09:00 in Dallas, 08:00 in Denver and 07:00 in Seattle: before the 11:00
// cutoff everywhere, and before the Denver and Seattle reps' 09:00 start.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apifyJobToIntake } from "@/lib/domain/apify";
import { setGoogleClients } from "@/lib/integrations/google";
import { cityFakeGoogle } from "@/lib/integrations/google/cityFake";
import { db } from "@/lib/db";
import { intakeProspect } from "@/lib/services/intake";
import { rolloverRep } from "@/lib/services/rollover";
import { HANDLERS } from "@/worker/handlers";
import { runDueJobs } from "@/worker/runner";
import { createRep } from "./helpers";

const NOW = new Date("2026-10-07T14:00:00Z");
const jobs = JSON.parse(readFileSync("tests/fixtures/sample_apify_linkedin_jobs.json", "utf8")) as unknown[];
const sunbelt = [
  { placeId: "pl_sunbelt", displayName: "Sunbelt Medical Billing", streetNumber: "3100", route: "Hemphill St", locality: "Fort Worth", adminArea1: "TX", postalCode: "76110", businessStatus: "OPERATIONAL" },
];

/** Run the worker until the queue is quiet, as of `now`. Jobs created "now" count as due. */
async function drain(now: Date) {
  for (let i = 0; i < 50; i++) {
    await db().job.updateMany({ where: { status: "QUEUED" }, data: { runAt: new Date(0) } });
    if ((await runDueJobs(HANDLERS, "m2-worker", () => now)) === 0) return;
  }
  throw new Error("The job queue never went quiet");
}

let dallas: Awaited<ReturnType<typeof createRep>>;
let denver: Awaited<ReturnType<typeof createRep>>;
let seattle: Awaited<ReturnType<typeof createRep>>;
const byCompany = (name: string) => db().door.findFirstOrThrow({ where: { company: { name } }, include: { assignments: { orderBy: { createdAt: "desc" } } } });

beforeAll(async () => {
  setGoogleClients(cityFakeGoogle({ "Sunbelt Medical Billing Fort Worth, TX": sunbelt }));
  dallas = await createRep("Dana Dallas", "America/Chicago", { lat: 32.7767, lng: -96.797 }, { dailyCapacity: 8 });
  denver = await createRep("Dean Denver", "America/Denver", { lat: 39.7392, lng: -104.9903 });
  seattle = await createRep("Sam Seattle", "America/Los_Angeles", { lat: 47.6062, lng: -122.3321 });
  for (const job of jobs) await intakeProspect(apifyJobToIntake(job), { type: "SYSTEM" }, NOW);
  await drain(NOW);
});
afterAll(() => setGoogleClients(null));

describe("M2: assignment", () => {
  it("assigns every door that is in range and flags the rest as coverage gaps", async () => {
    const byStatus = Object.fromEntries((await db().door.groupBy({ by: ["status"], _count: { _all: true } })).map((g) => [g.status, g._count._all]));
    // 18 DFW doors, 1 in Denver and 1 in Seattle are assigned (20). 10 are planned for today; the other 10 wait for their own day.
    // The 4 address problems from M1 stay in review, with the 10 doors out of range.
    expect(byStatus).toEqual({ ASSIGNED: 10, SCHEDULED: 10, NEEDS_REVIEW: 14 });
    const reasons = await db().door.groupBy({ by: ["reviewReason"], where: { status: "NEEDS_REVIEW" }, _count: { _all: true } });
    expect(Object.fromEntries(reasons.map((r) => [r.reviewReason, r._count._all]))).toEqual({ MISSING_ADDRESS: 3, LOCATION_MISMATCH: 1, COVERAGE_GAP: 10 });
    expect(await db().job.count({ where: { status: "FAILED" } })).toBe(0);
  });

  it("explains a coverage gap with the nearest rep", async () => {
    const austin = await byCompany("Capital City Coffee Roasters");
    expect(austin).toMatchObject({ status: "NEEDS_REVIEW", reviewReason: "COVERAGE_GAP" });
    const evidence = JSON.parse(austin.reviewDetail!);
    expect(evidence.coverage).toMatchObject({ nearestRepId: dallas.rep.id, nearestRepName: "Dana Dallas", maxDriveMinutes: 120 });
    expect(evidence.coverage.driveMinutes).toBeGreaterThan(120);
  });

  it("sends doors to the nearest rep in each time zone, for that rep's own today", async () => {
    expect(await byCompany("Front Range Bike Works")).toMatchObject({ status: "SCHEDULED", assignments: [{ repId: denver.rep.id, scheduledFor: "2026-10-07", assignedBy: "ENGINE" }] });
    expect(await byCompany("Puget Sound Tile & Stone")).toMatchObject({ status: "SCHEDULED", assignments: [{ repId: seattle.rep.id, scheduledFor: "2026-10-07" }] });
  });

  it("respects capacity: the Dallas rep gets 8 a day, the overflow goes to later working days", async () => {
    const counts = await db().assignment.groupBy({ by: ["scheduledFor"], where: { repId: dallas.rep.id, status: "ACTIVE" }, _count: { _all: true }, orderBy: { scheduledFor: "asc" } });
    expect(counts.map((c) => [c.scheduledFor, c._count._all])).toEqual([
      ["2026-10-07", 8],
      ["2026-10-08", 8],
      ["2026-10-09", 2],
    ]);
  });

  it("records every assignment with a drive time and emits door.assigned", async () => {
    const assignments = await db().assignment.findMany({ where: { status: "ACTIVE" } });
    expect(assignments).toHaveLength(20);
    expect(assignments.every((a) => a.assignedBy === "ENGINE" && (a.driveMinutes ?? -1) >= 0 && a.driveMinutes! <= 120)).toBe(true);
    expect(await db().outboxEvent.count({ where: { type: "door.assigned" } })).toBe(20);
    const event = JSON.parse((await db().outboxEvent.findFirstOrThrow({ where: { type: "door.assigned" } })).payload);
    expect(event.data.assignment).toMatchObject({ assignedBy: "ENGINE" });
    expect(event.data.door.currentAssignment.repId).toBe(event.data.assignment.repId);
  });

  it("keeps one ACTIVE assignment per door", async () => {
    const dupes = await db().assignment.groupBy({ by: ["doorId"], where: { status: "ACTIVE" }, _count: { _all: true }, having: { doorId: { _count: { gt: 1 } } } });
    expect(dupes).toEqual([]);
  });
});

describe("M2: routing", () => {
  const plan = (repId: string) => db().assignment.findMany({ where: { repId, scheduledFor: "2026-10-07", status: "ACTIVE" }, orderBy: { routeOrder: "asc" } });

  it("plans today's routes in each rep's own time zone", async () => {
    const d = await plan(dallas.rep.id);
    expect(d.map((a) => a.routeOrder)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const times = d.map((a) => a.plannedArrival!.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(8);
    // Dallas: 09:00 CDT is 14:00Z, and it is already that time.
    expect(times[0]).toBeGreaterThanOrEqual(NOW.getTime());

    // Denver (09:00 MDT = 15:00Z) and Seattle (09:00 PDT = 16:00Z) start at their own day start, not now.
    expect((await plan(denver.rep.id))[0]!.plannedArrival!.getTime()).toBeGreaterThanOrEqual(new Date("2026-10-07T15:00:00Z").getTime());
    expect((await plan(seattle.rep.id))[0]!.plannedArrival!.getTime()).toBeGreaterThanOrEqual(new Date("2026-10-07T16:00:00Z").getTime());

    const row = await db().routePlan.findFirstOrThrow({ where: { repId: dallas.rep.id, date: "2026-10-07" }, orderBy: { createdAt: "desc" } });
    expect(row).toMatchObject({ provider: "LOCAL", status: "OK" });
    expect(row.totalDriveMinutes).toBeGreaterThan(0);
  });

  it("marks planned doors SCHEDULED and leaves later days ASSIGNED until their own 06:30 plan", async () => {
    const later = await db().assignment.findMany({ where: { repId: dallas.rep.id, scheduledFor: "2026-10-08", status: "ACTIVE" }, include: { door: true } });
    expect(later).toHaveLength(8);
    expect(later.every((a) => a.routeOrder === null && a.door.status === "ASSIGNED")).toBe(true);
  });

  it("queues a push for the rep when the route changed", async () => {
    const pushes = await db().job.findMany({ where: { type: "push.send" } });
    expect(pushes.some((p) => p.payload.includes("Your route changed"))).toBe(true);
  });
});

describe("M2: nightly rollover", () => {
  const NIGHT = new Date("2026-10-08T02:30:00Z"); // 21:30 Wednesday in Dallas

  it("rolls unvisited doors to later days and counts the rollover", async () => {
    const before = await db().assignment.findMany({ where: { repId: dallas.rep.id, scheduledFor: "2026-10-07", status: "ACTIVE" }, select: { doorId: true } });
    expect(before).toHaveLength(8);
    expect(await rolloverRep(dallas.rep.id, "2026-10-07", NIGHT)).toMatchObject({ rolledOver: 8, reviewed: 0 });

    const ids = before.map((b) => b.doorId);
    expect(await db().assignment.count({ where: { doorId: { in: ids }, status: "ROLLED_OVER" } })).toBe(8);
    expect((await db().door.findMany({ where: { id: { in: ids } } })).every((d) => d.rolloverCount === 1 && d.status === "GEOCODED")).toBe(true);

    await drain(NIGHT);
    const doors = await db().door.findMany({ where: { id: { in: ids } }, include: { assignments: { where: { status: "ACTIVE" } } } });
    expect(doors.every((d) => d.status === "ASSIGNED" && d.assignments.length === 1)).toBe(true);
    // Thursday is full, so the rolled doors fill later days: never the past, never over capacity.
    const dates = await db().assignment.groupBy({ by: ["scheduledFor"], where: { repId: dallas.rep.id, status: "ACTIVE" }, _count: { _all: true }, orderBy: { scheduledFor: "asc" } });
    expect(dates.every((d) => d._count._all <= 8 && d.scheduledFor >= "2026-10-08")).toBe(true);
    expect(dates.reduce((n, d) => n + d._count._all, 0)).toBe(18);
  });

  it("sends a door rolled over too many times to review", async () => {
    const door = await db().door.findFirstOrThrow({ where: { status: "ASSIGNED", assignments: { some: { repId: dallas.rep.id, status: "ACTIVE" } } }, include: { assignments: { where: { status: "ACTIVE" } } } });
    await db().door.update({ where: { id: door.id }, data: { rolloverCount: 3 } });
    const result = await rolloverRep(dallas.rep.id, door.assignments[0]!.scheduledFor, NIGHT);
    expect(result.reviewed).toBeGreaterThanOrEqual(1);
    expect(await db().door.findUniqueOrThrow({ where: { id: door.id } })).toMatchObject({ status: "NEEDS_REVIEW", reviewReason: "ROLLOVER_LIMIT", rolloverCount: 4 });
  });

  it("ends a shift still open at 21:00", async () => {
    await db().rep.update({ where: { id: seattle.rep.id }, data: { onShift: true } });
    await db().shift.create({ data: { repId: seattle.rep.id, date: "2026-10-07", startedAt: new Date("2026-10-07T16:00:00Z") } });
    const result = await rolloverRep(seattle.rep.id, "2026-10-07", new Date("2026-10-08T04:30:00Z"));
    expect(result.shiftEnded).toBe(true);
    expect(await db().shift.findFirstOrThrow({ where: { repId: seattle.rep.id } })).toMatchObject({ endedBy: "SYSTEM" });
    expect((await db().rep.findUniqueOrThrow({ where: { id: seattle.rep.id } })).onShift).toBe(false);
  });
});
