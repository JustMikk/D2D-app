// Outbound events (backend spec §9.3). Services call emit() inside the same transaction as the change
// that caused the event; worker/outbox.ts delivers them to n8n.
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import type { Db } from "@/lib/db";
import type {
  AddressSource,
  ClosedReason,
  DoorStatus,
  GeocodeQuality,
  Outcome,
  ReviewReason,
  VisitWindow,
} from "@/lib/domain/enums";
import { parseEnv } from "@/lib/env";
import { getSetting } from "@/lib/settings";
import { localDateOf } from "@/lib/domain/time";
import { signedMediaUrl } from "@/lib/integrations/mediaSigning";

export const EVENT_TYPES = [
  "door.upserted",
  "door.created",
  "door.needs_review",
  "door.unassignable",
  "door.assigned",
  "visit.recorded",
  "visit.hot",
  "digest.daily",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type EventEnvelope<D = unknown> = { id: string; type: EventType; version: 1; occurredAt: string; data: D };

export type DoorSnapshot = {
  id: string;
  externalProspectId: string;
  crmId: string | null;
  name: string;
  status: DoorStatus;
  reviewReason: ReviewReason | null;
  closedReason: ClosedReason | null;
  priority: "NORMAL" | "HOT";
  address: { street: string | null; city: string | null; state: string | null; zip: string | null };
  lat: number | null;
  lng: number | null;
  geocodeQuality: GeocodeQuality | null;
  addressSource: AddressSource | null;
  jobLocation: string | null;
  qualificationNotes: string;
  preferredVisitWindow: VisitWindow | null;
  attempts: number;
  lastOutcome: Outcome | null;
  nextStepAt: string | null;
  /** nextStepAt as a calendar date in the rep's time zone (the business zone when unassigned), for date-only CRM fields. */
  nextStepDate: string | null;
  company: {
    id: string;
    crmId: string | null;
    name: string;
    website: string | null;
    domain: string | null;
    address: { street: string | null; city: string | null; state: string | null; zip: string | null };
  };
  currentAssignment: {
    id: string;
    repId: string;
    repName: string;
    repCrmId: string | null;
    scheduledFor: string;
    routeOrder: number | null;
    plannedArrival: string | null;
  } | null;
  updatedAt: string;
};

export type VisitSnapshot = {
  id: string;
  outcome: Outcome;
  notes: string;
  decisionMakerPresent: boolean | null;
  nextStepAt: string | null;
  recordedAt: string;
  offSite: boolean;
  distanceFromDoorM: number | null;
  location: { lat: number; lng: number } | null;
  photoUrls: string[];
  signatureUrl: string | null;
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Write one event to the outbox. Pass the transaction client so the event commits with the change. */
export async function emit<D>(client: Db, type: EventType, data: D, now = new Date()): Promise<EventEnvelope<D>> {
  const id = `evt_${randomUUID().replaceAll("-", "")}`;
  const envelope: EventEnvelope<D> = { id, type, version: 1, occurredAt: now.toISOString(), data };
  await client.outboxEvent.create({ data: { id, type, payload: JSON.stringify(envelope), createdAt: now, nextAttemptAt: now } });
  return envelope;
}

export async function doorSnapshot(client: Db, doorId: string): Promise<DoorSnapshot> {
  const door = await client.door.findUniqueOrThrow({
    where: { id: doorId },
    include: {
      company: true,
      assignments: { where: { status: "ACTIVE" }, include: { rep: { include: { user: { select: { name: true } } } } }, take: 1 },
    },
  });
  const a = door.assignments[0];
  const zone = a?.rep.timeZone ?? (await getSetting("schedule.digestTimeZone", client));
  return {
    id: door.id,
    externalProspectId: door.externalProspectId,
    crmId: door.crmId,
    name: door.name,
    status: door.status as DoorStatus,
    reviewReason: door.reviewReason as ReviewReason | null,
    closedReason: door.closedReason as ClosedReason | null,
    priority: door.priority as "NORMAL" | "HOT",
    address: { street: door.street, city: door.city, state: door.state, zip: door.zip },
    lat: door.lat,
    lng: door.lng,
    geocodeQuality: door.geocodeQuality as GeocodeQuality | null,
    addressSource: door.addressSource as AddressSource | null,
    jobLocation: door.jobCity ? [door.jobCity, door.jobState].filter(Boolean).join(", ") : null,
    qualificationNotes: door.qualificationNotes,
    preferredVisitWindow: door.preferredVisitWindow as VisitWindow | null,
    attempts: door.attempts,
    lastOutcome: door.lastOutcome as Outcome | null,
    nextStepAt: iso(door.nextStepAt),
    nextStepDate: door.nextStepAt ? localDateOf(door.nextStepAt, zone) : null,
    company: {
      id: door.company.id,
      crmId: door.company.crmId,
      name: door.company.name,
      website: door.company.website,
      domain: door.company.domain,
      address: { street: door.company.street, city: door.company.city, state: door.company.state, zip: door.company.zip },
    },
    currentAssignment: a
      ? {
          id: a.id,
          repId: a.repId,
          repName: a.rep.user.name,
          repCrmId: a.rep.crmId,
          scheduledFor: a.scheduledFor,
          routeOrder: a.routeOrder,
          plannedArrival: iso(a.plannedArrival),
        }
      : null,
    updatedAt: door.updatedAt.toISOString(),
  };
}

export async function visitSnapshot(client: Db, visitId: string, now = new Date()): Promise<VisitSnapshot> {
  const visit = await client.visit.findUniqueOrThrow({ where: { id: visitId }, include: { media: true } });
  const media = visit.media.length ? parseEnv(["APP_BASE_URL", "MEDIA_SIGNING_SECRET"] as const) : null;
  const url = (id: string) => signedMediaUrl(media!.APP_BASE_URL, media!.MEDIA_SIGNING_SECRET, id, now);
  return {
    id: visit.id,
    outcome: visit.outcome as Outcome,
    notes: visit.notes,
    decisionMakerPresent: visit.decisionMakerPresent,
    nextStepAt: iso(visit.nextStepAt),
    recordedAt: visit.recordedAt.toISOString(),
    offSite: visit.offSite,
    distanceFromDoorM: visit.distanceFromDoorM,
    location: visit.lat !== null && visit.lng !== null ? { lat: visit.lat, lng: visit.lng } : null,
    photoUrls: visit.media.filter((m) => m.kind === "PHOTO").map((m) => url(m.id)),
    signatureUrl: visit.media.filter((m) => m.kind === "SIGNATURE").map((m) => url(m.id))[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Daily digest (PRD NTF-3)
// ---------------------------------------------------------------------------

export type DigestRep = {
  repId: string;
  name: string;
  visited: number;
  contacts: number;
  appointments: number;
  sales: number;
  notVisited: number;
  driveMinutes: number;
};

export type DigestData = { date: string; timeZone: string; totals: Omit<DigestRep, "repId" | "name">; reps: DigestRep[] };

/** Contacts are any outcome other than not home or bad address (PRD MGR-8). */
export const CONTACT_OUTCOMES: readonly Outcome[] = ["NOT_INTERESTED", "FOLLOW_UP", "APPOINTMENT_SET", "SOLD"];

/**
 * Per-rep counts for one date. Visits count when recorded during that date in the digest time zone;
 * not-visited counts assignments for that date still open at digest time; drive minutes come from the
 * latest route plan for the date.
 */
export async function buildDigest(client: Db, date: string, timeZone: string): Promise<DigestData> {
  const start = DateTime.fromISO(date, { zone: timeZone }).startOf("day");
  const range = { gte: start.toJSDate(), lt: start.plus({ days: 1 }).toJSDate() };
  const reps = await client.rep.findMany({ where: { active: true }, include: { user: { select: { name: true } } }, orderBy: { user: { name: "asc" } } });

  const rows: DigestRep[] = [];
  for (const rep of reps) {
    const visits = await client.visit.findMany({ where: { repId: rep.id, recordedAt: range }, select: { outcome: true } });
    const notVisited = await client.assignment.count({ where: { repId: rep.id, scheduledFor: date, status: "ACTIVE" } });
    const plan = await client.routePlan.findFirst({ where: { repId: rep.id, date }, orderBy: { createdAt: "desc" }, select: { totalDriveMinutes: true } });
    rows.push({
      repId: rep.id,
      name: rep.user.name,
      visited: visits.length,
      contacts: visits.filter((v) => CONTACT_OUTCOMES.includes(v.outcome as Outcome)).length,
      appointments: visits.filter((v) => v.outcome === "APPOINTMENT_SET").length,
      sales: visits.filter((v) => v.outcome === "SOLD").length,
      notVisited,
      driveMinutes: plan?.totalDriveMinutes ?? 0,
    });
  }
  const sum = (k: keyof DigestData["totals"]) => rows.reduce((n, r) => n + r[k], 0);
  return {
    date,
    timeZone,
    totals: { visited: sum("visited"), contacts: sum("contacts"), appointments: sum("appointments"), sales: sum("sales"), notVisited: sum("notVisited"), driveMinutes: sum("driveMinutes") },
    reps: rows,
  };
}
