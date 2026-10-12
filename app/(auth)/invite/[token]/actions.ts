"use server";

import { signIn } from "@/auth";
import { ApiError } from "@/lib/api/errors";
import { homePath } from "@/lib/auth/permissions";
import { acceptInvite } from "@/lib/services/invites";

export type AcceptState = { error: string | null; fieldErrors: Record<string, string>; name: string };

export async function acceptInviteAction(token: string, _prev: AcceptState, form: FormData): Promise<AcceptState> {
  const name = String(form.get("name") ?? "");
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? "")) {
    return { error: null, fieldErrors: { confirm: "The passwords don't match." }, name };
  }
  let accepted;
  try {
    accepted = await acceptInvite(token, { name, password });
  } catch (error) {
    if (error instanceof ApiError) {
      const fieldErrors = Object.fromEntries((error.details ?? []).map((d) => [d.path, d.message]));
      return { error: error.details ? null : error.message, fieldErrors, name };
    }
    throw error;
  }
  // On success this throws Next's redirect to the new user's home.
  await signIn("credentials", { email: accepted.email, password, redirectTo: homePath(accepted.role) });
  return { error: null, fieldErrors: {}, name };
}
