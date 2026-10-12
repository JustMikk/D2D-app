// Background job types and the enqueue helper (backend spec §8.1, §8.2).
import { z } from "zod";
import type { Db } from "@/lib/db";
import { AssignReason, RouteTrigger } from "@/lib/domain/enums";

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const JOB_PAYLOADS = {
  "address.resolve": z.object({ doorId: z.string() }),
  "door.assign": z.object({
    doorId: z.string(),
    reason: AssignReason,
    /** A manager cleared a coverage gap: assign the nearest rep even past the drive limit. */
    ignoreDriveLimit: z.boolean().optional(),
    /** A rep skipped this door for a date: do not hand it straight back to them that day. */
    avoid: z.object({ repId: z.string(), date: z.string() }).optional(),
  }),
  "route.plan": z.object({
    repId: z.string(),
    date: localDate,
    trigger: RouteTrigger,
    start: z.object({ lat: z.number(), lng: z.number() }).optional(),
  }),
  "rollover.rep": z.object({ repId: z.string(), date: localDate }),
  "digest.send": z.object({ date: localDate }),
  "push.send": z.object({ userId: z.string(), title: z.string(), body: z.string(), url: z.string(), tag: z.string() }),
  "import.commit": z.object({ batchId: z.string() }),
  "unassignable.retry": z.object({}),
  "retention.cleanup": z.object({}),
} as const;

export type JobType = keyof typeof JOB_PAYLOADS;
export type JobPayload<T extends JobType> = z.infer<(typeof JOB_PAYLOADS)[T]>;
export const JOB_TYPES = Object.keys(JOB_PAYLOADS) as JobType[];

export type EnqueueOptions = {
  runAt?: Date;
  /** Unique while the job is queued or running; a second enqueue with the same key is ignored. */
  dedupeKey?: string;
  /** Stable identity kept after completion, so the scheduler runs each piece of work once. */
  key?: string;
  maxAttempts?: number;
};

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "P2002";
}

/**
 * Validate the payload and insert a QUEUED job. Returns null when an identical dedupeKey is already
 * queued or running, so double-enqueues are harmless.
 */
export async function enqueue<T extends JobType>(client: Db, type: T, payload: JobPayload<T>, options: EnqueueOptions = {}): Promise<{ id: string } | null> {
  const data = JOB_PAYLOADS[type].parse(payload);
  if (options.dedupeKey && (await client.job.findUnique({ where: { dedupeKey: options.dedupeKey }, select: { id: true } }))) return null;
  try {
    return await client.job.create({
      data: {
        type,
        payload: JSON.stringify(data),
        runAt: options.runAt ?? new Date(),
        dedupeKey: options.dedupeKey ?? null,
        key: options.key ?? null,
        ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
      },
      select: { id: true },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}
