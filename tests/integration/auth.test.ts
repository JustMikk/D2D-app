import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { LOCKOUT_FAILURES, verifyCredentials } from "@/lib/services/auth";
import { createUser, ip, PASSWORD } from "./helpers";

describe("verifyCredentials", () => {
  it("signs in with the right password, case-insensitive email", async () => {
    const user = await createUser("MANAGER", { email: "pat@example.com" });
    const r = await verifyCredentials("  PAT@example.com ", PASSWORD, ip());
    expect(r).toEqual({ kind: "ok", user: { id: user.id, email: "pat@example.com", name: "MANAGER user", role: "MANAGER", tokenVersion: 0 } });
    expect((await db().user.findUniqueOrThrow({ where: { id: user.id } })).lastLoginAt).not.toBeNull();
    expect(await db().auditLog.count({ where: { action: "auth.login", entityId: user.id } })).toBe(1);
  });

  it("rejects a wrong password, an unknown email and a deactivated user", async () => {
    const user = await createUser("REP");
    await createUser("REP", { email: "gone@example.com", active: false });
    expect(await verifyCredentials(user.email, "wrong-password-1", ip())).toEqual({ kind: "invalid" });
    expect(await verifyCredentials("nobody@example.com", PASSWORD, ip())).toEqual({ kind: "invalid" });
    expect(await verifyCredentials("gone@example.com", PASSWORD, ip())).toEqual({ kind: "invalid" });
    expect(await db().auditLog.count({ where: { action: "auth.login_failed", entityId: user.id } })).toBe(1);
  });

  it(`locks the account after ${LOCKOUT_FAILURES} failures in 15 minutes, even with the right password`, async () => {
    const user = await createUser("MANAGER");
    for (let i = 0; i < LOCKOUT_FAILURES; i++) expect((await verifyCredentials(user.email, `wrong-password-${i}`, ip())).kind).toBe("invalid");
    expect(await verifyCredentials(user.email, PASSWORD, ip())).toEqual({ kind: "locked" });
    // 16 minutes later the window has passed.
    expect((await verifyCredentials(user.email, PASSWORD, ip(), new Date(Date.now() + 16 * 60_000))).kind).toBe("ok");
  });

  it("rate-limits sign-in attempts per IP", async () => {
    const user = await createUser("REP");
    const sameIp = ip();
    const kinds = [];
    for (let i = 0; i < 11; i++) kinds.push((await verifyCredentials(user.email, `wrong-${i}-password`, sameIp)).kind);
    expect(kinds.slice(0, 10).every((k) => k === "invalid")).toBe(true);
    expect(kinds[10]).toBe("rate_limited");
  });
});
