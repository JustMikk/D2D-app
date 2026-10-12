import { describe, expect, it } from "vitest";
import { verifyPassword } from "@/lib/auth/password";
import { db } from "@/lib/db";
import { acceptInvite, createInvite, getInvite, listPendingInvites } from "@/lib/services/invites";
import { createUser, REP_INVITE } from "./helpers";

const tokenOf = (url: string) => url.split("/invite/")[1]!;

describe("invites", () => {
  it("a manager invites a rep; the rep accepts and gets a user and rep profile", async () => {
    const manager = await createUser("MANAGER");
    const invite = await createInvite(manager.id, "MANAGER", { email: "Jordan@Example.com", ...REP_INVITE });
    expect(invite.inviteUrl).toMatch(/^http:\/\/canvass\.test\/invite\/[A-Za-z0-9_-]{43}$/);
    expect(invite.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 3600_000);

    const token = tokenOf(invite.inviteUrl);
    expect(await getInvite(token)).toEqual({ email: "jordan@example.com", role: "REP", valid: true, suggestedName: "Jordan Rivera" });
    expect(await listPendingInvites()).toHaveLength(1);

    // Only the hash of the token is stored.
    const stored = await db().invite.findFirstOrThrow({ where: { email: "jordan@example.com" } });
    expect(stored.tokenHash).not.toContain(token);

    const accepted = await acceptInvite(token, { name: "Jordan R.", password: "bluebonnet-route-42" });
    expect(accepted).toMatchObject({ email: "jordan@example.com", role: "REP" });

    const user = await db().user.findUniqueOrThrow({ where: { email: "jordan@example.com" }, include: { rep: true } });
    expect(user.name).toBe("Jordan R.");
    expect(await verifyPassword(user.passwordHash!, "bluebonnet-route-42")).toBe(true);
    expect(user.rep).toMatchObject({ timeZone: "America/Chicago", baseAddress: "6101 Preston Rd, Plano, TX 75093", dailyCapacity: 20 });

    expect((await getInvite(token)).valid).toBe(false);
    expect(await listPendingInvites()).toHaveLength(0);
    const actions = (await db().auditLog.findMany({ where: { entityId: stored.id }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["invite.created", "invite.accepted"]);
  });

  it("uses the default capacity setting unless one is given", async () => {
    const manager = await createUser("MANAGER");
    const invite = await createInvite(manager.id, "MANAGER", { email: "cap@example.com", ...REP_INVITE, rep: { ...REP_INVITE.rep, dailyCapacity: 12 } });
    await acceptInvite(tokenOf(invite.inviteUrl), { name: "Cap", password: "bluebonnet-route-42" });
    const rep = await db().rep.findFirstOrThrow({ where: { user: { email: "cap@example.com" } } });
    expect(rep.dailyCapacity).toBe(12);
  });

  it("only admins invite non-rep roles", async () => {
    const manager = await createUser("MANAGER");
    const admin = await createUser("ADMIN");
    await expect(createInvite(manager.id, "MANAGER", { email: "m2@example.com", role: "MANAGER" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createInvite(admin.id, "ADMIN", { email: "m2@example.com", role: "MANAGER" })).resolves.toHaveProperty("inviteUrl");
  });

  it("validates the payload", async () => {
    const admin = await createUser("ADMIN");
    await expect(createInvite(admin.id, "ADMIN", { email: "x@example.com", role: "REP" })).rejects.toMatchObject({ issues: [{ path: ["rep"] }] });
    await expect(
      createInvite(admin.id, "ADMIN", { email: "x@example.com", role: "REP", rep: { ...REP_INVITE.rep, timeZone: "Mars/Base" } }),
    ).rejects.toMatchObject({ issues: [{ path: ["rep", "timeZone"] }] });
    await expect(createInvite(admin.id, "ADMIN", { email: "not-an-email", role: "VIEWER" })).rejects.toThrow();
  });

  it("refuses to invite an email that already has an account", async () => {
    const admin = await createUser("ADMIN");
    await createUser("REP", { email: "taken@example.com" });
    await expect(createInvite(admin.id, "ADMIN", { email: "TAKEN@example.com", ...REP_INVITE })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects weak passwords, reused links and expired links", async () => {
    const admin = await createUser("ADMIN");
    const invite = await createInvite(admin.id, "ADMIN", { email: "v@example.com", role: "VIEWER" });
    const token = tokenOf(invite.inviteUrl);

    await expect(acceptInvite(token, { name: "V", password: "short" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: [{ path: "password" }],
    });
    await expect(acceptInvite(token, { name: "V", password: "v@example.com" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await acceptInvite(token, { name: "V", password: "bluebonnet-route-42" });
    await expect(acceptInvite(token, { name: "V", password: "bluebonnet-route-42" })).rejects.toMatchObject({ code: "CONFLICT" });

    const old = await createInvite(admin.id, "ADMIN", { email: "late@example.com", role: "VIEWER" }, new Date(Date.now() - 8 * 24 * 3600_000));
    expect((await getInvite(tokenOf(old.inviteUrl))).valid).toBe(false);
    await expect(acceptInvite(tokenOf(old.inviteUrl), { name: "L", password: "bluebonnet-route-42" })).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(getInvite("no-such-token")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lets only one of two simultaneous accepts succeed", async () => {
    const admin = await createUser("ADMIN");
    const invite = await createInvite(admin.id, "ADMIN", { email: "race@example.com", ...REP_INVITE });
    const token = tokenOf(invite.inviteUrl);
    const results = await Promise.allSettled([
      acceptInvite(token, { name: "One", password: "bluebonnet-route-42" }),
      acceptInvite(token, { name: "Two", password: "bluebonnet-route-42" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db().user.count({ where: { email: "race@example.com" } })).toBe(1);
  });
});
