// Credential check for sign-in (backend spec §11): argon2id, a login rate limit per IP, and a lockout
// after 10 failures in 15 minutes per account. Failures are audit-logged, which also makes the
// lockout survive restarts.
import { audit, SYSTEM, userActor } from "@/lib/api/audit";
import { LIMITS, rateLimiter } from "@/lib/api/rateLimit";
import { burnPasswordCheck, verifyPassword } from "@/lib/auth/password";
import { db } from "@/lib/db";
import { Role } from "@/lib/domain/enums";

export const LOCKOUT_FAILURES = 10;
export const LOCKOUT_WINDOW_MS = 15 * 60_000;

export type CredentialUser = { id: string; email: string; name: string; role: Role; tokenVersion: number };

export type CredentialResult =
  | { kind: "ok"; user: CredentialUser }
  | { kind: "invalid" }
  | { kind: "locked" }
  | { kind: "rate_limited" };

export async function verifyCredentials(emailInput: string, password: string, ip: string, now = new Date()): Promise<CredentialResult> {
  if (!rateLimiter.take(`login:${ip}`, LIMITS.login)) return { kind: "rate_limited" };

  const email = emailInput.trim().toLowerCase();
  const user = email ? await db().user.findUnique({ where: { email } }) : null;
  if (!user || !user.active || !user.passwordHash) {
    await burnPasswordCheck(password);
    return { kind: "invalid" };
  }

  const recentFailures = await db().auditLog.count({
    where: { action: "auth.login_failed", entityType: "USER", entityId: user.id, createdAt: { gt: new Date(now.getTime() - LOCKOUT_WINDOW_MS) } },
  });
  if (recentFailures >= LOCKOUT_FAILURES) {
    await burnPasswordCheck(password);
    return { kind: "locked" };
  }

  if (!(await verifyPassword(user.passwordHash, password))) {
    await audit(db(), SYSTEM, "auth.login_failed", "USER", user.id, { ip });
    return { kind: "invalid" };
  }

  await db().user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
  await audit(db(), userActor(user.id), "auth.login", "USER", user.id, { ip });
  return {
    kind: "ok",
    user: { id: user.id, email: user.email, name: user.name, role: Role.parse(user.role), tokenVersion: user.tokenVersion },
  };
}
