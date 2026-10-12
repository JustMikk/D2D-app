import { json, route } from "@/lib/api/route";
import { REP_ROLES } from "@/lib/auth/permissions";
import { endShift, ShiftAction } from "@/lib/services/repApp";

// POST /api/v1/rep/shift/end: ends the shift and returns { remainingStops }.
export const POST = route({ access: { roles: REP_ROLES }, body: ShiftAction }, async ({ user, body }) => {
  const r = await endShift(user!.id, body);
  return json(r.body, r.status);
});
