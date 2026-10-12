import { route } from "@/lib/api/route";
import { MANAGER_ROLES } from "@/lib/auth/permissions";
import { listReps } from "@/lib/services/reps";

// GET /api/v1/reps: viewers may read.
export const GET = route({ access: { roles: MANAGER_ROLES, viewerReads: true } }, async () => ({ items: await listReps() }));
