import { route } from "@/lib/api/route";
import { REP_ROLES } from "@/lib/auth/permissions";
import { PingsBody, recordPings } from "@/lib/services/repApp";

// POST /api/v1/rep/locations: { pings } (at most 100). Pings outside a shift are ignored, not rejected.
export const POST = route({ access: { roles: REP_ROLES }, body: PingsBody }, async ({ user, body }) => recordPings(user!.id, body));
