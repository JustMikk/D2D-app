import { z } from "zod";
import { userActor } from "@/lib/api/audit";
import { route } from "@/lib/api/route";
import { ADMIN_ROLES } from "@/lib/auth/permissions";
import { getSettings, updateSettings } from "@/lib/settings";

// GET /api/v1/settings and PUT /api/v1/settings (partial map, validated per key): Admin.
export const GET = route({ access: { roles: ADMIN_ROLES } }, async () => ({ settings: await getSettings() }));

export const PUT = route({ access: { roles: ADMIN_ROLES }, body: z.record(z.string(), z.unknown()), idempotent: true }, async ({ user, body }) => ({
  settings: await updateSettings(userActor(user!.id), body),
}));
