import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cityFakeGoogle } from "@/lib/integrations/google/cityFake";
import { assignDoorById } from "@/lib/services/assignment";
import { manualAssign } from "@/lib/services/manualAssignment";
import { doorHistory, recordEvents, skipStop } from "@/lib/services/repActions";
import { reorderStops } from "@/lib/services/reorder";
import { getToday } from "@/lib/services/repApp";
import { planRoute } from "@/lib/services/routes";
import { createVisit } from "@/lib/services/visits";
import { createRep, createUser } from "./helpers";

const NOW = new Date("2026-10-07T15:00:00Z"); // Wednesday 10:00 in Chicago
const fake = cityFakeGoogle();
const DALLAS = { lat: 32.7767, lng: -96.797 };
let n = 0;

async function setup(doorCount = 3) {
  const manager = await createUser("MANAGER");
  const { user, rep } = await createRep(`Extras Rep ${++n}`, "America/Chicago", DALLAS);
  const stops: { doorId: string; assignmentId: string }[] = [];
  for (let i = 0; i < doorCount; i++) {
    const company = await db().company.create({ data: { name: `X Co ${n}-${i}`, nameKey: `x co ${n} ${i}` } });
    const door = await db().door.create({
      data: { externalProspectId: `X-${n}-${i}-${randomUUID()}`, companyId: company.id, name: `X Co ${n}-${i}`, status: "GEOCODED", street: `${i + 1} Main St`, city: "Dallas", state: "TX", zip: "75201", lat: 32.78 + i * 0.01, lng: -96.8 },
    });
    stops.push({ doorId: door.id, assignmentId: (await manualAssign(manager.id, door.id, { repId: rep.id, date: "2026-10-07" }, NOW)).assignmentId });
  }
  await planRoute({ repId: rep.id, date: "2026-10-07", trigger: "SCHEDULED" }, fake, NOW);
  return { manager, user, rep, stops };
}
const onlyRep = (id: string) => db().rep.updateMany({ where: { id: { not: id } }, data: { active: false } });
const queued = (type: string) => db().job.findMany({ where: { type, status: "QUEUED" } });

describe("skip a stop", () => {
  it("takes the stop off today, sends the door back for assignment, and is idempotent", async () => {
    const s = await setup(3);
    await db().job.deleteMany();
    const clientId = randomUUID();
    const first = await skipStop(s.user.id, s.stops[0]!.assignmentId, { clientId, reason: "UNSAFE", note: "Aggressive dog" }, NOW);
    expect(first).toMatchObject({ status: 200, replayed: false, body: { skipped: true, status: "SKIPPED" } });
    expect(await db().assignment.findUniqueOrThrow({ where: { id: s.stops[0]!.assignmentId } })).toMatchObject({ status: "SKIPPED", reason: "Unsafe: Aggressive dog" });
    expect(await db().door.findUniqueOrThrow({ where: { id: s.stops[0]!.doorId } })).toMatchObject({ status: "GEOCODED" });
    expect((await queued("door.assign")).map((j) => JSON.parse(j.payload))).toEqual([{ doorId: s.stops[0]!.doorId, reason: "RETRY", avoid: { repId: s.rep.id, date: "2026-10-07" } }]);
    expect(await db().auditLog.count({ where: { action: "rep.stop_skipped", entityId: s.stops[0]!.assignmentId } })).toBe(1);

    expect((await skipStop(s.user.id, s.stops[0]!.assignmentId, { clientId, reason: "UNSAFE" }, NOW)).replayed).toBe(true);
    // A different tap on a stop that is already skipped changes nothing.
    expect((await skipStop(s.user.id, s.stops[0]!.assignmentId, { clientId: randomUUID(), reason: "OTHER" }, NOW)).body).toEqual({ skipped: false, status: "SKIPPED" });
    expect(await db().auditLog.count({ where: { action: "rep.stop_skipped" } })).toBe(1);

    const today = await getToday(s.user.id, undefined, NOW);
    expect(today.stops.find((x) => x.assignmentId === s.stops[0]!.assignmentId)?.status).toBe("SKIPPED");
  });

  it("is not handed straight back to the same rep that day, but to their next working day", async () => {
    const s = await setup(1);
    await onlyRep(s.rep.id);
    await skipStop(s.user.id, s.stops[0]!.assignmentId, { clientId: randomUUID(), reason: "OUT_OF_TIME" }, NOW);
    const job = (await queued("door.assign")).map((j) => JSON.parse(j.payload)).find((p) => p.doorId === s.stops[0]!.doorId);
    // Without `avoid` the engine would give it back to the rep for today (10:00 is before the 11:00 cutoff).
    expect(await assignDoorById(s.stops[0]!.doorId, { reason: "RETRY" }, fake.driveTimes, NOW)).toMatchObject({ kind: "assigned", date: "2026-10-07" });
    await db().assignment.updateMany({ where: { doorId: s.stops[0]!.doorId, status: "ACTIVE" }, data: { status: "CANCELLED" } });
    await db().door.update({ where: { id: s.stops[0]!.doorId }, data: { status: "GEOCODED" } });
    expect(await assignDoorById(s.stops[0]!.doorId, { reason: "RETRY", avoid: job.avoid }, fake.driveTimes, NOW)).toMatchObject({ kind: "assigned", repId: s.rep.id, date: "2026-10-08" });
  });

  it("is only for the rep's own stop, and validates the reason", async () => {
    const s = await setup(1);
    const other = await setup(1);
    await expect(skipStop(other.user.id, s.stops[0]!.assignmentId, { clientId: randomUUID(), reason: "CLOSED" }, NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(skipStop(s.user.id, s.stops[0]!.assignmentId, { clientId: randomUUID(), reason: "LAZY" }, NOW)).rejects.toThrow();
    await expect(skipStop(s.user.id, s.stops[0]!.assignmentId, { clientId: "nope", reason: "CLOSED" }, NOW)).rejects.toThrow();
  });

  it("does not touch a stop that was already visited", async () => {
    const s = await setup(1);
    await createVisit(s.user.id, { clientId: randomUUID(), assignmentId: s.stops[0]!.assignmentId, doorId: s.stops[0]!.doorId, outcome: "NOT_INTERESTED", recordedAt: NOW.toISOString(), location: { lat: 32.78, lng: -96.8, capturedAt: NOW.toISOString() } }, NOW);
    expect((await skipStop(s.user.id, s.stops[0]!.assignmentId, { clientId: randomUUID(), reason: "CLOSED" }, NOW)).body).toEqual({ skipped: false, status: "COMPLETED" });
    expect(await db().door.findUniqueOrThrow({ where: { id: s.stops[0]!.doorId } })).toMatchObject({ status: "CLOSED" });
  });
});

describe("door history", () => {
  it("shows every rep's visits to a door the rep has a stop at, and nothing for other doors", async () => {
    const s = await setup(1);
    const other = await setup(1);
    const doorId = s.stops[0]!.doorId;
    await db().visit.create({ data: { clientId: randomUUID(), doorId, repId: other.rep.id, outcome: "NOT_HOME", notes: "Closed for lunch", recordedAt: new Date("2026-10-05T17:00:00Z") } });
    await createVisit(s.user.id, { clientId: randomUUID(), assignmentId: s.stops[0]!.assignmentId, doorId, outcome: "FOLLOW_UP", notes: "Owner out", nextStepAt: "2026-10-09T15:00:00Z", recordedAt: NOW.toISOString() }, NOW);

    const h = await doorHistory(s.user.id, doorId, NOW);
    expect(h).toMatchObject({ companyName: expect.stringContaining("X Co"), attempts: 0 });
    expect(h.visits.map((v) => [v.outcome, v.you, v.notes])).toEqual([["FOLLOW_UP", true, "Owner out"], ["NOT_HOME", false, "Closed for lunch"]]);
    await expect(doorHistory(s.user.id, other.stops[0]!.doorId, NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A stop from long ago no longer opens the history.
    await db().assignment.updateMany({ where: { doorId }, data: { createdAt: new Date("2026-01-01T00:00:00Z") } });
    await expect(doorHistory(s.user.id, doorId, NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("phone analytics events", () => {
  const ev = (name: string, data?: Record<string, string | number | boolean | null>) => ({ clientId: randomUUID(), name, at: NOW.toISOString(), data });

  it("records each event once, even when the same batch is sent again", async () => {
    const s = await setup(1);
    const batch = { events: [ev("rep.visit_form_opened", { stop: "a1" }), ev("rep.navigate_tapped", { app: "google" }), ev("rep.offline_queue_flushed", { count: 4, oldestAgeS: 1500 })] };
    expect(await recordEvents(s.user.id, batch, NOW)).toEqual({ recorded: 3, duplicates: 0 });
    expect(await recordEvents(s.user.id, batch, NOW)).toEqual({ recorded: 0, duplicates: 3 });
    const rows = await db().auditLog.findMany({ where: { entityId: s.rep.id, action: { startsWith: "rep." } }, orderBy: { createdAt: "asc" } });
    const flushed = rows.find((r) => r.action === "rep.offline_queue_flushed")!;
    expect(JSON.parse(flushed.data!)).toMatchObject({ count: 4, oldestAgeS: 1500 });
  });

  it("accepts only the known events, in batches of 1 to 50", async () => {
    const s = await setup(1);
    await expect(recordEvents(s.user.id, { events: [ev("rep.something_else")] }, NOW)).rejects.toThrow();
    await expect(recordEvents(s.user.id, { events: [] }, NOW)).rejects.toThrow();
    await expect(recordEvents(s.user.id, { events: Array.from({ length: 51 }, () => ev("rep.navigate_tapped")) }, NOW)).rejects.toThrow();
  });
});

describe("a manager reorders a day", () => {
  it("saves the new order with new arrival times, after the stops already visited", async () => {
    const s = await setup(4);
    await createVisit(s.user.id, { clientId: randomUUID(), assignmentId: s.stops[0]!.assignmentId, doorId: s.stops[0]!.doorId, outcome: "NOT_HOME", recordedAt: NOW.toISOString(), location: { lat: 32.78, lng: -96.8, capturedAt: NOW.toISOString() } }, NOW);
    const open = (await db().assignment.findMany({ where: { repId: s.rep.id, status: "ACTIVE" }, orderBy: { routeOrder: "asc" } })).map((a) => a.id);
    const reversed = [...open].reverse();

    expect(await reorderStops(s.manager.id, s.rep.id, "2026-10-07", { assignmentIds: reversed }, NOW)).toEqual({ date: "2026-10-07", stops: 3 });
    const after = await db().assignment.findMany({ where: { repId: s.rep.id, status: "ACTIVE" }, orderBy: { routeOrder: "asc" } });
    expect(after.map((a) => a.id)).toEqual(reversed);
    expect(after.map((a) => a.routeOrder)).toEqual([2, 3, 4]); // the visited stop keeps 1
    const times = after.map((a) => a.plannedArrival!.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(3);
    expect(times[0]).toBeGreaterThanOrEqual(NOW.getTime());
    expect(await db().routePlan.findFirstOrThrow({ where: { repId: s.rep.id, trigger: "MANAGER" } })).toMatchObject({ provider: "LOCAL", status: "OK" });
    expect(await db().auditLog.count({ where: { action: "route.reordered", entityId: s.rep.id } })).toBe(1);
    // The rep's own Today follows the new order.
    expect((await getToday(s.user.id, undefined, NOW)).stops.filter((x) => x.status === "ACTIVE").map((x) => x.assignmentId)).toEqual(reversed);
  });

  it("refuses a list that is not exactly the open stops, a past day and an unknown rep", async () => {
    const s = await setup(3);
    const open = (await db().assignment.findMany({ where: { repId: s.rep.id, status: "ACTIVE" }, orderBy: { routeOrder: "asc" } })).map((a) => a.id);
    await expect(reorderStops(s.manager.id, s.rep.id, "2026-10-07", { assignmentIds: open.slice(1) }, NOW)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(reorderStops(s.manager.id, s.rep.id, "2026-10-07", { assignmentIds: [...open, "extra"] }, NOW)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(reorderStops(s.manager.id, s.rep.id, "2026-10-07", { assignmentIds: [open[0]!, open[0]!, open[1]!] }, NOW)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(reorderStops(s.manager.id, s.rep.id, "2026-10-06", { assignmentIds: open }, NOW)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(reorderStops(s.manager.id, "missing", "2026-10-07", { assignmentIds: open }, NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(reorderStops(s.manager.id, s.rep.id, "soon", { assignmentIds: open }, NOW)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
