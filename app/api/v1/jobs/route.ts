import { route } from "@/lib/api/route";
import { ADMIN_ROLES } from "@/lib/auth/permissions";
import { JobListQuery, listJobs } from "@/lib/services/ops";

// GET /api/v1/jobs?status=FAILED: Admin.
export const GET = route({ access: { roles: ADMIN_ROLES }, query: JobListQuery }, async ({ query }) => listJobs(query));
