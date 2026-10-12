import { json, route } from "@/lib/api/route";
import { REP_ROLES } from "@/lib/auth/permissions";
import { skipStop, SkipBody } from "@/lib/services/repActions";

// POST /api/v1/rep/assignments/{id}/skip: { clientId, reason, note? }. The stop goes back to assignment.
export const POST = route<{ id: string }, typeof SkipBody>({ access: { roles: REP_ROLES }, body: SkipBody }, async ({ user, params, body }) => {
  const r = await skipStop(user!.id, params.id, body);
  return json(r.body, r.status);
});
