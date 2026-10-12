// Daily maintenance jobs (backend spec §8.1).
import { db } from "@/lib/db";
import { enqueue } from "@/lib/jobs";
import { getSetting } from "@/lib/settings";
import type { JobHandler } from "../runner";

const DAY_MS = 24 * 3600_000;

/** Delete location pings past retention, idempotency keys older than 7 days, and DONE jobs older than 14 days. */
export const retentionCleanup: JobHandler<"retention.cleanup"> = async (_payload, ctx) => {
  const retentionDays = await getSetting("location.retentionDays");
  const pings = await db().locationPing.deleteMany({ where: { recordedAt: { lt: new Date(ctx.now.getTime() - retentionDays * DAY_MS) } } });
  const keys = await db().idempotencyKey.deleteMany({ where: { createdAt: { lt: new Date(ctx.now.getTime() - 7 * DAY_MS) } } });
  // Scheduled jobs keep their key row only as long as the scheduler needs it (today), so 14 days is ample.
  const jobs = await db().job.deleteMany({ where: { status: "DONE", updatedAt: { lt: new Date(ctx.now.getTime() - 14 * DAY_MS) } } });
  ctx.log(`deleted ${pings.count} pings, ${keys.count} idempotency keys, ${jobs.count} jobs`);
};

/** Re-run assignment for every UNASSIGNABLE door (reps may have been added). */
export const unassignableRetry: JobHandler<"unassignable.retry"> = async (_payload, ctx) => {
  const doors = await db().door.findMany({ where: { status: "UNASSIGNABLE" }, select: { id: true } });
  for (const door of doors) await enqueue(db(), "door.assign", { doorId: door.id, reason: "RETRY" }, { dedupeKey: `assign:${door.id}` });
  ctx.log(`re-queued ${doors.length} unassignable doors`);
};
