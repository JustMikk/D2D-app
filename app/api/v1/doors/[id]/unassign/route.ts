import { route } from "@/lib/api/route";
import { MANAGER_ROLES } from "@/lib/auth/permissions";
import { ManualUnassign, manualUnassign } from "@/lib/services/manualAssignment";

// POST /api/v1/doors/{id}/unassign: { reason }. Back to Ready without re-running the engine.
export const POST = route<{ id: string }, typeof ManualUnassign>(
  { access: { roles: MANAGER_ROLES }, body: ManualUnassign, idempotent: true },
  async ({ user, params, body }) => manualUnassign(user!.id, params.id, body),
);
