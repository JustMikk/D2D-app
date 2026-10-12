// Nightly rollover at 21:00 in the rep's zone (backend spec §8.3, PRD ASN-5, ASN-6).
import { audit, SYSTEM } from "@/lib/api/audit";
import { db } from "@/lib/db";
import { localDateOf, nextWorkday, parseWorkdays } from "@/lib/domain/time";
import { doorSnapshot, emit } from "@/lib/events";
import { enqueue } from "@/lib/jobs";
import { getSettings } from "@/lib/settings";
import { applyReview } from "./addressResolution";

export type RolloverOutcome = { rolledOver: number; reviewed: number; revisits: number; shiftEnded: boolean };

export async function rolloverRep(repId: string, date: string, now = new Date()): Promise<RolloverOutcome> {
  const rep = await db().rep.findUnique({ where: { id: repId }, include: { unavailability: { select: { date: true } } } });
  if (!rep) return { rolledOver: 0, reviewed: 0, revisits: 0, shiftEnded: false };
  const settings = await getSettings();
  const out: RolloverOutcome = { rolledOver: 0, reviewed: 0, revisits: 0, shiftEnded: false };

  await db().$transaction(async (tx) => {
    // 1. A shift still open at 21:00 ends, so location sharing stops.
    if (rep.onShift) {
      await tx.shift.updateMany({ where: { repId, endedAt: null }, data: { endedAt: now, endedBy: "SYSTEM" } });
      await tx.rep.update({ where: { id: repId }, data: { onShift: false } });
      await audit(tx, SYSTEM, "shift.auto_ended", "REP", repId, { date });
      out.shiftEnded = true;
    }

    // 2. Unvisited assignments roll over; too many rollovers need a decision.
    const open = await tx.assignment.findMany({ where: { repId, scheduledFor: date, status: "ACTIVE" }, include: { door: { select: { id: true, rolloverCount: true } } } });
    for (const a of open) {
      await tx.assignment.update({ where: { id: a.id }, data: { status: "ROLLED_OVER" } });
      const rollovers = a.door.rolloverCount + 1;
      await tx.door.update({ where: { id: a.doorId }, data: { rolloverCount: rollovers } });
      if (rollovers > settings["assignment.maxRollovers"]) {
        await applyReview(tx, a.doorId, "ROLLOVER_LIMIT", { rollovers }, now);
        out.reviewed++;
      } else {
        await tx.door.update({ where: { id: a.doorId }, data: { status: "GEOCODED" } });
        await enqueue(tx, "door.assign", { doorId: a.doorId, reason: "ROLLOVER" }, { dedupeKey: `assign:${a.doorId}` });
        await emit(tx, "door.upserted", { door: await doorSnapshot(tx, a.doorId) }, now);
        out.rolledOver++;
      }
    }

    // 3. Re-visits: this rep's visited doors whose next step is due by their next working day.
    // Overdue next steps are included, so a follow-up is never stranded by a missed day.
    const next = nextWorkday({ workdays: parseWorkdays(rep.workdays), unavailableDates: rep.unavailability.map((u) => u.date) }, date);
    const visited = await tx.door.findMany({ where: { status: "VISITED", preferredRepId: repId, nextStepAt: { not: null } }, select: { id: true, nextStepAt: true } });
    for (const d of visited) {
      if (localDateOf(d.nextStepAt!, rep.timeZone) > next) continue;
      await enqueue(tx, "door.assign", { doorId: d.id, reason: "REVISIT" }, { dedupeKey: `assign:${d.id}` });
      out.revisits++;
    }
  });
  return out;
}
