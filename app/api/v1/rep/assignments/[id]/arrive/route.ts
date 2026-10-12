import { json, route } from "@/lib/api/route";
import { REP_ROLES } from "@/lib/auth/permissions";
import { ArriveAction, arrive } from "@/lib/services/repApp";

// POST /api/v1/rep/assignments/{id}/arrive: { clientId, location? } returns { distanceM, offSite }.
export const POST = route<{ id: string }, typeof ArriveAction>({ access: { roles: REP_ROLES }, body: ArriveAction }, async ({ user, params, body }) => {
  const r = await arrive(user!.id, params.id, body);
  return json(r.body, r.status);
});
