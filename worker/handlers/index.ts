// Job handlers by type. Types without a handler here are neither scheduled nor claimed; their jobs wait
// in the queue until the handler ships.
import type { JobType } from "@/lib/jobs";
import type { HandlerMap } from "../runner";
import { addressResolve } from "./address";
import { doorAssign, rolloverRepHandler, routePlan } from "./assignment";
import { digestSend } from "./digest";
import { importCommit } from "./imports";
import { retentionCleanup, unassignableRetry } from "./maintenance";
import { pushSend } from "./push";

export const HANDLERS: HandlerMap = {
  "address.resolve": addressResolve,
  "door.assign": doorAssign,
  "route.plan": routePlan,
  "rollover.rep": rolloverRepHandler,
  "push.send": pushSend,
  "import.commit": importCommit,
  "retention.cleanup": retentionCleanup,
  "unassignable.retry": unassignableRetry,
  "digest.send": digestSend,
};

export const ENABLED_JOB_TYPES: ReadonlySet<JobType> = new Set(Object.keys(HANDLERS) as JobType[]);
