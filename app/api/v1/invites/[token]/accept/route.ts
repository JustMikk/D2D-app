import { signIn } from "@/auth";
import { json, route } from "@/lib/api/route";
import { LIMITS } from "@/lib/api/rateLimit";
import { acceptInvite, InviteAccept } from "@/lib/services/invites";

// POST /api/v1/invites/{token}/accept: public. Creates the user (and rep), then signs in.
export const POST = route<{ token: string }, typeof InviteAccept>(
  { access: { public: true }, body: InviteAccept, limit: LIMITS.login },
  async ({ params, body }) => {
    const user = await acceptInvite(params.token, body);
    await signIn("credentials", { email: user.email, password: body.password, redirect: false });
    return json({ userId: user.userId, role: user.role }, 201);
  },
);
