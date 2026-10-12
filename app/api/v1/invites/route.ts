import { json, route } from "@/lib/api/route";
import { MANAGER_ROLES } from "@/lib/auth/permissions";
import { google } from "@/lib/integrations/google";
import { createInvite, InviteCreate } from "@/lib/services/invites";

// POST /api/v1/invites: Manager+ (Admin for non-rep roles). Returns { inviteUrl, expiresAt }.
export const POST = route({ access: { roles: MANAGER_ROLES }, body: InviteCreate, idempotent: true }, async ({ body, user }) => {
  const invite = await createInvite(user!.id, user!.role, body, new Date(), { geocode: (q) => google().geocode(q) });
  return json({ inviteUrl: invite.inviteUrl, expiresAt: invite.expiresAt }, 201);
});
