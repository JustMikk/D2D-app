// Worker heartbeat for GET /health. Stored as an AppSetting row with a reserved "_" prefix: the settings
// registry ignores unknown keys on read and refuses them on write, so admins never see or edit it.
import { db } from "@/lib/db";

export const HEARTBEAT_KEY = "_worker.heartbeat";

export async function writeHeartbeat(workerId: string, at = new Date()): Promise<void> {
  const value = JSON.stringify({ workerId, at: at.toISOString() });
  await db().appSetting.upsert({ where: { key: HEARTBEAT_KEY }, create: { key: HEARTBEAT_KEY, value }, update: { value } });
}

export async function readHeartbeat(): Promise<{ workerId: string; at: string } | null> {
  const row = await db().appSetting.findUnique({ where: { key: HEARTBEAT_KEY } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as { workerId: string; at: string };
  } catch {
    return null;
  }
}

/** The worker writes a heartbeat every 60 seconds; three missed ticks count as down. */
export const WORKER_STALE_MS = 3 * 60_000;

export async function workerStatus(now = Date.now()): Promise<{ alive: boolean; lastTickAt: string | null }> {
  const beat = await readHeartbeat();
  return { alive: beat !== null && now - Date.parse(beat.at) < WORKER_STALE_MS, lastTickAt: beat?.at ?? null };
}
