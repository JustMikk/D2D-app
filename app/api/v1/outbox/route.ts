import { route } from "@/lib/api/route";
import { ADMIN_ROLES } from "@/lib/auth/permissions";
import { listOutbox, OutboxListQuery } from "@/lib/services/ops";

// GET /api/v1/outbox?status=FAILED: Admin.
export const GET = route({ access: { roles: ADMIN_ROLES }, query: OutboxListQuery }, async ({ query }) => listOutbox(query));
