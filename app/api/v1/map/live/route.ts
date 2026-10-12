import { route } from "@/lib/api/route";
import { MANAGER_ROLES } from "@/lib/auth/permissions";
import { getLiveMap, MapLiveQuery } from "@/lib/services/mapLive";

export const dynamic = "force-dynamic";

// GET /api/v1/map/live?date=&repId=&status=: rep markers and door pins for the console map. Viewers may read.
export const GET = route({ access: { roles: MANAGER_ROLES, viewerReads: true }, query: MapLiveQuery }, async ({ query }) => getLiveMap(query));
