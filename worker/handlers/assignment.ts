// door.assign, route.plan and rollover.rep (backend spec §8.1).
import { google } from "@/lib/integrations/google";
import { assignDoorById } from "@/lib/services/assignment";
import { rolloverRep } from "@/lib/services/rollover";
import { planRoute } from "@/lib/services/routes";
import type { JobHandler } from "../runner";

export const doorAssign: JobHandler<"door.assign"> = async ({ doorId, reason, ignoreDriveLimit, avoid }, ctx) => {
  const result = await assignDoorById(doorId, { reason, ignoreDriveLimit, avoid }, google().driveTimes, ctx.now);
  ctx.log(result.kind === "assigned" ? `assigned to ${result.repId} for ${result.date} (${result.driveMinutes} min)` : result.kind === "skipped" ? `skipped: ${result.why}` : result.kind);
};

export const routePlan: JobHandler<"route.plan"> = async ({ repId, date, trigger, start }, ctx) => {
  const result = await planRoute({ repId, date, trigger, start }, { optimizeTours: (i) => google().optimizeTours(i) }, ctx.now);
  ctx.log(result.kind === "planned" ? `planned ${result.stops} stops (${result.provider}, ${result.status}${result.fallback ? `, fell back: ${result.fallback}` : ""})` : `skipped: ${result.why}`);
};

export const rolloverRepHandler: JobHandler<"rollover.rep"> = async ({ repId, date }, ctx) => {
  const r = await rolloverRep(repId, date, ctx.now);
  ctx.log(`rolled over ${r.rolledOver}, to review ${r.reviewed}, revisits ${r.revisits}${r.shiftEnded ? ", shift ended" : ""}`);
};
