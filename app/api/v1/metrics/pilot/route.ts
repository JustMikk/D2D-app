import { z } from "zod";
import { route } from "@/lib/api/route";
import { MANAGER_ROLES } from "@/lib/auth/permissions";
import { getPilotHealth } from "@/lib/services/metrics";

const Query = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

// GET /api/v1/metrics/pilot?from=&to=: the PRD success metrics, computed from real data. Viewers may read.
export const GET = route({ access: { roles: MANAGER_ROLES, viewerReads: true }, query: Query }, async ({ query }) => ({ metrics: await getPilotHealth(query) }));
