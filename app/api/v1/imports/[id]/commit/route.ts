import { json, route } from "@/lib/api/route";
import { ADMIN_ROLES } from "@/lib/auth/permissions";
import { commitImport } from "@/lib/services/imports";

// POST /api/v1/imports/{id}/commit: Admin. Queues the import; the worker runs it.
export const POST = route<{ id: string }>({ access: { roles: ADMIN_ROLES }, idempotent: true }, async ({ user, params }) => json(await commitImport(user!.id, params.id), 202));
