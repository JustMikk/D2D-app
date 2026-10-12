// Role capabilities (PRD §4).
import type { Role } from "@/lib/domain/enums";

export const CONSOLE_ROLES: readonly Role[] = ["ADMIN", "MANAGER", "VIEWER"];
export const MANAGER_ROLES: readonly Role[] = ["ADMIN", "MANAGER"];
export const ADMIN_ROLES: readonly Role[] = ["ADMIN"];
export const REP_ROLES: readonly Role[] = ["REP"];

export function canViewConsole(role: Role): boolean {
  return CONSOLE_ROLES.includes(role);
}

export function canManage(role: Role): boolean {
  return MANAGER_ROLES.includes(role);
}

export function isAdmin(role: Role): boolean {
  return role === "ADMIN";
}

/** Managers invite reps; only admins invite managers, admins and viewers. */
export function canInvite(actor: Role, invitee: Role): boolean {
  if (actor === "ADMIN") return true;
  return actor === "MANAGER" && invitee === "REP";
}

/** Session length per role (backend spec §11): reps 30 days, everyone else 7. */
export function sessionDays(role: Role): number {
  return role === "REP" ? 30 : 7;
}

/** Where each role lands after signing in. */
export function homePath(role: Role): string {
  return role === "REP" ? "/today" : "/console";
}
