import { json, route } from "@/lib/api/route";
import { ADMIN_ROLES } from "@/lib/auth/permissions";
import { ApiKeyCreate, createApiKey, listApiKeys } from "@/lib/services/apiKeys";

// GET /api/v1/api-keys and POST /api/v1/api-keys (returns the full key once): Admin.
export const GET = route({ access: { roles: ADMIN_ROLES } }, async () => ({ items: await listApiKeys() }));

export const POST = route({ access: { roles: ADMIN_ROLES }, body: ApiKeyCreate, idempotent: true }, async ({ user, body }) =>
  json(await createApiKey(user!.id, body), 201),
);
