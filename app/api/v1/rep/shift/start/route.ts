import { json, route } from "@/lib/api/route";
import { REP_ROLES } from "@/lib/auth/permissions";
import { ShiftAction, startShift } from "@/lib/services/repApp";

// POST /api/v1/rep/shift/start: { clientId, location?, recordedAt? }. Idempotent on clientId.
export const POST = route({ access: { roles: REP_ROLES }, body: ShiftAction }, async ({ user, body }) => {
  const r = await startShift(user!.id, body);
  return json(r.body, r.status);
});
