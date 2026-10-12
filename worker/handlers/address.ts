// address.resolve (backend spec §6.3).
import { google } from "@/lib/integrations/google";
import { resolveDoorAddress } from "@/lib/services/addressResolution";
import type { JobHandler } from "../runner";

export const addressResolve: JobHandler<"address.resolve"> = async ({ doorId }, ctx) => {
  const result = await resolveDoorAddress(doorId, google(), ctx.now);
  ctx.log(result.kind === "resolved" ? `resolved (${result.source}, ${result.quality})` : result.kind === "review" ? `needs review: ${result.reason}` : "skipped (door is no longer NEW)");
};
