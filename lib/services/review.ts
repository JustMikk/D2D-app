// Review queue (PRD ADR-4, MGR-2; backend spec §10.2 POST /doors/{id}/resolve).
import { z } from "zod";
import { audit, userActor } from "@/lib/api/audit";
import { conflict, notFound, validationFailed } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { formatAddress, geocodeQuality, type ResolutionDeps, type ReviewEvidence } from "@/lib/domain/addressResolution";
import { REVIEW_REASONS, type AddressSource, type ReviewReason } from "@/lib/domain/enums";
import type { Address } from "@/lib/domain/intake";
import { state2, str, zip5 } from "@/lib/domain/normalize";
import { doorSnapshot, emit } from "@/lib/events";
import { enqueue } from "@/lib/jobs";
import { applyResolved } from "./addressResolution";

const AddressInput = z.object({
  street: z.string().trim().min(1, "Required").regex(/^\d/, "Start with the house number"),
  city: z.string().trim().min(1, "Required"),
  state: z.string().trim().min(2, "Required"),
  zip: z.string().trim().min(5, "Use a 5-digit ZIP"),
});

export const ReviewResolve = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ACCEPT_PLACES_CANDIDATE"), candidateIndex: z.number().int().min(0) }),
  z.object({ action: z.literal("USE_COMPANY_ADDRESS") }),
  z.object({ action: z.literal("EDIT_ADDRESS"), address: AddressInput }),
  z.object({ action: z.literal("RETRY") }),
  z.object({ action: z.literal("CLEAR_COVERAGE_GAP") }),
  z.object({ action: z.literal("NO_VISIT"), note: z.string().max(500).optional() }),
]);
export type ReviewResolve = z.infer<typeof ReviewResolve>;

export function parseEvidence(json: string | null): ReviewEvidence {
  try {
    return (JSON.parse(json ?? "{}") ?? {}) as ReviewEvidence;
  } catch {
    return {};
  }
}

export async function getReviewQueue() {
  const doors = await db().door.findMany({
    where: { status: "NEEDS_REVIEW" },
    orderBy: { updatedAt: "asc" },
    include: { company: { select: { name: true, website: true } } },
  });
  const groups = REVIEW_REASONS.map((reason) => {
    const items = doors
      .filter((d) => d.reviewReason === reason)
      .map((d) => ({
        id: d.id,
        name: d.name,
        companyName: d.company.name,
        companyWebsite: d.company.website,
        externalProspectId: d.externalProspectId,
        priority: d.priority,
        jobLocation: d.jobCity ? [d.jobCity, d.jobState].filter(Boolean).join(", ") : null,
        address: { street: d.street, city: d.city, state: d.state, zip: d.zip },
        qualificationNotes: d.qualificationNotes,
        reviewReason: reason,
        evidence: parseEvidence(d.reviewDetail),
        since: d.updatedAt,
      }));
    return { reason, count: items.length, items };
  }).filter((g) => g.count > 0);
  return { total: doors.length, groups };
}

export async function reviewCount(): Promise<number> {
  return db().door.count({ where: { status: "NEEDS_REVIEW" } });
}

/** Geocode an address a manager chose; reject anything that is not rooftop or interpolated. */
async function geocodeChosen(address: Address, deps: ResolutionDeps) {
  const query = formatAddress(address);
  const geo = await deps.geocode(query);
  const quality = geocodeQuality(geo.locationType);
  if (geo.status !== "OK" || !geo.location || (quality !== "ROOFTOP" && quality !== "INTERPOLATED") || geo.partialMatch) {
    const why = geo.status !== "OK" ? `Google found no match (${geo.status})` : `the match was ${quality?.toLowerCase() ?? "unknown"}${geo.partialMatch ? ", partial" : ""}`;
    throw validationFailed([{ path: "address", message: `"${query}" could not be pinned exactly: ${why}. Check the street and ZIP.` }], "The address could not be pinned exactly.");
  }
  return { lat: geo.location.lat, lng: geo.location.lng, quality };
}

/** When the door entered review, for "time in queue" (PRD §10, mgr.review_resolved). */
async function enteredReviewAt(doorId: string): Promise<Date | null> {
  const row = await db().auditLog.findFirst({ where: { entityType: "DOOR", entityId: doorId, action: "door.needs_review" }, orderBy: { createdAt: "desc" } });
  return row?.createdAt ?? null;
}

export async function resolveReview(actorUserId: string, doorId: string, input: unknown, deps: ResolutionDeps, now = new Date()) {
  const action = ReviewResolve.parse(input);
  const door = await db().door.findUnique({ where: { id: doorId }, include: { company: true } });
  if (!door) throw notFound("That door");
  if (door.status !== "NEEDS_REVIEW") throw conflict("This door is no longer waiting for a decision.");
  const reason = door.reviewReason as ReviewReason;
  const evidence = parseEvidence(door.reviewDetail);

  // Work out the chosen address first (network), then write everything in one transaction.
  let chosen: { address: Address; source: AddressSource; placeId?: string } | null = null;
  if (action.action === "ACCEPT_PLACES_CANDIDATE") {
    const c = evidence.placesCandidates?.[action.candidateIndex];
    if (!c) throw validationFailed([{ path: "candidateIndex", message: "There is no such candidate" }]);
    chosen = { address: { street: c.street, city: c.city, state: c.state, zip: c.zip }, source: "PLACES_MATCH", placeId: c.placeId };
  } else if (action.action === "USE_COMPANY_ADDRESS") {
    const a = evidence.companyAddress ?? { street: door.company.street ?? "", city: door.company.city ?? "", state: door.company.state ?? "", zip: door.company.zip ?? "" };
    if (!/^\d/.test(str(a.street)) || !a.city) throw validationFailed([{ path: "address", message: "The company has no street address to use" }]);
    chosen = { address: { street: a.street, city: a.city, state: a.state, zip: a.zip }, source: "COMPANY_ADDRESS" };
  } else if (action.action === "EDIT_ADDRESS") {
    const state = state2(action.address.state);
    const zip = zip5(action.address.zip);
    if (!state) throw validationFailed([{ path: "address.state", message: "Use a US state, like TX" }]);
    if (zip.length !== 5) throw validationFailed([{ path: "address.zip", message: "Use a 5-digit ZIP" }]);
    chosen = { address: { street: action.address.street, city: action.address.city, state, zip }, source: "MANUAL" };
  } else if (action.action === "CLEAR_COVERAGE_GAP" && reason !== "COVERAGE_GAP") {
    throw conflict("Only a coverage gap can be cleared this way.");
  }
  const geo = chosen ? await geocodeChosen(chosen.address, deps) : null;
  const since = await enteredReviewAt(doorId);

  await db().$transaction(async (tx) => {
    // Re-check inside the transaction: another manager may have resolved it meanwhile.
    const fresh = await tx.door.findUnique({ where: { id: doorId }, select: { status: true } });
    if (fresh?.status !== "NEEDS_REVIEW") throw conflict("This door is no longer waiting for a decision.");

    if (chosen && geo) {
      await applyResolved(tx, doorId, { kind: "resolved", address: chosen.address, lat: geo.lat, lng: geo.lng, quality: geo.quality, source: chosen.source, placeId: chosen.placeId }, now, { reason: "RETRY" });
    } else if (action.action === "RETRY") {
      await tx.door.update({ where: { id: doorId }, data: { status: "NEW", reviewReason: null, reviewDetail: null } });
      await enqueue(tx, "address.resolve", { doorId }, { dedupeKey: `resolve:${doorId}` });
      await emit(tx, "door.upserted", { door: await doorSnapshot(tx, doorId) }, now);
    } else if (action.action === "CLEAR_COVERAGE_GAP") {
      await tx.door.update({ where: { id: doorId }, data: { status: "GEOCODED", reviewReason: null, reviewDetail: null } });
      await enqueue(tx, "door.assign", { doorId, reason: "RETRY", ignoreDriveLimit: true }, { dedupeKey: `assign:${doorId}` });
      await emit(tx, "door.upserted", { door: await doorSnapshot(tx, doorId) }, now);
    } else if (action.action === "NO_VISIT") {
      await tx.door.update({ where: { id: doorId }, data: { status: "CLOSED", closedReason: "NO_VISIT", closedAt: now, reviewReason: null, reviewDetail: null } });
      await tx.assignment.updateMany({ where: { doorId, status: "ACTIVE" }, data: { status: "CANCELLED", reason: "Door closed: no visit" } });
      await emit(tx, "door.upserted", { door: await doorSnapshot(tx, doorId) }, now);
    }

    await audit(tx, userActor(actorUserId), "review.resolved", "DOOR", doorId, {
      reason,
      action: action.action,
      ...(action.action === "NO_VISIT" && action.note ? { note: action.note } : {}),
      ...(chosen ? { address: chosen.address, source: chosen.source } : {}),
      minutesInQueue: since ? Math.round((now.getTime() - since.getTime()) / 60_000) : null,
    });
  });

  return doorSnapshot(db(), doorId);
}
