import { z } from "zod";
import { route } from "@/lib/api/route";
import { REP_ROLES } from "@/lib/auth/permissions";
import { getToday } from "@/lib/services/repApp";

const Query = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

// GET /api/v1/rep/today?date=: the rep's day. The date defaults to the rep's local today.
export const GET = route({ access: { roles: REP_ROLES }, query: Query }, async ({ user, query }) => getToday(user!.id, query.date));
