import { route } from "@/lib/api/route";
import { MANAGER_ROLES } from "@/lib/auth/permissions";
import { DoorListQuery, listDoors } from "@/lib/services/doors";

// GET /api/v1/doors?status=&repId=&date=&q=&source=&cursor=&limit= (PRD MGR-3). Viewers may read.
export const GET = route({ access: { roles: MANAGER_ROLES, viewerReads: true }, query: DoorListQuery }, async ({ query }) => listDoors(query));
