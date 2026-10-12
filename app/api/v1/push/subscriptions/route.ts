import { json, route } from "@/lib/api/route";
import { REP_ROLES } from "@/lib/auth/permissions";
import { SubscriptionBody, subscribe, UnsubscribeBody, unsubscribe } from "@/lib/services/pushSubscriptions";

// POST /api/v1/push/subscriptions and DELETE /api/v1/push/subscriptions.
export const POST = route({ access: { roles: REP_ROLES }, body: SubscriptionBody }, async ({ user, body }) => json(await subscribe(user!.id, body), 201));
export const DELETE = route({ access: { roles: REP_ROLES }, body: UnsubscribeBody }, async ({ user, body }) => unsubscribe(user!.id, body));
