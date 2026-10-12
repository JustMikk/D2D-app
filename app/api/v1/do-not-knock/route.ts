import { json, route } from "@/lib/api/route";
import { ADMIN_ROLES } from "@/lib/auth/permissions";
import { addDoNotKnock, DoNotKnockCreate, listDoNotKnock } from "@/lib/services/doNotKnock";

// GET and POST /api/v1/do-not-knock: Admin. Adding closes any open doors that match.
export const GET = route({ access: { roles: ADMIN_ROLES } }, async () => ({ items: await listDoNotKnock() }));
export const POST = route({ access: { roles: ADMIN_ROLES }, body: DoNotKnockCreate, idempotent: true }, async ({ user, body }) => json(await addDoNotKnock(user!.id, body), 201));
