// Outbound webhook signing (backend spec §9.3). The receiver (n8n) recomputes
// HMAC-SHA256("{timestamp}.{raw body}") with the shared secret, rejects timestamps older than
// 5 minutes, and dedupes on X-Canvass-Delivery.
import { createHmac } from "node:crypto";
import { safeEqual } from "@/lib/auth/tokens";

export const SIGNATURE_TOLERANCE_S = 300;

export function signPayload(secret: string, timestamp: number, rawBody: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export function webhookHeaders(secret: string, event: { id: string; type: string }, rawBody: string, now = new Date()): Record<string, string> {
  const timestamp = Math.floor(now.getTime() / 1000);
  return {
    "content-type": "application/json",
    "x-canvass-event": event.type,
    "x-canvass-delivery": event.id,
    "x-canvass-timestamp": String(timestamp),
    "x-canvass-signature": signPayload(secret, timestamp, rawBody),
  };
}

/** What a receiver does; used by tests and documented for the n8n workflow. */
export function verifySignature(
  secret: string,
  headers: { timestamp: string | null; signature: string | null },
  rawBody: string,
  now = new Date(),
): boolean {
  const ts = Number(headers.timestamp);
  if (!headers.signature || !Number.isFinite(ts)) return false;
  if (Math.abs(now.getTime() / 1000 - ts) > SIGNATURE_TOLERANCE_S) return false;
  return safeEqual(signPayload(secret, ts, rawBody), headers.signature);
}
