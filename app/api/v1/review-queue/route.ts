import { route } from "@/lib/api/route";
import { MANAGER_ROLES } from "@/lib/auth/permissions";
import { getReviewQueue } from "@/lib/services/review";

// GET /api/v1/review-queue: grouped by reason, oldest first (PRD MGR-2). Viewers may read.
export const GET = route({ access: { roles: MANAGER_ROLES, viewerReads: true } }, async () => getReviewQueue());
