import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { buildDigest, doorSnapshot, emit } from "@/lib/events";
import { verifySignature } from "@/lib/integrations/webhooks";
import { listOutbox, retryJob, retryOutboxEvent, listJobs } from "@/lib/services/ops";
import { deliverDueEvents } from "@/worker/outbox";
import { createUser } from "./helpers";

const SECRET = "w".repeat(40);
type Received = { headers: IncomingHttpHeaders; body: string };
const received: Received[] = [];
let respondWith = 200;
let url = "";
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ headers: req.headers, body });
    res.statusCode = respondWith;
    res.end(respondWith === 200 ? "ok" : "nope");
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(async () => {
  received.length = 0;
  respondWith = 200;
  await db().outboxEvent.deleteMany();
});

async function makeDoor() {
  const company = await db().company.create({ data: { name: "Bluebonnet Dental Group", nameKey: "bluebonnet dental", website: "https://bluebonnet.example", domain: "bluebonnet.example" } });
  const repUser = await createUser("REP");
  const rep = await db().rep.findUniqueOrThrow({ where: { userId: repUser.id } });
  const door = await db().door.create({
    data: {
      externalProspectId: `P-${Math.random()}`,
      companyId: company.id,
      name: "Bluebonnet Dental Group – 6101 Preston Rd",
      status: "ASSIGNED",
      street: "6101 Preston Rd",
      city: "Plano",
      state: "TX",
      zip: "75093",
      jobCity: "Plano",
      jobState: "TX",
      lat: 33.06,
      lng: -96.8,
      geocodeQuality: "ROOFTOP",
      addressSource: "COMPANY_ADDRESS",
      priority: "HOT",
    },
  });
  await db().assignment.create({ data: { doorId: door.id, repId: rep.id, scheduledFor: "2026-10-07", assignedBy: "ENGINE", routeOrder: 3 } });
  return { door, rep, repUser };
}

describe("events", () => {
  it("emits an envelope into the outbox", async () => {
    const env = await emit(db(), "door.created", { hello: 1 }, new Date("2026-10-07T15:00:00Z"));
    expect(env).toMatchObject({ type: "door.created", version: 1, occurredAt: "2026-10-07T15:00:00.000Z", data: { hello: 1 } });
    expect(env.id).toMatch(/^evt_[0-9a-f]{32}$/);
    const row = await db().outboxEvent.findUniqueOrThrow({ where: { id: env.id } });
    expect(JSON.parse(row.payload)).toEqual(env);
    expect(row.status).toBe("PENDING");
  });

  it("carries the company address and a local next-step date", async () => {
    const { door, rep } = await makeDoor();
    const zone = (await db().rep.findUniqueOrThrow({ where: { id: rep.id } })).timeZone;
    // 02:30 UTC the next day is still the evening before in every US zone, so the UTC date would be wrong.
    await db().door.update({ where: { id: door.id }, data: { nextStepAt: new Date("2026-10-15T02:30:00Z") } });
    await db().company.update({ where: { id: door.companyId }, data: { street: "1 Main St", city: "Plano", state: "TX", zip: "75093" } });
    const snap = await doorSnapshot(db(), door.id);
    expect(snap.nextStepAt).toBe("2026-10-15T02:30:00.000Z");
    expect(snap.nextStepDate).toBe(zone.startsWith("America/") ? "2026-10-14" : snap.nextStepDate);
    expect(snap.company.address).toEqual({ street: "1 Main St", city: "Plano", state: "TX", zip: "75093" });
  });

  it("builds a door snapshot with its active assignment", async () => {
    const { door, rep, repUser } = await makeDoor();
    const snap = await doorSnapshot(db(), door.id);
    expect(snap).toMatchObject({
      id: door.id,
      status: "ASSIGNED",
      priority: "HOT",
      address: { street: "6101 Preston Rd", city: "Plano", state: "TX", zip: "75093" },
      jobLocation: "Plano, TX",
      company: { name: "Bluebonnet Dental Group", domain: "bluebonnet.example" },
      currentAssignment: { repId: rep.id, repName: repUser.name, scheduledFor: "2026-10-07", routeOrder: 3, plannedArrival: null },
    });
  });

  it("builds the daily digest per rep", async () => {
    const { door, rep } = await makeDoor();
    const visit = (outcome: string, recordedAt: string) =>
      db().visit.create({ data: { clientId: `${outcome}-${recordedAt}-${Math.random()}`, doorId: door.id, repId: rep.id, outcome, recordedAt: new Date(recordedAt) } });
    await visit("NOT_HOME", "2026-10-07T15:00:00Z");
    await visit("APPOINTMENT_SET", "2026-10-07T16:00:00Z");
    await visit("SOLD", "2026-10-07T23:30:00Z"); // 18:30 CDT, same day
    await visit("SOLD", "2026-10-08T06:00:00Z"); // next day in Chicago
    await db().routePlan.create({ data: { repId: rep.id, date: "2026-10-07", provider: "LOCAL", trigger: "SCHEDULED", status: "OK", startLat: 0, startLng: 0, totalDriveMinutes: 95 } });

    const digest = await buildDigest(db(), "2026-10-07", "America/Chicago");
    const row = digest.reps.find((r) => r.repId === rep.id)!;
    expect(row).toMatchObject({ visited: 3, contacts: 2, appointments: 1, sales: 1, notVisited: 1, driveMinutes: 95 });
    expect(digest.totals.visited).toBeGreaterThanOrEqual(3);
  });
});

describe("outbox delivery", () => {
  it("posts signed events in order and marks them SENT", async () => {
    const now = new Date();
    const a = await emit(db(), "door.created", { n: 1 }, new Date(now.getTime() - 2000));
    const b = await emit(db(), "visit.hot", { n: 2 }, new Date(now.getTime() - 1000));
    expect(await deliverDueEvents({ url, secret: SECRET })).toEqual({ sent: 2, retried: 0, failed: 0 });

    expect(received.map((r) => r.headers["x-canvass-delivery"])).toEqual([a.id, b.id]);
    const first = received[0]!;
    expect(first.headers["x-canvass-event"]).toBe("door.created");
    expect(JSON.parse(first.body)).toEqual(a);
    expect(
      verifySignature(SECRET, { timestamp: String(first.headers["x-canvass-timestamp"]), signature: String(first.headers["x-canvass-signature"]) }, first.body),
    ).toBe(true);
    expect((await db().outboxEvent.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("SENT");
    expect(await deliverDueEvents({ url, secret: SECRET })).toEqual({ sent: 0, retried: 0, failed: 0 });
  });

  it("retries on non-2xx on the schedule, then fails; an admin can retry it", async () => {
    respondWith = 500;
    const t0 = new Date();
    const evt = await emit(db(), "visit.hot", { n: 1 }, t0);
    let clock = t0.getTime();
    for (let attempt = 1; attempt <= 10; attempt++) {
      expect(await deliverDueEvents({ url, secret: SECRET, now: () => new Date(clock) })).toMatchObject({ retried: 1 });
      const row = await db().outboxEvent.findUniqueOrThrow({ where: { id: evt.id } });
      expect(row).toMatchObject({ status: "PENDING", attempts: attempt });
      expect(row.lastError).toContain("HTTP 500");
      // Not due a moment before the scheduled retry.
      expect(await deliverDueEvents({ url, secret: SECRET, now: () => new Date(row.nextAttemptAt.getTime() - 1) })).toMatchObject({ retried: 0 });
      clock = row.nextAttemptAt.getTime();
    }
    expect(await deliverDueEvents({ url, secret: SECRET, now: () => new Date(clock) })).toMatchObject({ failed: 1 });
    expect(await db().outboxEvent.findUniqueOrThrow({ where: { id: evt.id } })).toMatchObject({ status: "FAILED", attempts: 11 });
    expect(received).toHaveLength(11);

    const admin = await createUser("ADMIN");
    expect((await listOutbox({ status: "FAILED", limit: 50 })).items.map((e) => e.id)).toEqual([evt.id]);
    await retryOutboxEvent(admin.id, evt.id);
    respondWith = 200;
    expect(await deliverDueEvents({ url, secret: SECRET })).toMatchObject({ sent: 1 });
    await expect(retryOutboxEvent(admin.id, evt.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("treats an unreachable receiver as a failure to retry", async () => {
    await emit(db(), "door.created", {}, new Date());
    expect(await deliverDueEvents({ url: "http://127.0.0.1:9/nothing", secret: SECRET })).toMatchObject({ retried: 1 });
  });
});

describe("failed jobs", () => {
  it("lists failed jobs and retries one", async () => {
    const admin = await createUser("ADMIN");
    const job = await db().job.create({ data: { type: "digest.send", payload: '{"date":"2026-10-07"}', status: "FAILED", attempts: 5, lastError: "boom" } });
    const listed = await listJobs({ status: "FAILED", limit: 50 });
    expect(listed.items.find((j) => j.id === job.id)).toMatchObject({ payload: { date: "2026-10-07" }, lastError: "boom" });
    expect(await retryJob(admin.id, job.id)).toEqual({ id: job.id, status: "QUEUED" });
    expect(await db().job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ attempts: 0, lastError: null });
    expect(await db().auditLog.count({ where: { action: "job.retried", entityId: job.id } })).toBe(1);
  });
});
