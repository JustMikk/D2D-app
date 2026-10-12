import { randomUUID } from "node:crypto";
import { hashPassword } from "@/lib/auth/password";
import { db } from "@/lib/db";
import type { Role } from "@/lib/domain/enums";

export const PASSWORD = "correct-horse-battery";

export async function createUser(role: Role, over: { email?: string; active?: boolean; password?: string } = {}) {
  const email = over.email ?? `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`;
  const user = await db().user.create({
    data: { email, name: `${role} user`, role, active: over.active ?? true, passwordHash: await hashPassword(over.password ?? PASSWORD) },
  });
  if (role === "REP") await db().rep.create({ data: { userId: user.id, timeZone: "America/Chicago", baseAddress: "1 Main St, Dallas, TX 75201" } });
  return user;
}

/** A REP user whose rep profile is located and configured, ready for the assignment engine. */
export async function createRep(
  name: string,
  timeZone: string,
  base: { lat: number; lng: number },
  over: { dailyCapacity?: number; workdays?: string; dayStartLocal?: string } = {},
) {
  const slug = name.toLowerCase().replace(/\W+/g, "-");
  const user = await createUser("REP", { email: `${slug}-${randomUUID().slice(0, 6)}@example.com` });
  await db().user.update({ where: { id: user.id }, data: { name } });
  const rep = await db().rep.update({ where: { userId: user.id }, data: { timeZone, baseLat: base.lat, baseLng: base.lng, ...over } });
  return { user, rep };
}

/** A unique client IP per call, so login rate limits never leak between tests. */
export function ip() {
  return `10.0.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

export const REP_INVITE = {
  role: "REP",
  rep: { name: "Jordan Rivera", timeZone: "America/Chicago", baseAddress: "6101 Preston Rd, Plano, TX 75093" },
} as const;
