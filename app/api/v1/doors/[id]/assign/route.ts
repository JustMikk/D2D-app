import { route } from "@/lib/api/route";
import { MANAGER_ROLES } from "@/lib/auth/permissions";
import { ManualAssign, manualAssign } from "@/lib/services/manualAssignment";

// POST /api/v1/doors/{id}/assign: { repId, date, reason? }. A manual assignment the engine never overrides.
export const POST = route<{ id: string }, typeof ManualAssign>(
  { access: { roles: MANAGER_ROLES }, body: ManualAssign, idempotent: true },
  async ({ user, params, body }) => manualAssign(user!.id, params.id, body),
);
