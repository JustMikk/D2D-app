import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cityFakeGoogle } from "@/lib/integrations/google/cityFake";
import { assignDoorById } from "@/lib/services/assignment";
import { updateDoor } from "@/lib/services/doors";
import { createInvite, acceptInvite } from "@/lib/services/invites";
import { manualAssign, manualUnassign } from "@/lib/services/manualAssignment";
import { addUnavailability, getRepDay, removeUnavailability, requestReplan, updateRep } from "@/lib/services/reps";
import { rolloverRep } from "@/lib/services/rollover";
import { planRoute } from "@/lib/services/routes";
import { updateSettings } from "@/lib/settings";
import { createRep, createUser, REP_INVITE } from "./helpers";

const NOW = new Date("2026-10-07T14:00:00Z"); // Wednesday 09:00 in Chicago
const fake = cityFakeGoogle();
const DALLAS = { lat: 32.7767, lng: -96.797 };
let n = 0;

type DoorOver = { status?: string; priority?: string; lat?: number | null; lng?: number | null; preferredRepId?: string; nextStepAt?: Date; preferredVisitWindow?: string };
async function makeDoor(over: DoorOver = {}) {
  n += 1;
  const company = await db().company.create({ data: { name: `Co ${n}`, nameKey: `co ${n}` } });
  return db().door.create({
    data: { externalProspectId: `T-${n}-${Math.random()}`, companyId: company.id, name: `Co ${n}`, status: "GEOCODED", street: `${n} Main St`, city: "Dallas", state: "TX", zip: "75201", lat: 32.78 + n * 0.001, lng: -96.8, ...over },
  });
}

/** Only this rep stays active, so the engine's choice does not depend on reps created by earlier tests. */
const onlyRep = (id: string) => db().rep.updateMany({ where: { id: { not: id } }, data: { active: false } });
const queued = (type: string) => db().job.findMany({ where: { type, status: "QUEUED" } });

describe("rep profile", () => {
  it("geocodes a new base address, saves the profile and audits it", async () => {
    const manager = await createUser("MANAGER");
    const { rep } = await createRep("Casey Cole", "America/Chicago", DALLAS);
    const view = await updateRep(manager.id, rep.id, { name: "Casey C.", phone: "(214) 555-0100", baseAddress: "6101 Preston Rd, Plano, TX 75093", dailyCapacity: 12, workdays: ["MON", "TUE", "WED"], dayStartLocal: "08:30", timeZone: "America/Denver" }, fake, NOW);
    expect(view).toMatchObject({ name: "Casey C.", baseLocated: true, dailyCapacity: 12, workdays: ["MON", "TUE", "WED"], dayStartLocal: "08:30", timeZone: "America/Denver" });
    const stored = await db().rep.findUniqueOrThrow({ where: { id: rep.id } });
    expect(stored.baseLat).toBeCloseTo(33.02, 0);
    expect(stored.workdays).toBe("MON,TUE,WED");
    expect(await db().auditLog.count({ where: { action: "rep.updated", entityId: rep.id } })).toBe(1);
  });

  it("refuses a base address that cannot be found, and changes nothing", async () => {
    const manager = await createUser("MANAGER");
    const { rep } = await createRep("Dee Dunn", "America/Chicago", DALLAS);
    await expect(updateRep(manager.id, rep.id, { baseAddress: "9 Nowhere Rd, Nowhere, TX 75001", dailyCapacity: 3 }, fake, NOW)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: [{ path: "baseAddress" }],
    });
    expect(await db().rep.findUniqueOrThrow({ where: { id: rep.id } })).toMatchObject({ dailyCapacity: 20, baseLat: DALLAS.lat });
  });

  it("validates the profile fields", async () => {
    const manager = await createUser("MANAGER");
    const { rep } = await createRep("Eli Ford", "America/Chicago", DALLAS);
    await expect(updateRep(manager.id, rep.id, { timeZone: "Mars/Base" }, fake)).rejects.toThrow();
    await expect(updateRep(manager.id, rep.id, { workdays: [] }, fake)).rejects.toThrow();
    await expect(updateRep(manager.id, rep.id, { dayStartLocal: "9am" }, fake)).rejects.toThrow();
    await expect(updateRep(manager.id, "missing", { dailyCapacity: 5 }, fake)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("locates the base when the invite is created, so the rep is assignable on accepting", async () => {
    const manager = await createUser("MANAGER");
    await expect(
      createInvite(manager.id, "MANAGER", { email: "bad@example.com", role: "REP", rep: { ...REP_INVITE.rep, baseAddress: "9 Nowhere Rd, Nowhere, TX 75001" } }, NOW, fake),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: [{ path: "rep.baseAddress" }] });

    const invite = await createInvite(manager.id, "MANAGER", { email: "good@example.com", ...REP_INVITE }, NOW, fake);
    await acceptInvite(invite.inviteUrl.split("/invite/")[1]!, { name: "Good Rep", password: "bluebonnet-route-42" }, NOW);
    const rep = await db().rep.findFirstOrThrow({ where: { user: { email: "good@example.com" } } });
    expect(rep.baseLat).toBeCloseTo(33.02, 0);
    // A new rep re-tries doors that had nobody in range.
    expect((await queued("unassignable.retry")).length).toBeGreaterThan(0);
  });
});

describe("deactivation", () => {
  it("cancels open assignments, signs the rep out and sends the doors back through assignment", async () => {
    const manager = await createUser("MANAGER");
    const { user, rep } = await createRep("Fay Gray", "America/Chicago", DALLAS);
    const doors = [await makeDoor(), await makeDoor()];
    for (const d of doors) await manualAssign(manager.id, d.id, { repId: rep.id, date: "2026-10-07" }, NOW);
    await db().rep.update({ where: { id: rep.id }, data: { onShift: true } });
    await db().shift.create({ data: { repId: rep.id, date: "2026-10-07", startedAt: NOW } });

    const view = await updateRep(manager.id, rep.id, { active: false }, fake, NOW);
    expect(view.active).toBe(false);
    expect(await db().assignment.count({ where: { repId: rep.id, status: "CANCELLED" } })).toBe(2);
    expect((await db().door.findMany({ where: { id: { in: doors.map((d) => d.id) } } })).every((d) => d.status === "GEOCODED")).toBe(true);
    const reassign = (await queued("door.assign")).filter((j) => doors.some((d) => j.payload.includes(d.id)));
    expect(reassign.map((j) => JSON.parse(j.payload).reason)).toEqual(["REP_CHANGE", "REP_CHANGE"]);
    expect(await db().user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ active: false, tokenVersion: 1 });
    expect(await db().rep.findUniqueOrThrow({ where: { id: rep.id } })).toMatchObject({ active: false, onShift: false });
    expect((await db().shift.findFirstOrThrow({ where: { repId: rep.id } })).endedBy).toBe("SYSTEM");

    await updateRep(manager.id, rep.id, { active: true }, fake, NOW);
    expect(await db().user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ active: true, tokenVersion: 2 });
  });
});

describe("unavailability", () => {
  it("reassigns open assignments on those dates and ignores past dates", async () => {
    const manager = await createUser("MANAGER");
    const { rep } = await createRep("Gus Hale", "America/Chicago", DALLAS);
    const door = await makeDoor();
    await manualAssign(manager.id, door.id, { repId: rep.id, date: "2026-10-08" }, NOW);

    const result = await addUnavailability(manager.id, rep.id, { dates: ["2026-10-08", "2026-10-01"], reason: "Dentist" }, NOW);
    expect(result).toEqual({ dates: ["2026-10-08"], reassigned: 1 });
    expect(await db().door.findUniqueOrThrow({ where: { id: door.id } })).toMatchObject({ status: "GEOCODED" });
    expect((await db().repUnavailability.findMany({ where: { repId: rep.id } })).map((u) => [u.date, u.reason])).toEqual([["2026-10-08", "Dentist"]]);
    await expect(addUnavailability(manager.id, rep.id, { dates: ["2026-10-01"] }, NOW)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    // The engine now skips that day for this rep.
    await onlyRep(rep.id);
    await db().job.deleteMany();
    const again = await assignDoorById(door.id, { reason: "REP_CHANGE" }, fake.driveTimes, new Date("2026-10-07T20:00:00Z")); // 15:00, after the cutoff
    expect(again).toMatchObject({ kind: "assigned", repId: rep.id, date: "2026-10-09" });

    await removeUnavailability(manager.id, rep.id, "2026-10-08");
    await expect(removeUnavailability(manager.id, rep.id, "2026-10-08")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("manual assignment", () => {
  it("assigns, reassigns (cancelling the old), and the engine never overrides it", async () => {
    const manager = await createUser("MANAGER");
    const a = await createRep("Hal Ives", "America/Chicago", DALLAS);
    const b = await createRep("Ida Jones", "America/Chicago", DALLAS);
    const door = await makeDoor();

    await manualAssign(manager.id, door.id, { repId: a.rep.id, date: "2026-10-09", reason: "Knows the owner" }, NOW);
    expect(await db().door.findUniqueOrThrow({ where: { id: door.id } })).toMatchObject({ status: "ASSIGNED" });
    await manualAssign(manager.id, door.id, { repId: b.rep.id, date: "2026-10-09" }, NOW);

    const rows = await db().assignment.findMany({ where: { doorId: door.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.repId === a.rep.id ? "a" : "b", r.status, r.assignedBy])).toEqual([["a", "CANCELLED", "MANAGER"], ["b", "ACTIVE", "MANAGER"]]);
    expect(rows[0]).toMatchObject({ reason: "REASSIGNED", assignedById: manager.id });

    expect(await assignDoorById(door.id, { reason: "RETRY" }, fake.driveTimes, NOW)).toMatchObject({ kind: "skipped" });
    expect(await db().auditLog.count({ where: { action: "door.assigned_manually", entityId: door.id } })).toBe(2);
  });

  it("refuses unlocated or closed doors, past dates and inactive reps", async () => {
    const manager = await createUser("MANAGER");
    const a = await createRep("Jo Kane", "America/Chicago", DALLAS);
    const unlocated = await makeDoor({ lat: null, lng: null });
    const closed = await makeDoor({ status: "CLOSED" });
    const ok = await makeDoor();
    await expect(manualAssign(manager.id, unlocated.id, { repId: a.rep.id, date: "2026-10-09" }, NOW)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(manualAssign(manager.id, closed.id, { repId: a.rep.id, date: "2026-10-09" }, NOW)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(manualAssign(manager.id, ok.id, { repId: a.rep.id, date: "2026-10-06" }, NOW)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await db().rep.update({ where: { id: a.rep.id }, data: { active: false } });
    await expect(manualAssign(manager.id, ok.id, { repId: a.rep.id, date: "2026-10-09" }, NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("may exceed capacity, and unassigning returns the door to Ready without re-running the engine", async () => {
    const manager = await createUser("MANAGER");
    const { rep } = await createRep("Kit Lowe", "America/Chicago", DALLAS, { dailyCapacity: 1 });
    const d1 = await makeDoor();
    const d2 = await makeDoor();
    await manualAssign(manager.id, d1.id, { repId: rep.id, date: "2026-10-09" }, NOW);
    await manualAssign(manager.id, d2.id, { repId: rep.id, date: "2026-10-09" }, NOW);
    expect(await db().assignment.count({ where: { repId: rep.id, status: "ACTIVE" } })).toBe(2);

    await db().job.deleteMany();
    expect(await manualUnassign(manager.id, d2.id, { reason: "Wrong territory" }, NOW)).toMatchObject({ status: "GEOCODED", currentAssignment: null });
    expect(await db().job.count({ where: { type: "door.assign" } })).toBe(0);
    await expect(manualUnassign(manager.id, d2.id, { reason: "again" }, NOW)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(manualUnassign(manager.id, d1.id, { reason: "" }, NOW)).rejects.toThrow();
  });
});

describe("hot doors (ASN-4)", () => {
  it("lands on the on-shift rep's today, re-plans from their location and pushes", async () => {
    const { user, rep } = await createRep("Lee Moss", "America/Chicago", DALLAS);
    await onlyRep(rep.id);
    const afternoon = new Date("2026-10-07T19:00:00Z"); // 14:00, well after the cutoff
    const gps = { lat: 33.0, lng: -96.75 };
    await db().rep.update({ where: { id: rep.id }, data: { onShift: true, lastLat: gps.lat, lastLng: gps.lng, lastLocationAt: new Date(afternoon.getTime() - 5 * 60_000) } });
    const plain = await makeDoor();
    const hot = await makeDoor({ priority: "HOT" });
    const [p, h] = [await assignDoorById(plain.id, { reason: "NEW" }, fake.driveTimes, afternoon), await assignDoorById(hot.id, { reason: "NEW" }, fake.driveTimes, afternoon)];
    expect(p).toMatchObject({ kind: "assigned", date: "2026-10-08" }); // after the cutoff: tomorrow
    expect(h).toMatchObject({ kind: "assigned", date: "2026-10-07" }); // hot: today

    const plans = (await queued("route.plan")).map((j) => JSON.parse(j.payload));
    expect(plans).toEqual([{ repId: rep.id, date: "2026-10-07", trigger: "HOT_DOOR" }]);
    const push = JSON.parse((await queued("push.send"))[0]!.payload);
    expect(push).toMatchObject({ userId: user.id, title: "New hot door", tag: "hot-door" });
    expect(push.body).toMatch(/^New hot door: Co \d+, \d+\.\d mi away$/);

    const outcome = await planRoute({ repId: rep.id, date: "2026-10-07", trigger: "HOT_DOOR" }, fake, afternoon);
    expect(outcome).toMatchObject({ kind: "planned", stops: 1 });
    const row = await db().routePlan.findFirstOrThrow({ where: { repId: rep.id } });
    expect(row).toMatchObject({ trigger: "HOT_DOOR", startLat: gps.lat, startLng: gps.lng });
    expect(JSON.parse(row.detail!).startedFrom).toBe("location");
    // A hot-door re-plan is not announced twice: the hot-door push already went out.
    expect((await queued("push.send")).length).toBe(1);
  });

  it("puts hot doors first and keeps visited stops in order on a re-plan", async () => {
    const { rep } = await createRep("Max Nash", "America/Chicago", DALLAS);
    const manager = await createUser("MANAGER");
    const near = await makeDoor({ lat: 32.78, lng: -96.8 });
    const far = await makeDoor({ lat: 33.2, lng: -96.8 });
    const hot = await makeDoor({ lat: 33.4, lng: -96.8, priority: "HOT" });
    for (const d of [near, far, hot]) await manualAssign(manager.id, d.id, { repId: rep.id, date: "2026-10-07" }, NOW);
    await planRoute({ repId: rep.id, date: "2026-10-07", trigger: "SCHEDULED" }, fake, NOW);
    const order = async () => (await db().assignment.findMany({ where: { repId: rep.id, status: "ACTIVE" }, orderBy: { routeOrder: "asc" }, select: { doorId: true, routeOrder: true } }));
    // Hot first, then nearest-first from where the hot door is.
    expect((await order()).map((o) => o.doorId)).toEqual([hot.id, far.id, near.id]);

    // The hot door is visited; the re-plan continues after it.
    await db().assignment.updateMany({ where: { doorId: hot.id }, data: { status: "COMPLETED" } });
    await planRoute({ repId: rep.id, date: "2026-10-07", trigger: "REP", start: { lat: 33.4, lng: -96.8 } }, fake, NOW);
    expect((await order()).map((o) => [o.doorId, o.routeOrder])).toEqual([[far.id, 2], [near.id, 3]]);
  });
});

describe("marking a door hot", () => {
  it("re-plans and pushes for today's stop; re-assigns an engine-assigned later stop; leaves manual ones", async () => {
    const manager = await createUser("MANAGER");
    const { user, rep } = await createRep("Sue Tate", "America/Chicago", DALLAS);
    await onlyRep(rep.id);
    await db().rep.update({ where: { id: rep.id }, data: { onShift: true } });

    // Today's stop: re-plan, and push because the rep is on shift.
    const today = await makeDoor();
    await manualAssign(manager.id, today.id, { repId: rep.id, date: "2026-10-07" }, NOW);
    await db().job.deleteMany();
    await updateDoor(manager.id, today.id, { priority: "HOT" }, NOW);
    expect((await queued("route.plan")).map((j) => JSON.parse(j.payload))).toEqual([{ repId: rep.id, date: "2026-10-07", trigger: "HOT_DOOR" }]);
    expect(JSON.parse((await queued("push.send"))[0]!.payload)).toMatchObject({ userId: user.id, title: "New hot door" });

    // A later day, assigned by the engine: back through assignment.
    const later = await makeDoor();
    await db().job.deleteMany();
    await assignDoorById(later.id, { reason: "NEW" }, fake.driveTimes, new Date("2026-10-07T20:00:00Z")); // after the cutoff: tomorrow
    expect(await db().assignment.count({ where: { doorId: later.id, status: "ACTIVE", scheduledFor: "2026-10-08" } })).toBe(1);
    await db().job.deleteMany();
    await updateDoor(manager.id, later.id, { priority: "HOT" }, NOW);
    expect(await db().door.findUniqueOrThrow({ where: { id: later.id } })).toMatchObject({ status: "GEOCODED" });
    expect((await queued("door.assign")).map((j) => JSON.parse(j.payload))).toEqual([{ doorId: later.id, reason: "NEW" }]);

    // A manager's own later assignment stays put.
    const manual = await makeDoor();
    await manualAssign(manager.id, manual.id, { repId: rep.id, date: "2026-10-09" }, NOW);
    await updateDoor(manager.id, manual.id, { priority: "HOT" }, NOW);
    expect(await db().door.findUniqueOrThrow({ where: { id: manual.id } })).toMatchObject({ status: "ASSIGNED" });
  });
});

describe("route provider", () => {
  it("uses Google when switched on, and falls back to the local planner when it fails", async () => {
    const admin = await createUser("ADMIN");
    const manager = await createUser("MANAGER");
    const { rep } = await createRep("Ned Orr", "America/Chicago", DALLAS);
    const doors = [await makeDoor({ lat: 32.8, lng: -96.8 }), await makeDoor({ lat: 32.9, lng: -96.8 }), await makeDoor({ lat: 33.0, lng: -96.8 })];
    for (const d of doors) await manualAssign(manager.id, d.id, { repId: rep.id, date: "2026-10-07" }, NOW);
    await updateSettings({ type: "USER", userId: admin.id }, { "routing.provider": "GOOGLE" });

    const assignments = await db().assignment.findMany({ where: { repId: rep.id, status: "ACTIVE" }, include: { door: true } });
    const byLat = [...assignments].sort((a, b) => b.door.lat! - a.door.lat!); // Google visits the farthest first
    const google = {
      async optimizeTours() {
        return { visits: byLat.slice(0, 2).map((a, i) => ({ id: a.id, startTime: new Date(NOW.getTime() + (i + 1) * 3600_000) })), skipped: [byLat[2]!.id] };
      },
    };
    const ok = await planRoute({ repId: rep.id, date: "2026-10-07", trigger: "SCHEDULED" }, google, NOW);
    expect(ok).toMatchObject({ kind: "planned", provider: "GOOGLE", status: "PARTIAL" });
    const planned = await db().assignment.findMany({ where: { repId: rep.id, status: "ACTIVE" }, orderBy: { routeOrder: "asc" } });
    expect(planned.map((a) => a.id)).toEqual(byLat.map((a) => a.id));
    expect(planned[0]!.plannedArrival!.toISOString()).toBe("2026-10-07T15:00:00.000Z");
    expect(await db().routePlan.findFirstOrThrow({ where: { repId: rep.id }, orderBy: { createdAt: "desc" } })).toMatchObject({ provider: "GOOGLE", skippedCount: 1 });

    const failing = { optimizeTours: async () => Promise.reject(new Error("GOOGLE_CLOUD_PROJECT_ID is not set")) };
    const fell = await planRoute({ repId: rep.id, date: "2026-10-07", trigger: "MANAGER" }, failing, NOW);
    expect(fell).toMatchObject({ kind: "planned", provider: "LOCAL", fallback: "GOOGLE_CLOUD_PROJECT_ID is not set" });
    const detail = JSON.parse((await db().routePlan.findFirstOrThrow({ where: { repId: rep.id }, orderBy: { createdAt: "desc" } })).detail!);
    expect(detail.fallback).toContain("GOOGLE_CLOUD_PROJECT_ID");
    expect((await db().assignment.findMany({ where: { repId: rep.id, status: "ACTIVE" } })).every((a) => a.routeOrder !== null)).toBe(true);
  });

  it("skips a rep who is no longer active", async () => {
    const { rep } = await createRep("Oli Park", "America/Chicago", DALLAS);
    await db().rep.update({ where: { id: rep.id }, data: { active: false } });
    expect(await planRoute({ repId: rep.id, date: "2026-10-07", trigger: "SCHEDULED" }, fake, NOW)).toEqual({ kind: "skipped", why: "rep is not active" });
  });
});

describe("unassignable doors and revisits", () => {
  it("marks a door UNASSIGNABLE when there are no active reps, and says so to n8n", async () => {
    await db().rep.updateMany({ data: { active: false } });
    const door = await makeDoor();
    expect(await assignDoorById(door.id, { reason: "NEW" }, fake.driveTimes, NOW)).toEqual({ kind: "unassignable" });
    expect(await db().door.findUniqueOrThrow({ where: { id: door.id } })).toMatchObject({ status: "UNASSIGNABLE" });
    expect(await db().outboxEvent.count({ where: { type: "door.unassignable" } })).toBeGreaterThan(0);
  });

  it("re-visits go to the same rep on the next-step date, over capacity, via the nightly rollover", async () => {
    await db().rep.updateMany({ data: { active: false } });
    const { rep } = await createRep("Pat Quinn", "America/Chicago", DALLAS, { dailyCapacity: 1 });
    const other = await makeDoor();
    await manualAssign((await createUser("MANAGER")).id, other.id, { repId: rep.id, date: "2026-10-09" }, NOW); // capacity of Friday is used
    const door = await makeDoor({ status: "VISITED", preferredRepId: rep.id, nextStepAt: new Date("2026-10-09T15:00:00Z") });

    await db().job.deleteMany();
    const result = await rolloverRep(rep.id, "2026-10-08", new Date("2026-10-09T02:30:00Z")); // Thursday 21:30
    expect(result.revisits).toBe(1);
    expect(JSON.parse((await queued("door.assign"))[0]!.payload)).toEqual({ doorId: door.id, reason: "REVISIT" });

    const assigned = await assignDoorById(door.id, { reason: "REVISIT" }, fake.driveTimes, new Date("2026-10-09T02:30:00Z"));
    expect(assigned).toMatchObject({ kind: "assigned", repId: rep.id, date: "2026-10-09", overCapacity: true });
    expect(await db().door.findUniqueOrThrow({ where: { id: door.id } })).toMatchObject({ status: "ASSIGNED" });
  });
});

describe("day board", () => {
  it("lists the planned day, flags over capacity and audits location history views", async () => {
    const manager = await createUser("MANAGER");
    const { rep } = await createRep("Quin Reed", "America/Chicago", DALLAS, { dailyCapacity: 2 });
    for (let i = 0; i < 3; i++) await manualAssign(manager.id, (await makeDoor()).id, { repId: rep.id, date: "2026-10-07" }, NOW);
    await planRoute({ repId: rep.id, date: "2026-10-07", trigger: "SCHEDULED" }, fake, NOW);
    await db().locationPing.createMany({ data: [0, 1, 2].map((i) => ({ clientId: `ping-${rep.id}-${i}`, repId: rep.id, lat: 32.8 + i * 0.01, lng: -96.8, source: "FOREGROUND", recordedAt: new Date(NOW.getTime() + i * 120_000) })) });

    const day = await getRepDay(manager.id, rep.id, "2026-10-07", NOW);
    expect(day).toMatchObject({ rep: { name: "Quin Reed", isToday: true, unavailable: false }, overCapacity: true, route: { provider: "LOCAL", status: "OK" } });
    expect(day.stops.map((s) => s.routeOrder)).toEqual([1, 2, 3]);
    expect(day.stops.every((s) => s.assignedBy === "MANAGER" && s.plannedArrival)).toBe(true);
    expect(day.pings).toHaveLength(3);
    expect(await db().auditLog.count({ where: { action: "rep.location_viewed", entityId: rep.id } })).toBe(1);

    const empty = await getRepDay(manager.id, rep.id, "2026-10-12", NOW);
    expect(empty).toMatchObject({ stops: [], route: null, overCapacity: false });
    expect(await db().auditLog.count({ where: { action: "rep.location_viewed", entityId: rep.id } })).toBe(1);
  });

  it("queues a re-plan, refusing past days and deactivated reps", async () => {
    const manager = await createUser("MANAGER");
    const { rep } = await createRep("Rae Shaw", "America/Chicago", DALLAS);
    expect(await requestReplan(manager.id, rep.id, "2026-10-07", NOW)).toEqual({ queued: true, date: "2026-10-07" });
    expect(JSON.parse((await queued("route.plan")).find((j) => j.payload.includes(rep.id))!.payload)).toEqual({ repId: rep.id, date: "2026-10-07", trigger: "MANAGER" });
    await expect(requestReplan(manager.id, rep.id, "2026-10-06", NOW)).rejects.toMatchObject({ code: "CONFLICT" });
    await db().rep.update({ where: { id: rep.id }, data: { active: false } });
    await expect(requestReplan(manager.id, rep.id, "2026-10-07", NOW)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
