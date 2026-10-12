// Web push (backend spec §9.2): VAPID keys from env; push.send sends to every subscription the user has.
// A 404 or 410 deletes the subscription; other failures count up, and 5 in a row delete it.
import webpush from "web-push";
import { db } from "@/lib/db";

export type PushPayload = { title: string; body: string; url: string; tag: string };
export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string } };

export interface PushSender {
  /** Throws an error with a numeric statusCode when the push service refuses. */
  send(target: PushTarget, payload: string): Promise<void>;
}

export const MAX_PUSH_FAILURES = 5;

export function vapidConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
}

let override: PushSender | null = null;
export function setPushSender(sender: PushSender | null): void {
  override = sender;
}

export function pushSender(): PushSender {
  if (override) return override;
  return {
    async send(target, payload) {
      webpush.setVapidDetails(process.env.VAPID_SUBJECT!, process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
      await webpush.sendNotification(target, payload, { TTL: 3600 });
    },
  };
}

function statusOf(error: unknown): number | null {
  return typeof error === "object" && error !== null && "statusCode" in error && typeof (error as { statusCode: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : null;
}

export type PushResult = { sent: number; removed: number; failed: number; skipped: "not_configured" | "no_subscriptions" | null };

/** Send to all of a user's devices. Never throws for a single bad device. */
export async function sendPushToUser(userId: string, payload: PushPayload, sender: PushSender = pushSender(), now = new Date()): Promise<PushResult> {
  if (!override && !vapidConfigured()) return { sent: 0, removed: 0, failed: 0, skipped: "not_configured" };
  const subs = await db().pushSubscription.findMany({ where: { userId } });
  if (subs.length === 0) return { sent: 0, removed: 0, failed: 0, skipped: "no_subscriptions" };

  const body = JSON.stringify(payload);
  const result: PushResult = { sent: 0, removed: 0, failed: 0, skipped: null };
  for (const sub of subs) {
    try {
      await sender.send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body);
      await db().pushSubscription.update({ where: { id: sub.id }, data: { failureCount: 0, lastSuccessAt: now } });
      result.sent++;
    } catch (error) {
      const status = statusOf(error);
      const gone = status === 404 || status === 410;
      const failures = sub.failureCount + 1;
      if (gone || failures >= MAX_PUSH_FAILURES) {
        await db().pushSubscription.delete({ where: { id: sub.id } });
        result.removed++;
      } else {
        await db().pushSubscription.update({ where: { id: sub.id }, data: { failureCount: failures } });
        result.failed++;
      }
    }
  }
  return result;
}
