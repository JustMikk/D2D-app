import { route } from "@/lib/api/route";
import { getInvite } from "@/lib/services/invites";

// GET /api/v1/invites/{token}: public. { email, role, valid }.
export const GET = route<{ token: string }>({ access: { public: true } }, async ({ params }) => {
  const { email, role, valid } = await getInvite(params.token);
  return { email, role, valid };
});
