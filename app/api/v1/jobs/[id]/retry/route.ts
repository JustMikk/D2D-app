import { route } from "@/lib/api/route";
import { ADMIN_ROLES } from "@/lib/auth/permissions";
import { retryJob } from "@/lib/services/ops";

// POST /api/v1/jobs/{id}/retry: Admin. A FAILED job goes back to QUEUED.
export const POST = route<{ id: string }>({ access: { roles: ADMIN_ROLES }, idempotent: true }, async ({ user, params }) => retryJob(user!.id, params.id));
