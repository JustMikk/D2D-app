// Console mutations accept an optional Idempotency-Key header; the first response is stored for 24 hours
// and replayed for repeats (backend spec §10.1). Rep mutations use per-record clientId instead.
import { db } from "@/lib/db";

export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;

export type StoredResponse = { status: number; body: unknown };

export async function findStoredResponse(userId: string, key: string, now = new Date()): Promise<StoredResponse | null> {
  const row = await db().idempotencyKey.findUnique({ where: { userId_key: { userId, key } } });
  if (!row || now.getTime() - row.createdAt.getTime() > IDEMPOTENCY_TTL_MS) return null;
  return { status: row.statusCode, body: JSON.parse(row.responseBody) };
}

export async function storeResponse(userId: string, key: string, method: string, path: string, response: StoredResponse): Promise<void> {
  await db().idempotencyKey.upsert({
    where: { userId_key: { userId, key } },
    create: { userId, key, method, path, statusCode: response.status, responseBody: JSON.stringify(response.body) },
    update: { method, path, statusCode: response.status, responseBody: JSON.stringify(response.body), createdAt: new Date() },
  });
}

/**
 * Rep actions carry a client-generated clientId (backend spec §10.1). The first call runs and its response
 * is stored; a repeat returns the original with the same status. `replayed` tells the caller which it was.
 */
export async function replayOrRun<T>(
  userId: string,
  clientId: string,
  method: string,
  path: string,
  run: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; replayed: boolean }> {
  const stored = await findStoredResponse(userId, clientId);
  if (stored) return { status: 200, body: stored.body as T, replayed: true };
  const result = await run();
  await storeResponse(userId, clientId, method, path, result);
  return { ...result, replayed: false };
}
