import { route } from "@/lib/api/route";
import { ROLES } from "@/lib/domain/enums";
import { Preferences, updatePreferences } from "@/lib/services/users";

// PATCH /api/v1/me/preferences: { theme?, mapsApp? }.
export const PATCH = route({ access: { roles: ROLES }, body: Preferences }, async ({ user, body }) => ({
  preferences: await updatePreferences(user!.id, body),
}));
