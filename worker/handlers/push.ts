// push.send (backend spec §8.1, §9.2). Without VAPID keys configured the job completes quietly: the app
// falls back to polling, and a missing key must not fill the failed-jobs list.
import { sendPushToUser } from "@/lib/integrations/push";
import type { JobHandler } from "../runner";

export const pushSend: JobHandler<"push.send"> = async ({ userId, title, body, url, tag }, ctx) => {
  const r = await sendPushToUser(userId, { title, body, url, tag }, undefined, ctx.now);
  ctx.log(r.skipped ? `not sent (${r.skipped})` : `sent ${r.sent}, removed ${r.removed}, failed ${r.failed}`);
};
