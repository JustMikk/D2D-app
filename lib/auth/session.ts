// The signed-in user for the current request. The JWT alone is not trusted: validateSession checks it
// against the database (active, token version, role-based expiry) on every request.
import { cache } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import type { Role } from "@/lib/domain/enums";
import { homePath } from "./permissions";
import { validateSession, type SessionUser } from "./validateSession";

export type { SessionUser } from "./validateSession";

export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const session = await auth();
  const userId = session?.user?.id;
  if (!session || !userId) return null;
  const user = await db().user.findUnique({ where: { id: userId }, include: { rep: { select: { id: true } } } });
  return validateSession({ userId, tokenVersion: session.tokenVersion, roleExpiresAt: session.roleExpiresAt }, user);
});

/** For pages and server actions: redirect to sign-in, or to the user's home when the role does not fit. */
export async function requireUser(roles?: readonly Role[]): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (roles && !roles.includes(user.role)) redirect(homePath(user.role));
  return user;
}
