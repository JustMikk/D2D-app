import { route } from "@/lib/api/route";
import { ADMIN_ROLES } from "@/lib/auth/permissions";
import { updateUser, UserUpdate } from "@/lib/services/users";

// PATCH /api/v1/users/{id}: Admin. { role?, active? }.
export const PATCH = route<{ id: string }, typeof UserUpdate>(
  { access: { roles: ADMIN_ROLES }, body: UserUpdate, idempotent: true },
  async ({ user, params, body }) => updateUser(user!.id, params.id, body),
);
