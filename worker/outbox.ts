// Outbox delivery (backend spec §9.3, PRD NTF-1): every 10 seconds, post due events to the n8n webhook
// in order of creation. Any 2xx marks the event SENT. Otherwise retry after 30 s, 1 m, 5 m, 15 m, 30 m,
// 1 h, 2 h, 4 h, 8 h and 8 h (about 24 hours), then FAILED, shown in Settings with a retry button.
// A failing event does not hold back later ones; each retries on its own schedule.
import { db } from "@/lib/db";
import { webhookHeaders } from "@/lib/integrations/webhooks";
import type { FetchLike } from "@/lib/integrations/google/http";

export const RETRY_SCHEDULE_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 3600_000, 2 * 3600_000, 4 * 3600_000, 8 * 3600_000, 8 * 3600_000];
export const DELIVERY_BATCH = 50;
const DELIVERY_TIMEOUT_MS = 10_000;

export type DeliveryConfig = { url: string; secret: string; fetch?: FetchLike; now?: () => Date };
export type DeliveryResult = { sent: number; retried: number; failed: number };

/** Where an event goes after its nth failed attempt: back to PENDING at a later time, or FAILED. */
export function afterFailure(attempts: number, now: Date): { status: "PENDING"; nextAttemptAt: Date } | { status: "FAILED" } {
  const wait = RETRY_SCHEDULE_MS[attempts - 1];
  return wait === undefined ? { status: "FAILED" } : { status: "PENDING", nextAttemptAt: new Date(now.getTime() + wait) };
}

export async function deliverDueEvents(config: DeliveryConfig): Promise<DeliveryResult> {
  const now = config.now ?? (() => new Date());
  const doFetch = config.fetch ?? fetch;
  const due = await db().outboxEvent.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: now() } },
    orderBy: { createdAt: "asc" },
    take: DELIVERY_BATCH,
  });

  const result: DeliveryResult = { sent: 0, retried: 0, failed: 0 };
  for (const event of due) {
    let error: string | null = null;
    try {
      const res = await doFetch(config.url, {
        method: "POST",
        headers: webhookHeaders(config.secret, { id: event.id, type: event.type }, event.payload, now()),
        body: event.payload,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!res.ok) error = `HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`.trim();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    const attempts = event.attempts + 1;
    if (error === null) {
      await db().outboxEvent.update({ where: { id: event.id }, data: { status: "SENT", attempts, sentAt: now(), lastError: null } });
      result.sent++;
      continue;
    }
    const next = afterFailure(attempts, now());
    await db().outboxEvent.update({
      where: { id: event.id },
      data: next.status === "FAILED" ? { status: "FAILED", attempts, lastError: error } : { status: "PENDING", attempts, nextAttemptAt: next.nextAttemptAt, lastError: error },
    });
    if (next.status === "FAILED") {
      result.failed++;
      console.error(`[outbox] ${event.type} ${event.id} failed for good after ${attempts} attempts: ${error}`);
    } else {
      result.retried++;
    }
  }
  return result;
}
