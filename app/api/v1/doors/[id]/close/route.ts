import { route } from "@/lib/api/route";
import { MANAGER_ROLES } from "@/lib/auth/permissions";
import { closeDoor, DoorClose } from "@/lib/services/doors";

// POST /api/v1/doors/{id}/close: { reason: "NO_VISIT" | "MANUAL", note? }.
export const POST = route<{ id: string }, typeof DoorClose>(
  { access: { roles: MANAGER_ROLES }, body: DoorClose, idempotent: true },
  async ({ user, params, body }) => closeDoor(user!.id, params.id, body),
);
