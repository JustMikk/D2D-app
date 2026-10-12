// digest.send (PRD NTF-3): emit digest.daily with per-rep counts; n8n formats and sends it.
import { db } from "@/lib/db";
import { buildDigest, emit } from "@/lib/events";
import { getSetting } from "@/lib/settings";
import type { JobHandler } from "../runner";

export const digestSend: JobHandler<"digest.send"> = async ({ date }, ctx) => {
  const timeZone = await getSetting("schedule.digestTimeZone");
  const data = await buildDigest(db(), date, timeZone);
  await emit(db(), "digest.daily", data, ctx.now);
  ctx.log(`digest for ${date}: ${data.totals.visited} visits across ${data.reps.length} reps`);
};
