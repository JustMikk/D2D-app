import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { writeHeartbeat } from "@/lib/heartbeat";
import { enqueue } from "@/lib/jobs";
import { HANDLERS } from "@/worker/handlers";
import { PermanentJobError, recoverStaleLocks, runDueJobs, type HandlerMap } from "@/worker/runner";
import { schedulerTick } from "@/worker/scheduler";
import { GET as healthRoute } from "@/app/api/v1/health/route";
import { NextRequest } from "next/server";
import { createUser } from "./helpers";

const T0 = new Date("2026-10-07T15:00:00Z");
const at = (ms: number) => () => new Date(T0.getTime() + ms);

async function clearJobs() {
  await db().job.deleteMany();
}

describe("enqueue", () => {
  it("ignores a second job with the same dedupeKey while the first is queued", async () => {
    await clearJobs();
    expect(await enqueue(db(), "digest.send", { date: "2026-10-07" }, { dedupeKey: "digest:x" })).toHaveProperty("id");
    expect(await enqueue(db(), "digest.send", { date: "2026-10-07" }, { dedupeKey: "digest:x" })).toBeNull();
    expect(await db().job.count()).toBe(1);
  });

  it("validates the payload", async () => {
    await expect(enqueue(db(), "digest.send", { date: "Oct 7" })).rejects.toThrow();
  });
});

describe("runDueJobs", () => {
  it("runs due jobs, marks them DONE and frees the dedupeKey", async () => {
    await clearJobs();
    const seen: string[] = [];
    const handlers: HandlerMap = { "digest.send": async (p) => void seen.push(p.date) };
    await enqueue(db(), "digest.send", { date: "2026-10-07" }, { dedupeKey: "d1", runAt: T0 });
    await enqueue(db(), "digest.send", { date: "2026-10-08" }, { runAt: new Date(T0.getTime() + 60_000) }); // not due yet
    expect(await runDueJobs(handlers, "w1", at(0))).toBe(1);
    expect(seen).toEqual(["2026-10-07"]);
    const done = await db().job.findFirstOrThrow({ where: { status: "DONE" } });
    expect(done).toMatchObject({ attempts: 1, dedupeKey: null, lockedBy: null });
    // The key is free again.
    expect(await enqueue(db(), "digest.send", { date: "2026-10-07" }, { dedupeKey: "d1" })).not.toBeNull();
  });

  it("retries with backoff, then fails after maxAttempts", async () => {
    await clearJobs();
    let calls = 0;
    const handlers: HandlerMap = {
      "digest.send": async () => {
        calls++;
        throw new Error("n8n down");
      },
    };
    await enqueue(db(), "digest.send", { date: "2026-10-07" }, { dedupeKey: "d2", runAt: T0, maxAttempts: 3 });
    await runDueJobs(handlers, "w1", at(0));
    let job = await db().job.findFirstOrThrow();
    expect(job).toMatchObject({ status: "QUEUED", attempts: 1, lastError: "Error: n8n down" });
    expect(job.runAt.getTime() - T0.getTime()).toBe(30_000);

    expect(await runDueJobs(handlers, "w1", at(10_000))).toBe(0); // backoff not over
    await runDueJobs(handlers, "w1", at(30_000));
    job = await db().job.findFirstOrThrow();
    expect(job).toMatchObject({ status: "QUEUED", attempts: 2 });
    expect(job.runAt.getTime() - T0.getTime()).toBe(30_000 + 60_000);

    await runDueJobs(handlers, "w1", at(90_000));
    job = await db().job.findFirstOrThrow();
    expect(job).toMatchObject({ status: "FAILED", attempts: 3, dedupeKey: null });
    expect(calls).toBe(3);
  });

  it("leaves jobs without a handler queued; fails at once for a bad payload or a permanent error", async () => {
    await clearJobs();
    await db().job.create({ data: { type: "route.plan", payload: JSON.stringify({ repId: "r", date: "2026-10-07", trigger: "SCHEDULED" }), runAt: T0 } });
    await db().job.create({ data: { type: "digest.send", payload: JSON.stringify({ date: 7 }), runAt: T0 } });
    await db().job.create({ data: { type: "retention.cleanup", payload: "{}", runAt: T0 } });
    const handlers: HandlerMap = {
      "digest.send": async () => {},
      "retention.cleanup": async () => {
        throw new PermanentJobError("nothing to do");
      },
    };
    await runDueJobs(handlers, "w1", at(0));
    const jobs = await db().job.findMany({ orderBy: { type: "asc" } });
    expect(jobs.map((j) => [j.type, j.status, j.attempts])).toEqual([
      ["digest.send", "FAILED", 1],
      ["retention.cleanup", "FAILED", 1],
      ["route.plan", "QUEUED", 0],
    ]);
    expect(jobs.find((j) => j.type === "digest.send")!.lastError).toContain("Invalid payload");
  });

  it("runs each job once when two runners race", async () => {
    await clearJobs();
    let calls = 0;
    const handlers: HandlerMap = { "digest.send": async () => void calls++ };
    for (let i = 0; i < 5; i++) await enqueue(db(), "digest.send", { date: `2026-10-0${i + 1}` }, { runAt: T0 });
    await Promise.all([runDueJobs(handlers, "w1", at(0)), runDueJobs(handlers, "w2", at(0))]);
    expect(calls).toBe(5);
    expect(await db().job.count({ where: { status: "DONE" } })).toBe(5);
  });

  it("puts jobs with a lock older than 5 minutes back in the queue", async () => {
    await clearJobs();
    await db().job.create({ data: { type: "digest.send", payload: "{}", status: "RUNNING", lockedAt: new Date(T0.getTime() - 6 * 60_000), lockedBy: "dead" } });
    await db().job.create({ data: { type: "digest.send", payload: "{}", status: "RUNNING", lockedAt: new Date(T0.getTime() - 60_000), lockedBy: "alive" } });
    expect(await recoverStaleLocks(T0)).toBe(1);
    expect((await db().job.findMany({ orderBy: { lockedBy: "asc" } })).map((j) => j.status).sort()).toEqual(["QUEUED", "RUNNING"]);
  });
});

describe("schedulerTick", () => {
  it("enqueues due work once, even after it completes", async () => {
    await clearJobs();
    await createUser("REP"); // America/Chicago, Mon–Sat
    // Maintenance jobs follow the machine's time zone, so leave them out of this check.
    const enabled = new Set(["digest.send", "route.plan"] as const);
    // Wednesday 2026-10-07 20:00 Chicago = 01:00 UTC Thursday.
    const now = new Date("2026-10-08T01:00:00Z");
    const first = await schedulerTick(enabled, now);
    expect(first.map((j) => j.type).sort()).toEqual(["digest.send", "route.plan"]);
    expect(await schedulerTick(enabled, now)).toEqual([]);

    await db().job.updateMany({ data: { status: "DONE", dedupeKey: null } });
    expect(await schedulerTick(enabled, now)).toEqual([]);
    expect(await db().job.count({ where: { key: { not: null } } })).toBe(2);
  });

  it("skips job types without a handler", async () => {
    await clearJobs();
    const now = new Date("2026-10-08T01:00:00Z");
    expect((await schedulerTick(new Set(["digest.send"] as const), now)).map((j) => j.type)).toEqual(["digest.send"]);
  });
});

describe("maintenance handlers", () => {
  it("retention.cleanup deletes old pings, idempotency keys and DONE jobs", async () => {
    await clearJobs();
    const user = await createUser("REP");
    const rep = await db().rep.findUniqueOrThrow({ where: { userId: user.id } });
    const now = new Date();
    const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 3600_000);
    await db().locationPing.createMany({
      data: [
        { clientId: "old", repId: rep.id, lat: 1, lng: 1, source: "FOREGROUND", recordedAt: daysAgo(91) },
        { clientId: "new", repId: rep.id, lat: 1, lng: 1, source: "FOREGROUND", recordedAt: daysAgo(1) },
      ],
    });
    await db().idempotencyKey.createMany({
      data: [
        { userId: user.id, key: "old", method: "POST", path: "/x", statusCode: 200, responseBody: "{}", createdAt: daysAgo(8) },
        { userId: user.id, key: "new", method: "POST", path: "/x", statusCode: 200, responseBody: "{}", createdAt: daysAgo(1) },
      ],
    });
    await db().job.create({ data: { type: "digest.send", payload: "{}", status: "DONE", updatedAt: daysAgo(15) } });

    await HANDLERS["retention.cleanup"]!({}, { jobId: "j", attempt: 1, now, log: () => {} });
    expect((await db().locationPing.findMany()).map((p) => p.clientId)).toEqual(["new"]);
    expect((await db().idempotencyKey.findMany()).map((k) => k.key)).toEqual(["new"]);
    expect(await db().job.count()).toBe(0);
  });
});

describe("GET /health", () => {
  it("reports the worker from its heartbeat", async () => {
    const call = async () => (await healthRoute(new NextRequest("http://canvass.test/api/v1/health"), { params: Promise.resolve({}) })).json();
    await db().appSetting.deleteMany({ where: { key: "_worker.heartbeat" } });
    expect(await call()).toEqual({ ok: false, db: true, worker: { ok: false, lastTickAt: null } });
    await writeHeartbeat("w1");
    expect(await call()).toMatchObject({ ok: true, db: true, worker: { ok: true } });
    await writeHeartbeat("w1", new Date(Date.now() - 10 * 60_000));
    expect(await call()).toMatchObject({ ok: false, worker: { ok: false } });
  });
});
