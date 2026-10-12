import { json, route } from "@/lib/api/route";
import { REP_ROLES } from "@/lib/auth/permissions";
import { createVisit, VisitCreate } from "@/lib/services/visits";

// POST /api/v1/rep/visits: idempotent on clientId (a repeat returns the original with 200).
export const POST = route({ access: { roles: REP_ROLES }, body: VisitCreate }, async ({ user, body }) => {
  const r = await createVisit(user!.id, body);
  return json(r.body, r.status);
});
