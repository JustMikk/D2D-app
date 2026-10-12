// Worker process (backend spec §2): `tsx worker/index.ts`. Runs the job runner (every second, one lane),
// the scheduler (every 60 seconds), the outbox loop (every 10 seconds) and stale-lock recovery.
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { db, dbReady } from "@/lib/db";
import { writeHeartbeat } from "@/lib/heartbeat";
import { getSetting } from "@/lib/settings";
import { ENABLED_JOB_TYPES, HANDLERS } from "./handlers";
import { deliverDueEvents } from "./outbox";
import { recoverStaleLocks, runDueJobs } from "./runner";
import { schedulerTick } from "./scheduler";

if (existsSync(".env")) process.loadEnvFile(".env");

const workerId = process.env.WORKER_ID || `${hostname()}:${process.pid}`;
let stopping = false;
const timers: NodeJS.Timeout[] = [];

/** Run `fn` every `ms`, never overlapping itself, logging (not crashing on) errors. */
function every(name: string, ms: number, fn: () => Promise<unknown>) {
  let running: Promise<unknown> | null = null;
  const tick = () => {
    if (stopping || running) return;
    running = fn()
      .catch((error: unknown) => console.error(`[worker] ${name} failed:`, error))
      .finally(() => {
        running = null;
      });
  };
  tick();
  timers.push(setInterval(tick, ms));
  return () => running;
}

async function deliverOutbox() {
  const url = await getSetting("webhooks.outboundUrl");
  const secret = process.env.OUTBOUND_WEBHOOK_SECRET;
  if (!url) return; // Events wait as PENDING until an outbound URL is set in Settings.
  if (!secret) {
    console.warn("[worker] OUTBOUND_WEBHOOK_SECRET is not set; outbound events are not being delivered.");
    return;
  }
  const r = await deliverDueEvents({ url, secret });
  if (r.sent || r.retried || r.failed) console.info(`[outbox] sent ${r.sent}, will retry ${r.retried}, failed ${r.failed}`);
}

async function main() {
  await dbReady();
  const recovered = await recoverStaleLocks();
  console.info(`[worker] ${workerId} started. Handlers: ${[...ENABLED_JOB_TYPES].join(", ")}. Recovered ${recovered} stale jobs.`);

  const currentJob = every("runner", 1000, () => runDueJobs(HANDLERS, workerId));
  every("scheduler", 60_000, async () => {
    await writeHeartbeat(workerId);
    const enqueued = await schedulerTick(ENABLED_JOB_TYPES);
    for (const j of enqueued) console.info(`[scheduler] enqueued ${j.type} (${j.key})`);
  });
  every("outbox", 10_000, deliverOutbox);
  every("stale-locks", 60_000, recoverStaleLocks);

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.info(`[worker] ${signal}: finishing the current job, then exiting.`);
    timers.forEach(clearInterval);
    await currentJob();
    await db().$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error("[worker] failed to start:", error);
  process.exit(1);
});
