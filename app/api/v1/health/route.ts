import { route } from "@/lib/api/route";
import { db } from "@/lib/db";
import { workerStatus } from "@/lib/heartbeat";

export const dynamic = "force-dynamic";

// GET /api/v1/health: public, no sensitive data.
export const GET = route({ access: { public: true } }, async () => {
  let dbOk = false;
  let worker: Awaited<ReturnType<typeof workerStatus>> = { alive: false, lastTickAt: null };
  try {
    await db().$queryRawUnsafe("SELECT 1");
    dbOk = true;
    worker = await workerStatus();
  } catch {
    dbOk = false;
  }
  return { ok: dbOk && worker.alive, db: dbOk, worker: { ok: worker.alive, lastTickAt: worker.lastTickAt } };
});
