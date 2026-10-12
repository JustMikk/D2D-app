// Failed jobs and outbound events, shown in Settings with a retry button (PRD NTF-1, backend spec §8.2, §9.3).
import { z } from "zod";
import { audit, userActor } from "@/lib/api/audit";
import { conflict, notFound } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { JobStatus, OutboxStatus } from "@/lib/domain/enums";

export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export const JobListQuery = ListQuery.extend({ status: JobStatus.default("FAILED") });
export const OutboxListQuery = ListQuery.extend({ status: OutboxStatus.default("FAILED") });

function page<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
}

export async function listJobs(q: z.infer<typeof JobListQuery>) {
  const rows = await db().job.findMany({
    where: { status: q.status },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    select: { id: true, type: true, payload: true, status: true, attempts: true, maxAttempts: true, runAt: true, lastError: true, createdAt: true, updatedAt: true },
  });
  return page(rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) as unknown })), q.limit);
}

export async function retryJob(actorUserId: string, jobId: string, now = new Date()) {
  const job = await db().job.findUnique({ where: { id: jobId } });
  if (!job) throw notFound("That job");
  if (job.status !== "FAILED") throw conflict("Only failed jobs can be retried.");
  const updated = await db().job.update({ where: { id: jobId }, data: { status: "QUEUED", attempts: 0, runAt: now, lastError: null } });
  await audit(db(), userActor(actorUserId), "job.retried", "SETTING", jobId, { type: job.type, lastError: job.lastError });
  return { id: updated.id, status: updated.status };
}

export async function listOutbox(q: z.infer<typeof OutboxListQuery>) {
  const rows = await db().outboxEvent.findMany({
    where: { status: q.status },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    select: { id: true, type: true, status: true, attempts: true, nextAttemptAt: true, lastError: true, sentAt: true, createdAt: true },
  });
  return page(rows, q.limit);
}

export async function retryOutboxEvent(actorUserId: string, eventId: string, now = new Date()) {
  const event = await db().outboxEvent.findUnique({ where: { id: eventId } });
  if (!event) throw notFound("That event");
  if (event.status !== "FAILED") throw conflict("Only failed events can be retried.");
  const updated = await db().outboxEvent.update({ where: { id: eventId }, data: { status: "PENDING", attempts: 0, nextAttemptAt: now, lastError: null } });
  await audit(db(), userActor(actorUserId), "outbox.retried", "SETTING", eventId, { type: event.type, lastError: event.lastError });
  return { id: updated.id, status: updated.status };
}
