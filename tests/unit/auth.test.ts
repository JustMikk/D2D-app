import { describe, expect, it } from "vitest";
import { passwordProblem, hashPassword, verifyPassword } from "@/lib/auth/password";
import { canInvite, homePath, sessionDays } from "@/lib/auth/permissions";
import { randomToken, safeEqual, sha256Hex } from "@/lib/auth/tokens";
import { validateSession, type SessionUserRow } from "@/lib/auth/validateSession";
import { RateLimiter } from "@/lib/api/rateLimit";
import { ApiError, toApiError } from "@/lib/api/errors";
import { z } from "zod";

describe("password policy", () => {
  it("requires 10 characters, rejects common passwords and the email", () => {
    expect(passwordProblem("short")).toBe("too_short");
    expect(passwordProblem("Password123")).toBe("too_common");
    expect(passwordProblem("jordan@example.com", "Jordan@Example.com")).toBe("matches_email");
    expect(passwordProblem("bluebonnet-route-42")).toBeNull();
  });

  it("hashes with argon2id and verifies", async () => {
    const h = await hashPassword("bluebonnet-route-42");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(h, "bluebonnet-route-42")).toBe(true);
    expect(await verifyPassword(h, "wrong-password-1")).toBe(false);
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });
});

describe("tokens", () => {
  it("makes 32-byte base64url tokens and stable hashes", () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("permissions", () => {
  it("lets managers invite reps only; admins invite anyone", () => {
    expect(canInvite("MANAGER", "REP")).toBe(true);
    expect(canInvite("MANAGER", "MANAGER")).toBe(false);
    expect(canInvite("MANAGER", "VIEWER")).toBe(false);
    expect(canInvite("ADMIN", "ADMIN")).toBe(true);
    expect(canInvite("VIEWER", "REP")).toBe(false);
    expect(canInvite("REP", "REP")).toBe(false);
  });

  it("keeps reps signed in 30 days and others 7", () => {
    expect(sessionDays("REP")).toBe(30);
    expect(sessionDays("MANAGER")).toBe(7);
    expect(homePath("REP")).toBe("/today");
    expect(homePath("VIEWER")).toBe("/console");
  });
});

describe("validateSession", () => {
  const now = Date.UTC(2026, 9, 9);
  const row: SessionUserRow = {
    id: "u1",
    email: "a@example.com",
    name: "A",
    role: "MANAGER",
    active: true,
    tokenVersion: 2,
    monitoringAckAt: null,
    preferences: "{}",
    rep: null,
  };
  const claims = { userId: "u1", tokenVersion: 2, roleExpiresAt: now + 1000 };

  it("accepts a matching, unexpired session", () => {
    expect(validateSession(claims, row, now)).toMatchObject({ id: "u1", role: "MANAGER", repId: null });
  });

  it("rejects deactivated users, bumped token versions and expired role sessions", () => {
    expect(validateSession(claims, { ...row, active: false }, now)).toBeNull();
    expect(validateSession(claims, { ...row, tokenVersion: 3 }, now)).toBeNull();
    expect(validateSession({ ...claims, roleExpiresAt: now - 1 }, row, now)).toBeNull();
    expect(validateSession({ ...claims, roleExpiresAt: 0 }, row, now)).toBeNull();
    expect(validateSession(claims, null, now)).toBeNull();
    expect(validateSession({ ...claims, userId: "u2" }, row, now)).toBeNull();
  });
});

describe("RateLimiter", () => {
  it("allows the capacity, then refills over time", () => {
    let t = 0;
    const limiter = new RateLimiter(() => t);
    const limit = { capacity: 3, perMs: 60_000 };
    expect([1, 2, 3, 4].map(() => limiter.take("k", limit))).toEqual([true, true, true, false]);
    expect(limiter.take("other", limit)).toBe(true);
    t += 20_000; // one token back
    expect(limiter.take("k", limit)).toBe(true);
    expect(limiter.take("k", limit)).toBe(false);
  });
});

describe("error envelope", () => {
  it("maps ApiError, ZodError and unknown errors", () => {
    expect(new ApiError("NOT_FOUND", "Gone.").toJSON()).toEqual({ error: { code: "NOT_FOUND", message: "Gone." } });
    const zodErr = z.object({ a: z.string() }).safeParse({}).error!;
    expect(toApiError(zodErr)).toMatchObject({ code: "VALIDATION_FAILED", status: 400, details: [{ path: "a" }] });
    expect(toApiError(new Error("boom"))).toMatchObject({ code: "INTERNAL", status: 500 });
  });
});
