// Rep actions beyond the core day (PRD REP-10, REP-11, §10 analytics): skip a stop, a door's history, and the
// few analytics events only the phone knows about.
import { z } from "zod";
import { audit, userActor } from "@/lib/api/audit";
import { notFound } from "@/lib/api/errors";
import { replayOrRun } from "@/lib/api/idempotency";
import { db } from "@/lib/db";
import { SKIP_REASONS } from "@/lib/domain/enums";
import { doorSnapshot, emit } from "@/lib/events";
import { enqueue } from "@/lib/jobs";
import { deviceTime, repForUser } from "./repApp";

// ---------------------------------------------------------------------------
// Skip a stop
// ---------------------------------------------------------------------------

export const SkipBody = z.object({
  clientId: z.uuid(),
  reason: z.enum(SKIP_REASONS),
  note: z.string().trim().max(300).optional(),
  recordedAt: z.iso.datetime({ offset: true }).optional(),
});

export const SKIP_LABEL: Record<(typeof SKIP_REASONS)[number], string> = { CLOSED: "Closed", UNSAFE: "Unsafe", OUT_OF_TIME: "Ran out of time", OTHER: "Other" };

/**
 * The stop leaves today and goes back to assignment (PRD REP-11). The rep who skipped it is kept off it for
 * that day, so it is not handed straight back: the engine picks their next working day, or someone else.
 */
export async function skipStop(userId: string, assignmentId: string, input: unknown, now = new Date()) {
  const body = SkipBody.parse(input);
  const rep = await repForUser(userId);
  const assignment = await db().assignment.findUnique({ where: { id: assignmentId } });
  if (!assignment || assignment.repId !== rep.id) throw notFound("That stop");

  return replayOrRun(userId, body.clientId, "POST", `/rep/assignments/${assignmentId}/skip`, () =>
    db().$transaction(async (tx) => {
      const fresh = await tx.assignment.findUnique({ where: { id: assignmentId } });
      // Already visited, skipped or moved: nothing to do, and the phone can stop retrying.
      if (!fresh || fresh.status !== "ACTIVE") return { status: 200, body: { skipped: false, status: fresh?.status ?? "GONE" } };
      const at = deviceTime(body.recordedAt, now);
      await tx.assignment.update({ where: { id: assignmentId }, data: { status: "SKIPPED", completedAt: at, reason: `${SKIP_LABEL[body.reason]}${body.note ? `: ${body.note}` : ""}` } });
      await tx.door.updateMany({ where: { id: fresh.doorId, status: { in: ["ASSIGNED", "SCHEDULED"] } }, data: { status: "GEOCODED" } });
      await enqueue(tx, "door.assign", { doorId: fresh.doorId, reason: "RETRY", avoid: { repId: rep.id, date: fresh.scheduledFor } }, { dedupeKey: `assign:${fresh.doorId}` });
      await emit(tx, "door.upserted", { door: await doorSnapshot(tx, fresh.doorId) }, now);
      await audit(tx, userActor(userId), "rep.stop_skipped", "ASSIGNMENT", assignmentId, { reason: body.reason, note: body.note ?? null, doorId: fresh.doorId });
      return { status: 200, body: { skipped: true, status: "SKIPPED" } };
    }),
  );
}

// ---------------------------------------------------------------------------
// Door history
// ---------------------------------------------------------------------------

const HISTORY_DAYS = 120;

/** Previous visits and notes for a door the rep has (or recently had) a stop at. Anyone else gets 404. */
export async function doorHistory(userId: string, doorId: string, now = new Date()) {
  const rep = await repForUser(userId);
  const since = new Date(now.getTime() - HISTORY_DAYS * 86_400_000);
  const mine = await db().assignment.findFirst({ where: { repId: rep.id, doorId, createdAt: { gte: since } }, select: { id: true } });
  if (!mine) throw notFound("That door");
  const door = await db().door.findUniqueOrThrow({ where: { id: doorId }, select: { qualificationNotes: true, attempts: true, company: { select: { name: true } } } });
  const visits = await db().visit.findMany({ where: { doorId }, orderBy: { recordedAt: "desc" }, take: 20, include: { rep: { include: { user: { select: { name: true } } } } } });
  return {
    companyName: door.company.name,
    qualificationNotes: door.qualificationNotes,
    attempts: door.attempts,
    visits: visits.map((v) => ({ recordedAt: v.recordedAt.toISOString(), outcome: v.outcome, notes: v.notes, repName: v.rep.user.name, you: v.repId === rep.id })),
  };
}

// ---------------------------------------------------------------------------
// Phone analytics (PRD §10)
// ---------------------------------------------------------------------------

export const PHONE_EVENTS = ["rep.visit_form_opened", "rep.navigate_tapped", "rep.offline_queue_flushed"] as const;

export const EventsBody = z.object({
  events: z
    .array(
      z.object({
        clientId: z.uuid(),
        name: z.enum(PHONE_EVENTS),
        at: z.iso.datetime({ offset: true }),
        data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      }),
    )
    .min(1)
    .max(50),
});

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "P2002";
}

/** Each event is recorded once: a retried batch (a lost reply) skips the ones already stored. */
export async function recordEvents(userId: string, input: unknown, now = new Date()) {
  const { events } = EventsBody.parse(input);
  const rep = await repForUser(userId);
  let recorded = 0;
  for (const e of events) {
    try {
      await db().idempotencyKey.create({ data: { userId, key: e.clientId, method: "EVENT", path: "/rep/events", statusCode: 200, responseBody: "{}" } });
    } catch (error) {
      if (isUniqueViolation(error)) continue;
      throw error;
    }
    await audit(db(), userActor(userId), e.name, "REP", rep.id, { ...e.data, at: deviceTime(e.at, now).toISOString() });
    recorded++;
  }
  return { recorded, duplicates: events.length - recorded };
}

