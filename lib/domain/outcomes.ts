// Outcome rules (backend spec §6.7, PRD §7.7): what a visit does to its door.
import type { ClosedReason, DoorStatus, Outcome, ReviewReason } from "./enums";
import type { ReviewEvidence } from "./addressResolution";

export type OutcomeDoor = { attempts: number };

export type OutcomeVisit = {
  outcome: Outcome;
  repId: string;
  notes: string;
  nextStepAt: Date | null;
  location: { lat: number; lng: number } | null;
};

export type DoorPatch = {
  status: DoorStatus;
  lastOutcome: Outcome;
  attempts?: number;
  closedReason?: ClosedReason;
  closedAt?: Date;
  nextStepAt?: Date | null;
  preferredRepId?: string;
  reviewReason?: ReviewReason | null;
  reviewDetail?: ReviewEvidence | null;
};

export type OutcomeEffect =
  | { type: "completeAssignment" }
  | { type: "enqueue"; job: "door.assign"; reason: "NOT_HOME" }
  | { type: "emit"; event: "visit.recorded" | "visit.hot" | "door.upserted" | "door.needs_review" };

export type OutcomeResult = { patch: DoorPatch; effects: OutcomeEffect[] };

export function applyOutcome(
  door: OutcomeDoor,
  visit: OutcomeVisit,
  settings: { maxNotHomeAttempts: number },
  now: Date,
): OutcomeResult {
  const effects: OutcomeEffect[] = [{ type: "completeAssignment" }];
  const base = { lastOutcome: visit.outcome, reviewReason: null, reviewDetail: null } as const;
  let patch: DoorPatch;

  switch (visit.outcome) {
    case "NOT_HOME": {
      const attempts = door.attempts + 1;
      if (attempts >= settings.maxNotHomeAttempts) {
        patch = { ...base, status: "CLOSED", attempts, closedReason: "MAX_ATTEMPTS", closedAt: now };
      } else {
        patch = { ...base, status: "GEOCODED", attempts };
        effects.push({ type: "enqueue", job: "door.assign", reason: "NOT_HOME" });
      }
      break;
    }
    case "NOT_INTERESTED":
      patch = { ...base, status: "CLOSED", closedReason: "NOT_INTERESTED", closedAt: now };
      break;
    case "FOLLOW_UP":
      patch = { ...base, status: "VISITED", nextStepAt: visit.nextStepAt, preferredRepId: visit.repId };
      break;
    case "APPOINTMENT_SET":
      patch = { ...base, status: "VISITED", nextStepAt: visit.nextStepAt, preferredRepId: visit.repId };
      effects.push({ type: "emit", event: "visit.hot" });
      break;
    case "SOLD":
      patch = { ...base, status: "CLOSED", closedReason: "SOLD", closedAt: now };
      effects.push({ type: "emit", event: "visit.hot" });
      break;
    case "BAD_ADDRESS":
      patch = {
        lastOutcome: visit.outcome,
        status: "NEEDS_REVIEW",
        reviewReason: "BAD_ADDRESS",
        reviewDetail: { note: visit.notes, ...(visit.location ? { reportedAt: visit.location } : {}) },
      };
      effects.push({ type: "emit", event: "door.needs_review" });
      break;
  }

  effects.push({ type: "emit", event: "visit.recorded" }, { type: "emit", event: "door.upserted" });
  return { patch, effects };
}

/** Field rules for a visit (PRD REP-6, backend spec §10.4). Returns field errors; empty when valid. */
export function visitFieldErrors(
  v: { outcome: Outcome; nextStepAt?: Date | null; signatureMediaId?: string | null; photoMediaIds?: readonly string[] },
  now: Date,
): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = [];
  if (v.outcome === "FOLLOW_UP" || v.outcome === "APPOINTMENT_SET") {
    if (!v.nextStepAt) errors.push({ path: "nextStepAt", message: "Pick a date and time for the next step" });
    else if (v.nextStepAt.getTime() <= now.getTime()) errors.push({ path: "nextStepAt", message: "The next step must be in the future" });
  }
  if (v.outcome === "SOLD" && !v.signatureMediaId) errors.push({ path: "signatureMediaId", message: "A signature is required for a sale" });
  if ((v.photoMediaIds?.length ?? 0) > 3) errors.push({ path: "photoMediaIds", message: "Add at most 3 photos" });
  return errors;
}
