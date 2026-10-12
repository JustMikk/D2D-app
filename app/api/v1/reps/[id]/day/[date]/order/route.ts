import { route } from "@/lib/api/route";
import { MANAGER_ROLES } from "@/lib/auth/permissions";
import { reorderStops, ReorderBody } from "@/lib/services/reorder";

// PUT /api/v1/reps/{id}/day/{date}/order: { assignmentIds } in the new visiting order (every open stop, once).
export const PUT = route<{ id: string; date: string }, typeof ReorderBody>(
  { access: { roles: MANAGER_ROLES }, body: ReorderBody, idempotent: true },
  async ({ user, params, body }) => reorderStops(user!.id, params.id, params.date, body),
);
