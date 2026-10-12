// Job runner (backend spec §8.2): one lane, sequential. At this scale, running jobs one at a time removes
// capacity races between door.assign and route.plan without locks.
import { db } from "@/lib/db";
import { JOB_PAYLOADS, type JobPayload, type JobType } from "@/lib/jobs";

export type JobContext = { jobId: string; attempt: number; now: Date; log: (message: string) => void };
export type JobHandler<T extends JobType> = (payload: JobPayload<T>, ctx: JobContext) => Promise<void>;
export type HandlerMap = { [T in JobType]?: JobHandler<T> };

/** A failure that retrying cannot fix (bad payload, missing record): the job fails at once. */
export class PermanentJobError extends Error {
  override name = "PermanentJobError";
}

export const CLAIM_BATCH = 10;
export const STALE_LOCK_MS = 5 * 60_000;
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_CAP_MS = 30 * 60_000;

/** Wait before the next try: 15 s × 2^attempts, capped at 30 minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_CAP_MS);
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, 2000);
}

/**
 * Claim and run due jobs, one at a time. Returns how many ran. `now` is injectable so tests can move
 * time forward.
 */
export async function runDueJobs(handlers: HandlerMap, workerId: string, now: () => Date = () => new Date()): Promise<number> {
  // Only claim types this worker can run. Jobs for handlers that ship in a later build step (or on a
  // newer worker during a deploy) wait in the queue instead of failing.
  const types = Object.keys(handlers);
  const due = await db().job.findMany({
    where: { status: "QUEUED", runAt: { lte: now() }, type: { in: types } },
    orderBy: { runAt: "asc" },
    take: CLAIM_BATCH,
  });

  let ran = 0;
  for (const job of due) {
    const claimed = await db().job.updateMany({
      where: { id: job.id, status: "QUEUED" },
      data: { status: "RUNNING", lockedAt: now(), lockedBy: workerId },
    });
    if (claimed.count !== 1) continue;
    ran++;

    const attempt = job.attempts + 1;
    const log = (message: string) => console.info(`[job ${job.type} ${job.id}] ${message}`);
    try {
      const handler = handlers[job.type as JobType] as JobHandler<JobType> | undefined;
      if (!handler) throw new PermanentJobError(`No handler for job type "${job.type}"`);
      const schema = JOB_PAYLOADS[job.type as JobType];
      const parsed = schema.safeParse(JSON.parse(job.payload));
      if (!parsed.success) throw new PermanentJobError(`Invalid payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);

      await handler(parsed.data as JobPayload<JobType>, { jobId: job.id, attempt, now: now(), log });
      await db().job.update({
        where: { id: job.id },
        data: { status: "DONE", attempts: attempt, dedupeKey: null, lockedAt: null, lockedBy: null, lastError: null },
      });
    } catch (error) {
      const permanent = error instanceof PermanentJobError;
      const exhausted = attempt >= job.maxAttempts;
      log(`failed (attempt ${attempt}/${job.maxAttempts}): ${errorText(error)}`);
      await db().job.update({
        where: { id: job.id },
        data:
          permanent || exhausted
            ? { status: "FAILED", attempts: attempt, dedupeKey: null, lockedAt: null, lockedBy: null, lastError: errorText(error) }
            : {
                status: "QUEUED",
                attempts: attempt,
                runAt: new Date(now().getTime() + backoffMs(attempt)),
                lockedAt: null,
                lockedBy: null,
                lastError: errorText(error),
              },
      });
    }
  }
  return ran;
}

/** RUNNING jobs whose lock is older than 5 minutes (a crashed worker) go back to QUEUED. */
export async function recoverStaleLocks(now = new Date()): Promise<number> {
  const result = await db().job.updateMany({
    where: { status: "RUNNING", lockedAt: { lt: new Date(now.getTime() - STALE_LOCK_MS) } },
    data: { status: "QUEUED", lockedAt: null, lockedBy: null },
  });
  return result.count;
}
