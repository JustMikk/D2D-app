// import.commit (backend spec §8.1): runs the confirmed import row by row.
import { runImportCommit } from "@/lib/services/imports";
import type { JobHandler } from "../runner";

export const importCommit: JobHandler<"import.commit"> = async ({ batchId }, ctx) => {
  const counts = await runImportCommit(batchId, ctx.attempt, ctx.now);
  ctx.log(counts ? `imported: ${counts.created} new, ${counts.duplicates} duplicates, ${counts.merged} merged, ${counts.invalid} invalid, ${counts.doNotKnock} do-not-knock` : "nothing to do (not awaiting commit)");
};
