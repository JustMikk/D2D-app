import { json, route } from "@/lib/api/route";
import { MANAGER_ROLES } from "@/lib/auth/permissions";
import { addUnavailability, UnavailabilityCreate } from "@/lib/services/reps";

// POST /api/v1/reps/{id}/unavailability: { dates, reason? }. Open assignments on those dates are reassigned.
export const POST = route<{ id: string }, typeof UnavailabilityCreate>(
  { access: { roles: MANAGER_ROLES }, body: UnavailabilityCreate, idempotent: true },
  async ({ user, params, body }) => json(await addUnavailability(user!.id, params.id, body), 201),
);
