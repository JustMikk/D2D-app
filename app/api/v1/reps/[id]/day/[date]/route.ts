import { route } from "@/lib/api/route";
import { MANAGER_ROLES } from "@/lib/auth/permissions";
import { getRepDay } from "@/lib/services/reps";

// GET /api/v1/reps/{id}/day/{date}: route, shift, sampled pings and visits for the rep day board.
export const GET = route<{ id: string; date: string }>({ access: { roles: MANAGER_ROLES, viewerReads: true } }, async ({ user, params }) =>
  getRepDay(user!.id, params.id, params.date),
);
