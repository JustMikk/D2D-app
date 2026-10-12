// Recording a visit (backend spec §10.2 POST /rep/visits, §6.7, PRD REP-6, OUT, REP-7).
// A visit is never lost: it is idempotent on clientId (the phone retries until acknowledged), it is accepted
// even if the stop was reassigned meanwhile (the rep really was there), and it is immutable once created.
import { z } from "zod";
import { audit, userActor } from "@/lib/api/audit";
import { forbidden, notFound, validationFailed } from "@/lib/api/errors";
import { db, type Db } from "@/lib/db";
import { Outcome } from "@/lib/domain/enums";
import { haversineMeters } from "@/lib/domain/geo";
import { applyOutcome, visitFieldErrors } from "@/lib/domain/outcomes";
import { addDays, localToday } from "@/lib/domain/time";
import { doorSnapshot, emit, visitSnapshot } from "@/lib/events";
import { enqueue } from "@/lib/jobs";
import { getSettings } from "@/lib/settings";
import { deviceTime, FixSchema, repForUser } from "./repApp";

export const VisitCreate = z.object({
  clientId: z.uuid(),
  assignmentId: z.string().min(1),
  doorId: z.string().min(1),
  outcome: Outcome,
  decisionMakerPresent: z.boolean().optional(),
  notes: z.string().max(2000).default(""),
  nextStepAt: z.iso.datetime({ offset: true }).optional(),
  photoMediaIds: z.array(z.string()).max(3).optional(),
  signatureMediaId: z.string().optional(),
  location: FixSchema.nullish(),
  recordedAt: z.iso.datetime({ offset: true }),
  formDurationS: z.number().int().min(0).max(86_400).optional(),
});
export type VisitCreate = z.infer<typeof VisitCreate>;

export type VisitResult = { visit: { id: string; outcome: string; recordedAt: string; offSite: boolean; assignmentMismatch: boolean }; door: { status: string; nextStepAt: string | null } };

async function resultFor(client: Db, visitId: string): Promise<VisitResult> {
  const v = await client.visit.findUniqueOrThrow({ where: { id: visitId }, include: { door: { select: { status: true, nextStepAt: true } } } });
  return {
    visit: { id: v.id, outcome: v.outcome, recordedAt: v.recordedAt.toISOString(), offSite: v.offSite, assignmentMismatch: v.assignmentMismatch },
    door: { status: v.door.status, nextStepAt: v.door.nextStepAt?.toISOString() ?? null },
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "P2002";
}

/** Returns { replayed: true } with the original result when this clientId was already saved. */
export async function createVisit(userId: string, input: unknown, now = new Date()): Promise<{ status: 200 | 201; body: VisitResult; replayed: boolean }> {
  const v = VisitCreate.parse(input);
  const rep = await repForUser(userId);

  const existing = await db().visit.findUnique({ where: { clientId: v.clientId } });
  if (existing) {
    if (existing.repId !== rep.id) throw forbidden();
    return { status: 200, body: await resultFor(db(), existing.id), replayed: true };
  }

  const assignment = await db().assignment.findUnique({ where: { id: v.assignmentId }, include: { door: true } });
  // Another rep's stop, or a mismatched pair, is "not found": IDs cannot be probed.
  if (!assignment || assignment.repId !== rep.id || assignment.doorId !== v.doorId) throw notFound("That stop");
  if (assignment.scheduledFor < addDays(localToday(rep.timeZone, now), -7)) throw forbidden("This stop is more than 7 days old and can't take a visit.");

  // Field rules are judged at the moment the rep tapped Save, not when it synced.
  const recordedAt = deviceTime(v.recordedAt, now);
  const nextStepAt = v.nextStepAt ? new Date(v.nextStepAt) : null;
  const problems = visitFieldErrors({ outcome: v.outcome, nextStepAt, signatureMediaId: v.signatureMediaId, photoMediaIds: v.photoMediaIds }, recordedAt);
  if (problems.length) throw validationFailed(problems);

  const mediaIds = [...(v.photoMediaIds ?? []), ...(v.signatureMediaId ? [v.signatureMediaId] : [])];
  const media = mediaIds.length ? await db().media.findMany({ where: { id: { in: mediaIds } } }) : [];
  const bad = mediaIds.filter((id) => {
    const m = media.find((x) => x.id === id);
    const wantsSignature = id === v.signatureMediaId;
    return !m || m.uploadedById !== userId || m.visitId !== null || m.kind !== (wantsSignature ? "SIGNATURE" : "PHOTO");
  });
  if (bad.length) throw validationFailed([{ path: "photoMediaIds", message: "A photo or signature is missing or was already used. Add it again." }]);

  const settings = await getSettings();
  const door = assignment.door;
  const distance = v.location && door.lat !== null && door.lng !== null ? haversineMeters(v.location, { lat: door.lat, lng: door.lng }) : null;
  const offSite = distance === null || distance > settings["visit.arrivalRadiusMeters"];

  try {
    const visitId = await db().$transaction(async (tx) => {
      const visit = await tx.visit.create({
        data: {
          clientId: v.clientId,
          doorId: door.id,
          repId: rep.id,
          assignmentId: assignment.id,
          outcome: v.outcome,
          decisionMakerPresent: v.decisionMakerPresent ?? null,
          notes: v.notes,
          nextStepAt,
          recordedAt,
          receivedAt: now,
          lat: v.location?.lat ?? null,
          lng: v.location?.lng ?? null,
          accuracyM: v.location?.accuracyM ?? null,
          distanceFromDoorM: distance,
          offSite,
          assignmentMismatch: assignment.status !== "ACTIVE" && assignment.status !== "COMPLETED",
          formDurationS: v.formDurationS ?? null,
        },
      });
      if (mediaIds.length) await tx.media.updateMany({ where: { id: { in: mediaIds } }, data: { visitId: visit.id } });

      // The stop is done. A stop that was reassigned or rolled over meanwhile still counts (the rep was
      // there), and the door's newer assignment is cancelled so nobody drives out for it again.
      await tx.assignment.update({ where: { id: assignment.id }, data: { status: "COMPLETED", completedAt: recordedAt } });
      await tx.assignment.updateMany({ where: { doorId: door.id, status: "ACTIVE", id: { not: assignment.id } }, data: { status: "CANCELLED", reason: "Visit recorded on an earlier assignment" } });

      // Outcome rules (§6.7). A door already closed by a manager keeps its status; the visit is still kept.
      const outcome = applyOutcome({ attempts: door.attempts }, { outcome: v.outcome, repId: rep.id, notes: v.notes, nextStepAt, location: v.location ? { lat: v.location.lat, lng: v.location.lng } : null }, { maxNotHomeAttempts: settings["outcome.maxNotHomeAttempts"] }, now);
      const { reviewDetail, ...patch } = outcome.patch;
      if (door.status === "CLOSED") {
        await tx.door.update({ where: { id: door.id }, data: { lastOutcome: v.outcome } });
      } else {
        await tx.door.update({ where: { id: door.id }, data: { ...patch, ...(reviewDetail !== undefined ? { reviewDetail: reviewDetail ? JSON.stringify(reviewDetail) : null } : {}) } });
      }

      if (v.location && rep.onShift) {
        await tx.locationPing.upsert({
          where: { clientId: `${v.clientId}:visit` },
          create: { clientId: `${v.clientId}:visit`, repId: rep.id, lat: v.location.lat, lng: v.location.lng, accuracyM: v.location.accuracyM ?? null, source: "VISIT", recordedAt },
          update: {},
        });
      }

      const closed = door.status === "CLOSED";
      for (const effect of outcome.effects) {
        if (effect.type === "enqueue" && !closed) await enqueue(tx, "door.assign", { doorId: door.id, reason: effect.reason }, { dedupeKey: `assign:${door.id}` });
      }
      const doorNow = await doorSnapshot(tx, door.id);
      const visitSnap = await visitSnapshot(tx, visit.id, now);
      const repInfo = { id: rep.id, name: rep.user.name, crmId: rep.crmId };
      for (const effect of outcome.effects) {
        if (effect.type !== "emit") continue;
        if (effect.event === "visit.recorded" || effect.event === "visit.hot") await emit(tx, effect.event, { visit: visitSnap, door: doorNow, rep: repInfo }, now);
        else if (effect.event === "door.upserted") await emit(tx, "door.upserted", { door: doorNow }, now);
        else if (effect.event === "door.needs_review" && !closed) await emit(tx, "door.needs_review", { door: doorNow, reason: "BAD_ADDRESS", evidence: reviewDetail ?? {} }, now);
      }

      await audit(tx, userActor(userId), "rep.visit_saved", "VISIT", visit.id, { outcome: v.outcome, formDurationS: v.formDurationS ?? null, offSite, mismatch: assignment.status !== "ACTIVE" && assignment.status !== "COMPLETED", syncDelayS: Math.round((now.getTime() - recordedAt.getTime()) / 1000) });
      return visit.id;
    });
    return { status: 201, body: await resultFor(db(), visitId), replayed: false };
  } catch (error) {
    // Two copies of the same visit raced (a retry while the first was still saving): the first one won.
    if (isUniqueViolation(error)) {
      const winner = await db().visit.findUnique({ where: { clientId: v.clientId } });
      if (winner && winner.repId === rep.id) return { status: 200, body: await resultFor(db(), winner.id), replayed: true };
    }
    throw error;
  }
}
