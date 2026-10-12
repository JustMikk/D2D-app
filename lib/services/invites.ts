// Invites (PRD REP-1, backend spec §10.2): a manager invites a rep by email; the link sets a password.
// Only admins invite managers, admins and viewers. Links are valid for 7 days and used once.
import { z } from "zod";
import { audit, userActor } from "@/lib/api/audit";
import { conflict, forbidden, notFound, validationFailed } from "@/lib/api/errors";
import { canInvite } from "@/lib/auth/permissions";
import { hashPassword, PASSWORD_MESSAGES, passwordProblem } from "@/lib/auth/password";
import { randomToken, sha256Hex } from "@/lib/auth/tokens";
import { db } from "@/lib/db";
import { Role } from "@/lib/domain/enums";
import { isValidTimeZone } from "@/lib/domain/time";
import { parseEnv } from "@/lib/env";
import type { ResolutionDeps } from "@/lib/domain/addressResolution";
import { enqueue } from "@/lib/jobs";
import { getSetting } from "@/lib/settings";
import { geocodeBase } from "./reps";

export const INVITE_DAYS = 7;

const RepProfile = z.object({
  name: z.string().trim().min(1, "Required").max(100),
  timeZone: z.string().refine(isValidTimeZone, "Pick a valid time zone"),
  baseAddress: z.string().trim().min(5, "Enter the street address the rep starts from").max(300),
  dailyCapacity: z.number().int().min(1).max(100).optional(),
});

export const InviteCreate = z
  .object({
    email: z.email("Enter a valid email").transform((e) => e.toLowerCase()),
    role: Role,
    rep: RepProfile.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.role === "REP" && !v.rep) ctx.addIssue({ code: "custom", path: ["rep"], message: "Rep details are required" });
  });
export type InviteCreate = z.input<typeof InviteCreate>;

const InviteData = z.object({ rep: RepProfile.extend({ dailyCapacity: z.number().int(), baseLat: z.number().optional(), baseLng: z.number().optional() }).optional() });

export const InviteAccept = z.object({
  name: z.string().trim().min(1, "Required").max(100),
  password: z.string(),
});

export function inviteUrl(token: string): string {
  const { APP_BASE_URL } = parseEnv(["APP_BASE_URL"] as const);
  return new URL(`/invite/${token}`, APP_BASE_URL).toString();
}

/**
 * Create an invite. When `geocoder` is given, a rep's deployment base is located now, so the manager
 * sees a bad address immediately and the rep is assignable as soon as they accept.
 */
export async function createInvite(actorUserId: string, actorRole: Role, input: unknown, now = new Date(), geocoder?: Pick<ResolutionDeps, "geocode">) {
  const v = InviteCreate.parse(input);
  if (!canInvite(actorRole, v.role)) throw forbidden("Only admins can invite managers, admins and viewers.");

  const existing = await db().user.findUnique({ where: { email: v.email } });
  if (existing) throw conflict("Someone with this email already has an account.");

  const located = v.rep && geocoder ? await geocodeBase(v.rep.baseAddress, geocoder, "rep.baseAddress") : null;
  const data = v.rep
    ? { rep: { ...v.rep, dailyCapacity: v.rep.dailyCapacity ?? (await getSetting("rep.defaultDailyCapacity")), ...(located ? { baseLat: located.lat, baseLng: located.lng } : {}) } }
    : {};
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + INVITE_DAYS * 24 * 3600_000);

  const invite = await db().$transaction(async (tx) => {
    const created = await tx.invite.create({
      data: { email: v.email, role: v.role, tokenHash: sha256Hex(token), data: JSON.stringify(data), expiresAt, createdById: actorUserId },
    });
    await audit(tx, userActor(actorUserId), "invite.created", "INVITE", created.id, { email: v.email, role: v.role });
    return created;
  });

  return { id: invite.id, inviteUrl: inviteUrl(token), expiresAt: invite.expiresAt };
}

/** Public lookup for the invite page: never reveals more than the email and role. */
export async function getInvite(token: string, now = new Date()) {
  const invite = await db().invite.findUnique({ where: { tokenHash: sha256Hex(token) } });
  if (!invite) throw notFound("That invite");
  const valid = !invite.usedAt && invite.expiresAt.getTime() > now.getTime();
  const rep = InviteData.safeParse(JSON.parse(invite.data ?? "{}"));
  return { email: invite.email, role: Role.parse(invite.role), valid, suggestedName: rep.success ? (rep.data.rep?.name ?? null) : null };
}

/** Create the user (and rep) and mark the invite used. Returns the new user's email for sign-in. */
export async function acceptInvite(token: string, input: unknown, now = new Date()) {
  const v = InviteAccept.parse(input);
  const tokenHash = sha256Hex(token);
  const invite = await db().invite.findUnique({ where: { tokenHash } });
  if (!invite) throw notFound("That invite");
  if (invite.usedAt || invite.expiresAt.getTime() <= now.getTime()) {
    throw conflict("This invite link has expired or was already used. Ask your manager for a new one.");
  }
  const problem = passwordProblem(v.password, invite.email);
  if (problem) throw validationFailed([{ path: "password", message: PASSWORD_MESSAGES[problem] }]);

  const role = Role.parse(invite.role);
  const data = InviteData.parse(JSON.parse(invite.data ?? "{}"));
  if (role === "REP" && !data.rep) throw validationFailed([{ path: "rep", message: "This invite is missing the rep profile" }]);
  const passwordHash = await hashPassword(v.password);

  return db().$transaction(async (tx) => {
    // Claim the invite first so two simultaneous accepts cannot both succeed.
    const claimed = await tx.invite.updateMany({ where: { id: invite.id, usedAt: null }, data: { usedAt: now } });
    if (claimed.count !== 1) throw conflict("This invite link was already used.");
    if (await tx.user.findUnique({ where: { email: invite.email } })) throw conflict("Someone with this email already has an account.");

    const user = await tx.user.create({ data: { email: invite.email, name: v.name, role, passwordHash } });
    if (role === "REP" && data.rep) {
      await tx.rep.create({
        data: {
          userId: user.id,
          timeZone: data.rep.timeZone,
          baseAddress: data.rep.baseAddress,
          baseLat: data.rep.baseLat ?? null,
          baseLng: data.rep.baseLng ?? null,
          dailyCapacity: data.rep.dailyCapacity,
        },
      });
      // A new rep may be able to take doors that had nobody in range.
      await enqueue(tx, "unassignable.retry", {}, { dedupeKey: "unassignable-retry" });
    }
    await audit(tx, userActor(user.id), "invite.accepted", "INVITE", invite.id, { userId: user.id, role });
    return { userId: user.id, email: user.email, role };
  });
}

export async function listPendingInvites(now = new Date()) {
  return db().invite.findMany({
    where: { usedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
  });
}
