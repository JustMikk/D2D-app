import { route } from "@/lib/api/route";
import { REP_ROLES } from "@/lib/auth/permissions";
import { acknowledgeMonitoring } from "@/lib/services/users";

// POST /api/v1/me/monitoring-ack: the rep acknowledges the location monitoring notice.
export const POST = route({ access: { roles: REP_ROLES } }, async ({ user }) => acknowledgeMonitoring(user!.id));
