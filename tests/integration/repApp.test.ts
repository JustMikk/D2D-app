import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as mediaRoute } from "@/app/api/v1/media/[id]/route";
import { db } from "@/lib/db";
import { LocalDiskStorage, setMediaStorage } from "@/lib/integrations/storage";
import { signedMediaUrl } from "@/lib/integrations/mediaSigning";
import { MAX_PUSH_FAILURES, sendPushToUser, setPushSender, type PushSender } from "@/lib/integrations/push";
import { cityFakeGoogle } from "@/lib/integrations/google/cityFake";
import { manualAssign } from "@/lib/services/manualAssignment";
import { readMedia, uploadMedia } from "@/lib/services/media";
import { subscribe, unsubscribe } from "@/lib/services/pushSubscriptions";
import { arrive, endShift, getToday, recordPings, replanFromHere, startShift } from "@/lib/services/repApp";
import { planRoute } from "@/lib/services/routes";
import { createVisit } from "@/lib/services/visits";
import { createRep, createUser } from "./helpers";

const NOW = new Date("2026-10-07T15:00:00Z"); // Wednesday 10:00 in Chicago
const DALLAS = { lat: 32.7767, lng: -96.797 };
const fake = cityFakeGoogle();
const uploadDir = mkdtempSync(join(tmpdir(), "canvass-media-"));

// 1x1 transparent PNG and a minimal JPEG header, enough for the magic-byte check.
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

beforeAll(() => setMediaStorage(new LocalDiskStorage(uploadDir)));
afterAll(() => {
  setMediaStorage(null);
  setPushSender(null);
  rmSync(uploadDir, { recursive: true, force: true });
});

let n = 0;
type Setup = Awaited<ReturnType<typeof setup>>;

/** A rep on shift-ready ground with `doors` stops planned for today. */
async function setup(doorCount = 3, repOver: { dailyCapacity?: number } = {}) {
  const manager = await createUser("MANAGER");
  const { user, rep } = await createRep(`Rep ${++n}`, "America/Chicago", DALLAS, repOver);
  const stops: { doorId: string; assignmentId: string; lat: number; lng: number }[] = [];
  for (let i = 0; i < doorCount; i++) {
    const company = await db().company.create({ data: { name: `Co ${n}-${i}`, nameKey: `co ${n} ${i}` } });
    const lat = 32.78 + i * 0.01;
    const door = await db().door.create({
      data: { externalProspectId: `R-${n}-${i}-${randomUUID()}`, companyId: company.id, name: `Co ${n}-${i}`, status: "GEOCODED", street: `${i + 1} Main St`, city: "Dallas", state: "TX", zip: "75201", lat, lng: -96.8 },
    });
    const { assignmentId } = await manualAssignAndGetId(manager.id, door.id, rep.id);
    stops.push({ doorId: door.id, assignmentId, lat, lng: -96.8 });
  }
  await planRoute({ repId: rep.id, date: "2026-10-07", trigger: "SCHEDULED" }, fake, NOW);
  return { manager, user, rep, stops };
}

async function manualAssignAndGetId(managerId: string, doorId: string, repId: string) {
  const r = await manualAssign(managerId, doorId, { repId, date: "2026-10-07" }, NOW);
  return { assignmentId: r.assignmentId };
}

const fix = (lat: number, lng: number, at = NOW) => ({ lat, lng, accuracyM: 8, capturedAt: at.toISOString() });
const visitBody = (s: Setup, i: number, over: Record<string, unknown> = {}) => ({
  clientId: randomUUID(),
  assignmentId: s.stops[i]!.assignmentId,
  doorId: s.stops[i]!.doorId,
  outcome: "NOT_HOME",
  recordedAt: NOW.toISOString(),
  location: fix(s.stops[i]!.lat, s.stops[i]!.lng),
  ...over,
});
const queued = (type: string) => db().job.findMany({ where: { type, status: "QUEUED" } });

describe("today", () => {
  it("returns the planned stops in route order with a stable version", async () => {
    const s = await setup(3);
    const today = await getToday(s.user.id, undefined, NOW);
    expect(today).toMatchObject({ date: "2026-10-07", timeZone: "America/Chicago", shift: null, route: { provider: "LOCAL" } });
    expect(today.stops.map((x) => x.routeOrder)).toEqual([1, 2, 3]);
    expect(today.stops[0]!.door).toMatchObject({ address: expect.stringMatching(/Main St, Dallas, TX 75201/), priority: "NORMAL", lastVisit: null });
    expect(today.stops[0]!.plannedArrival).toBeTruthy();
    expect((await getToday(s.user.id, undefined, NOW)).pendingServerVersion).toBe(today.pendingServerVersion);

    // A visit changes the version, the stop's outcome and its status.
    await createVisit(s.user.id, visitBody(s, 0), NOW);
    const after = await getToday(s.user.id, undefined, NOW);
    expect(after.pendingServerVersion).not.toBe(today.pendingServerVersion);
    expect(after.stops.find((x) => x.assignmentId === s.stops[0]!.assignmentId)).toMatchObject({ status: "COMPLETED", outcome: "NOT_HOME" });
  });

  it("is only for the rep's own day and for active reps", async () => {
    const s = await setup(1);
    const manager = await createUser("MANAGER");
    await expect(getToday(manager.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db().rep.update({ where: { id: s.rep.id }, data: { active: false } });
    await expect(getToday(s.user.id, undefined, NOW)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("shift", () => {
  it("starts once per clientId; a replay returns 200 and a second tap while on shift changes nothing", async () => {
    const s = await setup(1);
    const clientId = randomUUID();
    const first = await startShift(s.user.id, { clientId, location: fix(32.78, -96.8) }, NOW);
    expect(first).toMatchObject({ status: 201, replayed: false });
    const replay = await startShift(s.user.id, { clientId, location: fix(32.78, -96.8) }, NOW);
    expect(replay).toMatchObject({ status: 200, replayed: true, body: first.body });
    const other = await startShift(s.user.id, { clientId: randomUUID() }, NOW);
    expect(other.body.shift.id).toBe(first.body.shift.id);
    expect(await db().shift.count({ where: { repId: s.rep.id } })).toBe(1);
    expect(await db().rep.findUniqueOrThrow({ where: { id: s.rep.id } })).toMatchObject({ onShift: true, lastLat: 32.78, lastLocationSource: "START_DAY" });
    expect(await db().locationPing.count({ where: { repId: s.rep.id, source: "START_DAY" } })).toBe(1);
  });

  it("uses the device time, never the future", async () => {
    const s = await setup(1);
    const r = await startShift(s.user.id, { clientId: randomUUID(), recordedAt: "2026-10-07T14:00:00Z" }, NOW);
    expect(r.body.shift.startedAt).toBe("2026-10-07T14:00:00.000Z");
    const s2 = await setup(1);
    const future = await startShift(s2.user.id, { clientId: randomUUID(), recordedAt: "2027-01-01T00:00:00Z" }, NOW);
    expect(new Date(future.body.shift.startedAt).getTime()).toBeLessThanOrEqual(NOW.getTime() + 5 * 60_000);
  });

  it("ends the day, reporting the stops left, and records the final fix", async () => {
    const s = await setup(3);
    await startShift(s.user.id, { clientId: randomUUID() }, NOW);
    await createVisit(s.user.id, visitBody(s, 0), NOW);
    const clientId = randomUUID();
    const end = await endShift(s.user.id, { clientId, location: fix(32.8, -96.8) }, NOW);
    expect(end.body).toEqual({ remainingStops: 2 });
    expect((await endShift(s.user.id, { clientId, location: fix(32.8, -96.8) }, NOW)).replayed).toBe(true);
    expect(await db().rep.findUniqueOrThrow({ where: { id: s.rep.id } })).toMatchObject({ onShift: false, lastLocationSource: "END_DAY" });
    expect(await db().shift.findFirstOrThrow({ where: { repId: s.rep.id } })).toMatchObject({ endedBy: "REP" });
    // The stops stay on today's route until the 21:00 rollover moves them.
    expect(await db().assignment.count({ where: { repId: s.rep.id, status: "ACTIVE" } })).toBe(2);
  });
});

describe("location pings", () => {
  const ping = (over: Record<string, unknown> = {}) => ({ clientId: randomUUID(), source: "FOREGROUND", ...fix(32.9, -96.7), ...over });

  it("accepts pings on shift, dedupes retries, and moves the rep's last location forward only", async () => {
    const s = await setup(1);
    await startShift(s.user.id, { clientId: randomUUID() }, NOW);
    const a = ping({ capturedAt: "2026-10-07T15:10:00Z", lat: 32.91 });
    const b = ping({ capturedAt: "2026-10-07T15:20:00Z", lat: 32.92 });
    const older = ping({ capturedAt: "2026-10-07T15:05:00Z", lat: 32.5 });
    expect(await recordPings(s.user.id, { pings: [b, a, older] }, new Date("2026-10-07T15:30:00Z"))).toEqual({ accepted: 3, duplicates: 0, ignored: 0 });
    expect(await recordPings(s.user.id, { pings: [a, b] }, new Date("2026-10-07T15:30:00Z"))).toEqual({ accepted: 0, duplicates: 2, ignored: 0 });
    const rep = await db().rep.findUniqueOrThrow({ where: { id: s.rep.id } });
    expect(rep.lastLat).toBe(32.92);
    expect(rep.lastLocationAt!.toISOString()).toBe("2026-10-07T15:20:00.000Z");
  });

  it("ignores pings off shift (except END_DAY) without failing the batch", async () => {
    const s = await setup(1);
    const r = await recordPings(s.user.id, { pings: [ping(), ping({ source: "END_DAY" })] }, NOW);
    expect(r).toEqual({ accepted: 1, duplicates: 0, ignored: 1 });
    expect(await db().locationPing.count({ where: { repId: s.rep.id } })).toBe(1);
    await expect(recordPings(s.user.id, { pings: [] }, NOW)).rejects.toThrow();
    await expect(recordPings(s.user.id, { pings: Array.from({ length: 101 }, () => ping()) }, NOW)).rejects.toThrow();
  });
});

describe("arrive", () => {
  it("measures the distance, flags off-site beyond 200 m, keeps the first arrival and is idempotent", async () => {
    const s = await setup(2);
    const stop = s.stops[0]!;
    const near = await arrive(s.user.id, stop.assignmentId, { clientId: randomUUID(), location: fix(stop.lat + 0.0005, stop.lng) }, NOW); // about 55 m
    expect(near.body.offSite).toBe(false);
    expect(near.body.distanceM).toBeGreaterThan(40);
    expect(near.body.distanceM).toBeLessThan(70);
    // A second arrival keeps the first.
    expect((await arrive(s.user.id, stop.assignmentId, { clientId: randomUUID(), location: fix(stop.lat + 0.01, stop.lng) }, NOW)).body).toEqual(near.body);

    const far = s.stops[1]!;
    const clientId = randomUUID();
    const off = await arrive(s.user.id, far.assignmentId, { clientId, location: fix(far.lat + 0.004, far.lng) }, NOW); // about 440 m
    expect(off.body.offSite).toBe(true);
    expect((await arrive(s.user.id, far.assignmentId, { clientId, location: fix(far.lat, far.lng) }, NOW)).replayed).toBe(true);
  });

  it("with no location flags the stop off-site and never blocks", async () => {
    const s = await setup(1);
    expect((await arrive(s.user.id, s.stops[0]!.assignmentId, { clientId: randomUUID() }, NOW)).body).toEqual({ distanceM: null, offSite: true });
  });

  it("is only for the rep's own stops", async () => {
    const s = await setup(1);
    const other = await setup(1);
    await expect(arrive(other.user.id, s.stops[0]!.assignmentId, { clientId: randomUUID() }, NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("visits and outcome rules", () => {
  it("saves a visit once: a retry returns the original with 200 and no second row", async () => {
    const s = await setup(2);
    const body = visitBody(s, 0, { outcome: "NOT_INTERESTED", notes: "Owner declined" });
    const first = await createVisit(s.user.id, body, NOW);
    expect(first).toMatchObject({ status: 201, replayed: false, body: { visit: { outcome: "NOT_INTERESTED", offSite: false }, door: { status: "CLOSED" } } });
    const retry = await createVisit(s.user.id, body, new Date(NOW.getTime() + 60_000));
    expect(retry).toMatchObject({ status: 200, replayed: true });
    expect(retry.body).toEqual(first.body);
    expect(await db().visit.count({ where: { repId: s.rep.id } })).toBe(1);
    expect(await db().outboxEvent.count({ where: { type: "visit.recorded" } })).toBeGreaterThanOrEqual(1);
    expect(await db().assignment.findUniqueOrThrow({ where: { id: s.stops[0]!.assignmentId } })).toMatchObject({ status: "COMPLETED" });
    expect(await db().door.findUniqueOrThrow({ where: { id: s.stops[0]!.doorId } })).toMatchObject({ status: "CLOSED", closedReason: "NOT_INTERESTED", lastOutcome: "NOT_INTERESTED" });
  });

  it("survives two simultaneous copies of the same visit", async () => {
    const s = await setup(1);
    const body = visitBody(s, 0);
    const results = await Promise.all([createVisit(s.user.id, body, NOW), createVisit(s.user.id, body, NOW)]);
    expect(results.map((r) => r.body.visit.id)[0]).toBe(results.map((r) => r.body.visit.id)[1]);
    expect(await db().visit.count({ where: { repId: s.rep.id } })).toBe(1);
  });

  it("not home: back to Ready for the engine, closing at the third attempt", async () => {
    const s = await setup(1);
    const doorId = s.stops[0]!.doorId;
    await db().job.deleteMany();
    await createVisit(s.user.id, visitBody(s, 0), NOW);
    expect(await db().door.findUniqueOrThrow({ where: { id: doorId } })).toMatchObject({ status: "GEOCODED", attempts: 1, lastOutcome: "NOT_HOME" });
    expect((await queued("door.assign")).map((j) => JSON.parse(j.payload))).toEqual([{ doorId, reason: "NOT_HOME" }]);

    await db().door.update({ where: { id: doorId }, data: { attempts: 2 } });
    const again = await createVisit(s.user.id, visitBody(s, 0), NOW);
    expect(again.body.door.status).toBe("CLOSED");
    expect(await db().door.findUniqueOrThrow({ where: { id: doorId } })).toMatchObject({ closedReason: "MAX_ATTEMPTS", attempts: 3 });
  });

  it("follow-up and appointment need a future next step and keep the rep for the re-visit", async () => {
    const s = await setup(2);
    await expect(createVisit(s.user.id, visitBody(s, 0, { outcome: "FOLLOW_UP" }), NOW)).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: [{ path: "nextStepAt" }] });
    await expect(createVisit(s.user.id, visitBody(s, 0, { outcome: "FOLLOW_UP", nextStepAt: "2026-10-07T14:00:00Z" }), NOW)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const ok = await createVisit(s.user.id, visitBody(s, 0, { outcome: "FOLLOW_UP", nextStepAt: "2026-10-09T15:00:00Z", decisionMakerPresent: true }), NOW);
    expect(ok.body.door).toEqual({ status: "VISITED", nextStepAt: "2026-10-09T15:00:00.000Z" });
    expect(await db().door.findUniqueOrThrow({ where: { id: s.stops[0]!.doorId } })).toMatchObject({ preferredRepId: s.rep.id });
    expect(await db().visit.findFirstOrThrow({ where: { doorId: s.stops[0]!.doorId } })).toMatchObject({ decisionMakerPresent: true });

    await db().outboxEvent.deleteMany();
    await createVisit(s.user.id, visitBody(s, 1, { outcome: "APPOINTMENT_SET", nextStepAt: "2026-10-10T16:00:00Z" }), NOW);
    expect(await db().outboxEvent.count({ where: { type: "visit.hot" } })).toBe(1);
  });

  it("judges a queued visit by when it was saved, not when it synced", async () => {
    const s = await setup(1);
    // Saved at 10:00, next step 10:30, synced two hours later: still valid.
    const synced = new Date("2026-10-07T17:00:00Z");
    const r = await createVisit(s.user.id, visitBody(s, 0, { outcome: "FOLLOW_UP", recordedAt: NOW.toISOString(), nextStepAt: "2026-10-07T15:30:00Z" }), synced);
    expect(r.status).toBe(201);
    const stored = await db().visit.findFirstOrThrow({ where: { repId: s.rep.id } });
    expect(stored.recordedAt.toISOString()).toBe(NOW.toISOString());
    expect(stored.receivedAt.toISOString()).toBe(synced.toISOString());
  });

  it("a sale needs a signature, and the hot event carries signed media links", async () => {
    const s = await setup(1);
    await expect(createVisit(s.user.id, visitBody(s, 0, { outcome: "SOLD" }), NOW)).rejects.toMatchObject({ details: [{ path: "signatureMediaId" }] });
    const sig = await uploadMedia(s.user.id, { clientId: randomUUID(), kind: "SIGNATURE" }, PNG, NOW);
    const photo = await uploadMedia(s.user.id, { clientId: randomUUID(), kind: "PHOTO" }, JPEG, NOW);
    await db().outboxEvent.deleteMany();
    const r = await createVisit(s.user.id, visitBody(s, 0, { outcome: "SOLD", signatureMediaId: sig.mediaId, photoMediaIds: [photo.mediaId] }), NOW);
    expect(r.body.door.status).toBe("CLOSED");
    const hot = JSON.parse((await db().outboxEvent.findFirstOrThrow({ where: { type: "visit.hot" } })).payload);
    expect(hot.data.visit.signatureUrl).toContain(`/api/v1/media/${sig.mediaId}?exp=`);
    expect(hot.data.visit.photoUrls).toHaveLength(1);
    expect(await db().media.findUniqueOrThrow({ where: { id: sig.mediaId } })).toMatchObject({ visitId: r.body.visit.id });
  });

  it("bad address goes to review with the rep's note and fix, and alerts ops", async () => {
    const s = await setup(1);
    await db().outboxEvent.deleteMany();
    const r = await createVisit(s.user.id, visitBody(s, 0, { outcome: "BAD_ADDRESS", notes: "Empty lot" }), NOW);
    expect(r.body.door.status).toBe("NEEDS_REVIEW");
    const door = await db().door.findUniqueOrThrow({ where: { id: s.stops[0]!.doorId } });
    expect(door).toMatchObject({ reviewReason: "BAD_ADDRESS" });
    expect(JSON.parse(door.reviewDetail!)).toMatchObject({ note: "Empty lot", reportedAt: { lat: s.stops[0]!.lat } });
    expect(await db().outboxEvent.count({ where: { type: "door.needs_review" } })).toBe(1);
  });

  it("flags a visit far from the door, or with no location, as off-site (never blocked)", async () => {
    const s = await setup(2);
    const far = await createVisit(s.user.id, visitBody(s, 0, { location: fix(33.5, -96.8) }), NOW);
    expect(far.body.visit.offSite).toBe(true);
    expect((await db().visit.findFirstOrThrow({ where: { doorId: s.stops[0]!.doorId } })).distanceFromDoorM).toBeGreaterThan(50_000);
    const none = await createVisit(s.user.id, visitBody(s, 1, { location: null }), NOW);
    expect(none.body.visit.offSite).toBe(true);
    expect(await db().visit.findFirstOrThrow({ where: { doorId: s.stops[1]!.doorId } })).toMatchObject({ lat: null, distanceFromDoorM: null });
  });

  it("accepts a visit for a stop that was reassigned meanwhile, flags it and cancels the newer assignment", async () => {
    const s = await setup(1);
    const other = await createRep("Other Rep", "America/Chicago", DALLAS);
    // The manager moves the door to another rep while the first rep's phone is offline.
    await manualAssign(s.manager.id, s.stops[0]!.doorId, { repId: other.rep.id, date: "2026-10-08" }, NOW);
    expect(await db().assignment.findUniqueOrThrow({ where: { id: s.stops[0]!.assignmentId } })).toMatchObject({ status: "CANCELLED" });

    const r = await createVisit(s.user.id, visitBody(s, 0, { outcome: "NOT_INTERESTED" }), NOW);
    expect(r.body.visit.assignmentMismatch).toBe(true);
    expect(await db().assignment.findUniqueOrThrow({ where: { id: s.stops[0]!.assignmentId } })).toMatchObject({ status: "COMPLETED" });
    expect(await db().assignment.count({ where: { doorId: s.stops[0]!.doorId, status: "ACTIVE" } })).toBe(0);
    expect(await db().door.findUniqueOrThrow({ where: { id: s.stops[0]!.doorId } })).toMatchObject({ status: "CLOSED" });
  });

  it("keeps a door a manager already closed closed, and still records the visit", async () => {
    const s = await setup(1);
    await db().door.update({ where: { id: s.stops[0]!.doorId }, data: { status: "CLOSED", closedReason: "MANUAL", closedAt: NOW } });
    await db().job.deleteMany();
    const r = await createVisit(s.user.id, visitBody(s, 0), NOW); // not home
    expect(r.body.door.status).toBe("CLOSED");
    expect(await queued("door.assign")).toHaveLength(0);
    expect(await db().visit.count({ where: { repId: s.rep.id } })).toBe(1);
  });

  it("refuses another rep's stop (404), a mismatched door, and a stop over 7 days old", async () => {
    const s = await setup(1);
    const other = await setup(1);
    await expect(createVisit(other.user.id, visitBody(s, 0), NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(createVisit(s.user.id, visitBody(s, 0, { doorId: other.stops[0]!.doorId }), NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db().assignment.update({ where: { id: s.stops[0]!.assignmentId }, data: { scheduledFor: "2026-09-25" } });
    await expect(createVisit(s.user.id, visitBody(s, 0), NOW)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("validates fields and media ownership", async () => {
    const s = await setup(1);
    const other = await setup(1);
    await expect(createVisit(s.user.id, visitBody(s, 0, { outcome: "WAVED" }), NOW)).rejects.toThrow();
    await expect(createVisit(s.user.id, visitBody(s, 0, { clientId: "not-a-uuid" }), NOW)).rejects.toThrow();
    await expect(createVisit(s.user.id, visitBody(s, 0, { notes: "x".repeat(2001) }), NOW)).rejects.toThrow();
    const theirs = await uploadMedia(other.user.id, { clientId: randomUUID(), kind: "PHOTO" }, JPEG, NOW);
    await expect(createVisit(s.user.id, visitBody(s, 0, { photoMediaIds: [theirs.mediaId] }), NOW)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const used = await uploadMedia(s.user.id, { clientId: randomUUID(), kind: "PHOTO" }, JPEG, NOW);
    await createVisit(s.user.id, visitBody(s, 0, { outcome: "NOT_INTERESTED", photoMediaIds: [used.mediaId] }), NOW);
    const second = await setup(1);
    await expect(createVisit(second.user.id, visitBody(second, 0, { photoMediaIds: [used.mediaId] }), NOW)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(createVisit(s.user.id, visitBody(s, 0, { photoMediaIds: ["a", "b", "c", "d"] }), NOW)).rejects.toThrow();
  });

  it("records the visit's fix as a location ping only while on shift", async () => {
    const s = await setup(2);
    await createVisit(s.user.id, visitBody(s, 0), NOW);
    expect(await db().locationPing.count({ where: { repId: s.rep.id, source: "VISIT" } })).toBe(0);
    await startShift(s.user.id, { clientId: randomUUID() }, NOW);
    await createVisit(s.user.id, visitBody(s, 1), NOW);
    expect(await db().locationPing.count({ where: { repId: s.rep.id, source: "VISIT" } })).toBe(1);
  });
});

describe("re-plan from here", () => {
  it("re-orders the open stops from the rep's fix, after the visited ones", async () => {
    const s = await setup(3);
    await createVisit(s.user.id, visitBody(s, 0), NOW);
    const today = await replanFromHere(s.user.id, { location: fix(32.8, -96.8) }, NOW);
    expect(today.stops.filter((x) => x.status === "ACTIVE").map((x) => x.routeOrder)).toEqual([2, 3]);
    const plan = await db().routePlan.findFirstOrThrow({ where: { repId: s.rep.id, trigger: "REP" } });
    expect(plan).toMatchObject({ provider: "LOCAL", startLat: 32.8 });
  });
});

describe("media", () => {
  it("stores images by magic bytes, once per clientId, and refuses everything else", async () => {
    const s = await setup(1);
    const clientId = randomUUID();
    const first = await uploadMedia(s.user.id, { clientId, kind: "PHOTO" }, PNG, NOW);
    expect((await uploadMedia(s.user.id, { clientId, kind: "PHOTO" }, PNG, NOW)).mediaId).toBe(first.mediaId);
    const row = await db().media.findUniqueOrThrow({ where: { id: first.mediaId } });
    expect(row).toMatchObject({ mimeType: "image/png", kind: "PHOTO", uploadedById: s.user.id });
    expect(row.path).toMatch(/^2026\/10\/[0-9a-f-]+\.png$/);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);

    const text = new TextEncoder().encode("<script>alert(1)</script>");
    await expect(uploadMedia(s.user.id, { clientId: randomUUID(), kind: "PHOTO" }, text, NOW)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(JPEG);
    await expect(uploadMedia(s.user.id, { clientId: randomUUID(), kind: "PHOTO" }, big, NOW)).rejects.toMatchObject({ message: "Photo is over 5 MB. Take a smaller one or skip it." });
    await expect(uploadMedia(s.user.id, { clientId: randomUUID(), kind: "PHOTO" }, new Uint8Array(0), NOW)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(uploadMedia(s.user.id, { clientId: "x", kind: "PHOTO" }, PNG, NOW)).rejects.toThrow();

    // Another user cannot reuse the clientId.
    const other = await setup(1);
    await expect(uploadMedia(other.user.id, { clientId, kind: "PHOTO" }, PNG, NOW)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("is readable by the uploader and console users, not other reps (404), and by a valid signed link", async () => {
    const s = await setup(1);
    const other = await setup(1);
    const manager = await createUser("MANAGER");
    const { mediaId } = await uploadMedia(s.user.id, { clientId: randomUUID(), kind: "PHOTO" }, PNG, NOW);
    expect((await readMedia(mediaId, { userId: s.user.id, role: "REP" })).mimeType).toBe("image/png");
    expect((await readMedia(mediaId, { userId: manager.id, role: "MANAGER" })).bytes.length).toBe(PNG.length);
    await expect(readMedia(mediaId, { userId: other.user.id, role: "REP" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await readMedia(mediaId, { signed: true })).mimeType).toBe("image/png");

    // The route checks the signature (and the expiry) itself. A request with no session at all is covered
    // by the browser tests, because it needs a real request context.
    const url = signedMediaUrl("http://canvass.test", process.env.MEDIA_SIGNING_SECRET!, mediaId);
    const call = (u: string) => mediaRoute(new NextRequest(u), { params: Promise.resolve({ id: mediaId }) });
    const ok = await call(url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("content-disposition")).toBe("inline");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await call(url.replace(/sig=[^&]+/, "sig=bogus"))).status).toBe(403);
    expect((await call(url.replace(/exp=[0-9]+/, "exp=1"))).status).toBe(403);
  });
});

describe("push", () => {
  const sub = (n: number) => ({ endpoint: `https://push.example/${n}-${randomUUID()}`, keys: { p256dh: "p256dh-key", auth: "auth-key" } });
  const payload = { title: "New hot door", body: "New hot door: Acme, 2.1 mi away", url: "/today", tag: "hot-door" };

  it("sends to every device, removes dead ones, and drops a device after repeated failures", async () => {
    const { user } = await createRep("Push Rep", "America/Chicago", DALLAS);
    const good = sub(1);
    const gone = sub(2);
    const flaky = sub(3);
    for (const x of [good, gone, flaky]) await subscribe(user.id, x);
    const calls: string[] = [];
    const sender: PushSender = {
      async send(target, body) {
        calls.push(`${target.endpoint}|${body}`);
        if (target.endpoint === gone.endpoint) throw Object.assign(new Error("Gone"), { statusCode: 410 });
        if (target.endpoint === flaky.endpoint) throw Object.assign(new Error("Server error"), { statusCode: 503 });
      },
    };
    setPushSender(sender);
    expect(await sendPushToUser(user.id, payload, sender, NOW)).toEqual({ sent: 1, removed: 1, failed: 1, skipped: null });
    expect(JSON.parse(calls[0]!.split("|")[1]!)).toEqual(payload);
    expect(await db().pushSubscription.count({ where: { userId: user.id } })).toBe(2);
    expect((await db().pushSubscription.findUniqueOrThrow({ where: { endpoint: good.endpoint } })).lastSuccessAt).not.toBeNull();

    for (let i = 1; i < MAX_PUSH_FAILURES; i++) await sendPushToUser(user.id, payload, sender, NOW);
    expect(await db().pushSubscription.findUnique({ where: { endpoint: flaky.endpoint } })).toBeNull();
    expect(await db().pushSubscription.count({ where: { userId: user.id } })).toBe(1);
  });

  it("moves a device to the user who signed in on it, unsubscribes, and skips users with no device", async () => {
    const a = await createRep("Dev A", "America/Chicago", DALLAS);
    const b = await createRep("Dev B", "America/Chicago", DALLAS);
    const device = sub(9);
    await subscribe(a.user.id, device);
    await subscribe(b.user.id, device);
    expect(await db().pushSubscription.count({ where: { endpoint: device.endpoint } })).toBe(1);
    expect((await db().pushSubscription.findUniqueOrThrow({ where: { endpoint: device.endpoint } })).userId).toBe(b.user.id);
    expect(await unsubscribe(a.user.id, { endpoint: device.endpoint })).toEqual({ removed: 0 });
    expect(await unsubscribe(b.user.id, { endpoint: device.endpoint })).toEqual({ removed: 1 });
    expect(await sendPushToUser(a.user.id, payload, { send: async () => {} }, NOW)).toMatchObject({ skipped: "no_subscriptions" });
    await expect(subscribe(a.user.id, { endpoint: "not a url", keys: {} })).rejects.toThrow();
  });

  it("without VAPID keys the job quietly sends nothing", async () => {
    setPushSender(null);
    const saved = [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY];
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    try {
      expect(await sendPushToUser("anyone", payload)).toMatchObject({ skipped: "not_configured" });
    } finally {
      [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY] = saved as [string, string];
    }
  });
});
