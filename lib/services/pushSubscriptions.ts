// Push subscription management (backend spec §10.2): one row per device endpoint.
import { z } from "zod";
import { db } from "@/lib/db";

export const SubscriptionBody = z.object({
  endpoint: z.url().max(1000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  userAgent: z.string().max(300).optional(),
});

export const UnsubscribeBody = z.object({ endpoint: z.url().max(1000) });

/** A device endpoint belongs to whoever signed in on it last: re-subscribing moves it to this user. */
export async function subscribe(userId: string, input: unknown) {
  const { endpoint, keys, userAgent } = SubscriptionBody.parse(input);
  const sub = await db().pushSubscription.upsert({
    where: { endpoint },
    create: { userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent: userAgent ?? null },
    update: { userId, p256dh: keys.p256dh, auth: keys.auth, userAgent: userAgent ?? null, failureCount: 0 },
  });
  return { id: sub.id };
}

export async function unsubscribe(userId: string, input: unknown) {
  const { endpoint } = UnsubscribeBody.parse(input);
  const result = await db().pushSubscription.deleteMany({ where: { endpoint, userId } });
  return { removed: result.count };
}
