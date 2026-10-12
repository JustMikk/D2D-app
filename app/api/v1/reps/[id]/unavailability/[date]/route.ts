import { route } from "@/lib/api/route";
import { MANAGER_ROLES } from "@/lib/auth/permissions";
import { removeUnavailability } from "@/lib/services/reps";

// DELETE /api/v1/reps/{id}/unavailability/{date}
export const DELETE = route<{ id: string; date: string }>({ access: { roles: MANAGER_ROLES } }, async ({ user, params }) =>
  removeUnavailability(user!.id, params.id, params.date),
);
