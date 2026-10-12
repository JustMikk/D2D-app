// Address resolution job (backend spec §6.3): Google calls happen outside the transaction; the result is
// written only if the door is still NEW, so a retried or duplicated job changes nothing twice.
import { audit, SYSTEM } from "@/lib/api/audit";
import { db, type Db } from "@/lib/db";
import { resolveAddress, type ResolutionDeps, type ResolutionResult, type ReviewEvidence } from "@/lib/domain/addressResolution";
import type { ReviewReason } from "@/lib/domain/enums";
import type { Address } from "@/lib/domain/intake";
import { streetKey } from "@/lib/domain/normalize";
import { doorSnapshot, emit } from "@/lib/events";
import { enqueue } from "@/lib/jobs";
import { getSettings } from "@/lib/settings";

function doorAddress(d: { street: string | null; city: string | null; state: string | null; zip: string | null }): Address | null {
  if (!d.street && !d.city) return null;
  return { street: d.street ?? "", city: d.city ?? "", state: d.state ?? "", zip: d.zip ?? "" };
}

/** Apply a resolved address: GEOCODED, review cleared, assignment queued (backend spec §6.3). */
export async function applyResolved(
  tx: Db,
  doorId: string,
  r: Extract<ResolutionResult, { kind: "resolved" }>,
  now: Date,
  assign: { reason: "NEW" | "RETRY"; ignoreDriveLimit?: boolean } = { reason: "NEW" },
) {
  await tx.door.update({
    where: { id: doorId },
    data: {
      street: r.address.street,
      city: r.address.city,
      state: r.address.state,
      zip: r.address.zip,
      streetKey: streetKey(r.address.street),
      lat: r.lat,
      lng: r.lng,
      geocodeQuality: r.quality,
      addressSource: r.source,
      placeId: r.placeId ?? null,
      status: "GEOCODED",
      reviewReason: null,
      reviewDetail: null,
    },
  });
  await enqueue(tx, "door.assign", { doorId, reason: assign.reason, ...(assign.ignoreDriveLimit ? { ignoreDriveLimit: true } : {}) }, { dedupeKey: `assign:${doorId}` });
  await emit(tx, "door.upserted", { door: await doorSnapshot(tx, doorId) }, now);
}

/** Send a door to review with its evidence (invariant 6: NEEDS_REVIEW always has a reason). */
export async function applyReview(tx: Db, doorId: string, reason: ReviewReason, evidence: ReviewEvidence, now: Date) {
  await tx.door.update({ where: { id: doorId }, data: { status: "NEEDS_REVIEW", reviewReason: reason, reviewDetail: JSON.stringify(evidence) } });
  const door = await doorSnapshot(tx, doorId);
  await emit(tx, "door.needs_review", { door, reason, evidence }, now);
  await emit(tx, "door.upserted", { door }, now);
  await audit(tx, SYSTEM, "door.needs_review", "DOOR", doorId, { reason });
}

export async function resolveDoorAddress(doorId: string, deps: ResolutionDeps, now = new Date()): Promise<ResolutionResult | { kind: "skipped" }> {
  const door = await db().door.findUnique({ where: { id: doorId }, include: { company: { select: { name: true } } } });
  if (!door || door.status !== "NEW") return { kind: "skipped" };

  const settings = await getSettings();
  const result = await resolveAddress(
    {
      companyName: door.company.name,
      companyAddress: doorAddress(door),
      jobCity: door.jobCity,
      jobState: door.jobState,
      workplaceType: (door.workplaceType as "ON_SITE" | "HYBRID" | "REMOTE" | "UNKNOWN" | null) ?? null,
    },
    deps,
    { nameMatchThreshold: settings["address.nameMatchThreshold"], metroRadiusMiles: settings["address.metroRadiusMiles"] },
  );

  return db().$transaction(async (tx) => {
    const fresh = await tx.door.findUnique({ where: { id: doorId }, select: { status: true } });
    if (fresh?.status !== "NEW") return { kind: "skipped" as const };
    if (result.kind === "resolved") {
      await applyResolved(tx, doorId, result, now);
      await audit(tx, SYSTEM, "door.geocoded", "DOOR", doorId, { source: result.source, quality: result.quality });
    } else {
      await applyReview(tx, doorId, result.reason, result.evidence, now);
    }
    return result;
  });
}
