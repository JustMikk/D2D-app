import { route } from "@/lib/api/route";
import { ADMIN_ROLES } from "@/lib/auth/permissions";
import { listUsers } from "@/lib/services/users";

// GET /api/v1/users: Admin.
export const GET = route({ access: { roles: ADMIN_ROLES } }, async () => ({ items: await listUsers(), nextCursor: null }));
