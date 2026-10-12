import { route } from "@/lib/api/route";
import { MANAGER_ROLES } from "@/lib/auth/permissions";
import { google } from "@/lib/integrations/google";
import { getRep, RepUpdate, updateRep } from "@/lib/services/reps";

// GET /api/v1/reps/{id}; PATCH /api/v1/reps/{id}: a new baseAddress is geocoded synchronously, and
// deactivating cancels open assignments and sends the doors back through assignment.
export const GET = route<{ id: string }>({ access: { roles: MANAGER_ROLES, viewerReads: true } }, async ({ params }) => getRep(params.id));

export const PATCH = route<{ id: string }, typeof RepUpdate>(
  { access: { roles: MANAGER_ROLES }, body: RepUpdate, idempotent: true },
  async ({ user, params, body }) => updateRep(user!.id, params.id, body, { geocode: (q) => google().geocode(q) }),
);
