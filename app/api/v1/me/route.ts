import { route } from "@/lib/api/route";
import { ROLES } from "@/lib/domain/enums";
import { getMe } from "@/lib/services/users";

// GET /api/v1/me: user, rep profile and client settings.
export const GET = route({ access: { roles: ROLES } }, async ({ user }) => getMe(user!.id));
