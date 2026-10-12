import { route } from "@/lib/api/route";
import { ADMIN_ROLES } from "@/lib/auth/permissions";
import { retryOutboxEvent } from "@/lib/services/ops";

// POST /api/v1/outbox/{id}/retry: Admin. A FAILED event goes back to PENDING.
export const POST = route<{ id: string }>({ access: { roles: ADMIN_ROLES }, idempotent: true }, async ({ user, params }) =>
  retryOutboxEvent(user!.id, params.id),
);
