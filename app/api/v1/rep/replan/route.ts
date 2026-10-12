import { route } from "@/lib/api/route";
import { REP_ROLES } from "@/lib/auth/permissions";
import { ReplanBody, replanFromHere } from "@/lib/services/repApp";

// POST /api/v1/rep/replan: { location? } re-plans today from here and returns the Today response.
export const POST = route({ access: { roles: REP_ROLES }, body: ReplanBody }, async ({ user, body }) => replanFromHere(user!.id, body));
