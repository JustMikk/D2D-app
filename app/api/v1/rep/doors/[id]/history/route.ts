import { route } from "@/lib/api/route";
import { REP_ROLES } from "@/lib/auth/permissions";
import { doorHistory } from "@/lib/services/repActions";

// GET /api/v1/rep/doors/{id}/history: past visits and notes for a door the rep has a stop at.
export const GET = route<{ id: string }>({ access: { roles: REP_ROLES } }, async ({ user, params }) => doorHistory(user!.id, params.id));
