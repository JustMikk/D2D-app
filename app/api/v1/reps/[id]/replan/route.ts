import { z } from "zod";
import { json, route } from "@/lib/api/route";
import { MANAGER_ROLES } from "@/lib/auth/permissions";
import { requestReplan } from "@/lib/services/reps";

const Body = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

// POST /api/v1/reps/{id}/replan: { date }. Queued; the worker plans the route.
export const POST = route<{ id: string }, typeof Body>({ access: { roles: MANAGER_ROLES }, body: Body }, async ({ user, params, body }) =>
  json(await requestReplan(user!.id, params.id, body.date), 202),
);
