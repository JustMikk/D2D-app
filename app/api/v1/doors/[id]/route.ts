import { route } from "@/lib/api/route";
import { MANAGER_ROLES } from "@/lib/auth/permissions";
import { DoorUpdate, getDoorDetail, updateDoor } from "@/lib/services/doors";

// GET /api/v1/doors/{id}: door, company, assignments, visits and the audit timeline. Viewers may read.
export const GET = route<{ id: string }>({ access: { roles: MANAGER_ROLES, viewerReads: true } }, async ({ params }) => getDoorDetail(params.id));

// PATCH /api/v1/doors/{id}: { priority?, qualificationNotes?, preferredVisitWindow? }.
export const PATCH = route<{ id: string }, typeof DoorUpdate>(
  { access: { roles: MANAGER_ROLES }, body: DoorUpdate, idempotent: true },
  async ({ user, params, body }) => updateDoor(user!.id, params.id, body),
);
