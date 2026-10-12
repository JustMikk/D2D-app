import { route } from "@/lib/api/route";
import { MANAGER_ROLES } from "@/lib/auth/permissions";
import { google } from "@/lib/integrations/google";
import { resolveReview, ReviewResolve } from "@/lib/services/review";

// POST /api/v1/doors/{id}/resolve (PRD ADR-4): geocodes synchronously where needed and returns the door.
export const POST = route<{ id: string }, typeof ReviewResolve>(
  { access: { roles: MANAGER_ROLES }, body: ReviewResolve, idempotent: true },
  async ({ user, params, body }) => resolveReview(user!.id, params.id, body, google()),
);
