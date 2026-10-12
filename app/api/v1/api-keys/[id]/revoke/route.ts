import { route } from "@/lib/api/route";
import { ADMIN_ROLES } from "@/lib/auth/permissions";
import { revokeApiKey } from "@/lib/services/apiKeys";

// POST /api/v1/api-keys/{id}/revoke: Admin.
export const POST = route<{ id: string }>({ access: { roles: ADMIN_ROLES }, idempotent: true }, async ({ user, params }) => revokeApiKey(user!.id, params.id));
