import { route } from "@/lib/api/route";
import { ADMIN_ROLES } from "@/lib/auth/permissions";
import { discardImport, getImport } from "@/lib/services/imports";

// GET /api/v1/imports/{id}: counts and status (poll it while a commit runs). DELETE discards an unconfirmed preview.
export const GET = route<{ id: string }>({ access: { roles: ADMIN_ROLES } }, async ({ params }) => getImport(params.id));
export const DELETE = route<{ id: string }>({ access: { roles: ADMIN_ROLES } }, async ({ user, params }) => discardImport(user!.id, params.id));
