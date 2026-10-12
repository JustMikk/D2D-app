import { route } from "@/lib/api/route";
import { REP_ROLES } from "@/lib/auth/permissions";
import { EventsBody, recordEvents } from "@/lib/services/repActions";

// POST /api/v1/rep/events: { events } (at most 50). Analytics only the phone knows; each is recorded once.
export const POST = route({ access: { roles: REP_ROLES }, body: EventsBody }, async ({ user, body }) => recordEvents(user!.id, body));
