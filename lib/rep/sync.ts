// The sync engine (PRD REP-7): sends the outbox to the server in order. An item is removed only after
// the server acknowledges it. Failures are sorted by what retrying can fix:
//   network error, 5xx, 408, 429  → stop and try again later (the item is fine)
//   401                           → stop and ask the rep to sign in again (nothing is lost)
//   any other 4xx                 → the server refused this item for good: mark it failed, keep going
import type { Outbox, OutboxItem } from "./outbox";

export type StopReason = "offline" | "server" | "auth";
export type FlushResult = { sent: number; failed: number; remaining: number; stopped: StopReason | null };

export type FlushOptions = {
  fetch?: typeof fetch;
  /** Called after each acknowledged item, before it leaves the outbox (the app patches its cache here). */
  onAck?: (item: OutboxItem) => void | Promise<void>;
  signal?: AbortSignal;
};

type Sent = { kind: "ok"; body: unknown } | { kind: "stop"; reason: StopReason; message: string } | { kind: "refused"; message: string };

async function send(doFetch: typeof fetch, url: string, init: RequestInit): Promise<Sent> {
  let res: Response;
  try {
    res = await doFetch(url, { credentials: "same-origin", ...init });
  } catch {
    return { kind: "stop", reason: "offline", message: "No connection" };
  }
  if (res.ok) return { kind: "ok", body: await res.json().catch(() => ({})) };
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  const message = data.error?.message ?? `HTTP ${res.status}`;
  if (res.status === 401) return { kind: "stop", reason: "auth", message };
  if (res.status >= 500 || res.status === 408 || res.status === 429) return { kind: "stop", reason: "server", message };
  return { kind: "refused", message };
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const mediaCacheKey = (clientId: string) => `media:${clientId}`;

export async function flush(box: Outbox, options: FlushOptions = {}): Promise<FlushResult> {
  const doFetch = options.fetch ?? fetch;
  const result: FlushResult = { sent: 0, failed: 0, remaining: 0, stopped: null };

  const ack = async (items: OutboxItem[]) => {
    for (const item of items) await options.onAck?.(item);
    await box.removeMany(items.map((i) => i.seq));
    result.sent += items.length;
  };

  const items = (await box.list()).filter((i) => i.status === "pending");
  for (let idx = 0; idx < items.length; idx++) {
    if (options.signal?.aborted) break;
    const item = items[idx]!;
    let sent: Sent;

    if (item.kind === "ping" || item.kind === "event") {
      // Consecutive pings (or analytics events) go as one batch: at most 100 pings or 50 events.
      const kind = item.kind;
      const limit = kind === "ping" ? 100 : 50;
      const batch: OutboxItem[] = [item];
      while (idx + 1 < items.length && items[idx + 1]!.kind === kind && batch.length < limit) batch.push(items[++idx]!);
      const body = kind === "ping" ? { pings: batch.map((b) => b.payload) } : { events: batch.map((b) => b.payload) };
      sent = await send(doFetch, kind === "ping" ? "/api/v1/rep/locations" : "/api/v1/rep/events", json(body));
      if (sent.kind === "ok") {
        await ack(batch);
        continue;
      }
      await settle(box, batch, sent, result);
      if (sent.kind === "stop") break;
      continue;
    }

    if (item.kind === "media") {
      const blob = await box.getBlob(item.payload.clientId);
      if (!blob) {
        await box.fail(item.seq, "The photo is no longer on this phone.");
        result.failed++;
        continue;
      }
      const form = new FormData();
      form.set("file", blob, item.payload.kind === "SIGNATURE" ? "signature.png" : "photo.jpg");
      form.set("clientId", item.payload.clientId);
      form.set("kind", item.payload.kind);
      sent = await send(doFetch, "/api/v1/media", { method: "POST", body: form });
      if (sent.kind === "ok") {
        // Remember which server file this upload became, so the visit can name it.
        await box.setCache(mediaCacheKey(item.payload.clientId), (sent.body as { mediaId: string }).mediaId);
        await ack([item]);
        await box.deleteBlob(item.payload.clientId);
        continue;
      }
    } else if (item.kind === "visit") {
      const { photoClientIds, signatureClientId, ...rest } = item.payload;
      const resolve = async (clientId: string) => box.getCache<string>(mediaCacheKey(clientId));
      const photoMediaIds = await Promise.all((photoClientIds ?? []).map(resolve));
      const signatureMediaId = signatureClientId ? await resolve(signatureClientId) : undefined;
      if (photoMediaIds.some((m) => !m) || (signatureClientId && !signatureMediaId)) {
        await box.fail(item.seq, "A photo or signature didn't upload, so this visit couldn't be sent.");
        result.failed++;
        continue;
      }
      sent = await send(doFetch, "/api/v1/rep/visits", json({ ...rest, ...(photoMediaIds.length ? { photoMediaIds } : {}), ...(signatureMediaId ? { signatureMediaId } : {}) }));
    } else if (item.kind === "skip") {
      const { assignmentId, ...body } = item.payload;
      sent = await send(doFetch, `/api/v1/rep/assignments/${assignmentId}/skip`, json(body));
    } else if (item.kind === "arrive") {
      const { assignmentId, ...body } = item.payload;
      sent = await send(doFetch, `/api/v1/rep/assignments/${assignmentId}/arrive`, json(body));
    } else {
      sent = await send(doFetch, item.kind === "shift.start" ? "/api/v1/rep/shift/start" : "/api/v1/rep/shift/end", json(item.payload));
    }

    if (sent.kind === "ok") {
      await ack([item]);
      continue;
    }
    await settle(box, [item], sent, result);
    if (sent.kind === "stop") break;
  }

  result.remaining = (await box.list()).filter((i) => i.status === "pending").length;
  return result;
}

async function settle(box: Outbox, items: OutboxItem[], sent: Exclude<Sent, { kind: "ok" }>, result: FlushResult) {
  if (sent.kind === "refused") {
    // Analytics are best effort: a batch the server refuses is dropped, never shown to the rep.
    if (items.every((i) => i.kind === "event")) return void (await box.removeMany(items.map((i) => i.seq)));
    for (const i of items) await box.fail(i.seq, sent.message);
    result.failed += items.length;
    return;
  }
  result.stopped = sent.reason;
  // Only a server-side problem counts against the item; being offline is nobody's fault.
  if (sent.reason === "server") for (const i of items) await box.bump(i.seq, sent.message);
}
