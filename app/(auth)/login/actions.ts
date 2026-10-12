"use server";

import { AuthError, CredentialsSignin } from "next-auth";
import { signIn } from "@/auth";

export type LoginState = { error: string | null; email: string };

const MESSAGES: Record<string, string> = {
  locked: "Too many wrong passwords. Wait 15 minutes, then try again.",
  rate_limited: "Too many attempts from this device. Wait a minute, then try again.",
};

export async function loginAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "");
  try {
    // On success this throws Next's redirect, which must propagate.
    await signIn("credentials", { email, password: String(form.get("password") ?? ""), redirectTo: "/" });
    return { error: null, email };
  } catch (error) {
    if (error instanceof CredentialsSignin) {
      return { error: MESSAGES[error.code] ?? "That email and password don't match. Check them and try again.", email };
    }
    if (error instanceof AuthError) return { error: "Sign-in is unavailable right now. Try again in a minute.", email };
    throw error;
  }
}
