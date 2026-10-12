// Pure check of a session's claims against the stored user (backend spec §11). Kept apart from
// session.ts so it can be tested without Auth.js or a Next.js request.
import { Role } from "@/lib/domain/enums";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  repId: string | null;
  monitoringAckAt: Date | null;
  preferences: string;
};

export type SessionClaims = { userId: string; tokenVersion: number; roleExpiresAt: number };

export type SessionUserRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  tokenVersion: number;
  monitoringAckAt: Date | null;
  preferences: string;
  rep: { id: string } | null;
};

/** Valid while the user is active, the token version matches, and the role-based expiry has not passed. */
export function validateSession(claims: SessionClaims, user: SessionUserRow | null, now = Date.now()): SessionUser | null {
  if (!user || !user.active || user.id !== claims.userId) return null;
  if (user.tokenVersion !== claims.tokenVersion) return null;
  if (!claims.roleExpiresAt || now > claims.roleExpiresAt) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: Role.parse(user.role),
    repId: user.rep?.id ?? null,
    monitoringAckAt: user.monitoringAckAt,
    preferences: user.preferences,
  };
}
