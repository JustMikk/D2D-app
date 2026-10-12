import { route } from "@/lib/api/route";
import { ADMIN_ROLES } from "@/lib/auth/permissions";
import { removeDoNotKnock } from "@/lib/services/doNotKnock";

// DELETE /api/v1/do-not-knock/{id}: Admin. New prospects are accepted again; closed doors stay closed.
export const DELETE = route<{ id: string }>({ access: { roles: ADMIN_ROLES } }, async ({ user, params }) => removeDoNotKnock(user!.id, params.id));
