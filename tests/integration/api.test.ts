// Route handlers called directly: the public invite routes, API-key auth and the error envelope.
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GET as getInviteRoute } from "@/app/api/v1/invites/[token]/route";
import { GET as healthRoute } from "@/app/api/v1/health/route";
import { route } from "@/lib/api/route";
import { sha256Hex } from "@/lib/auth/tokens";
import { db } from "@/lib/db";
import { createInvite } from "@/lib/services/invites";
import { createUser, REP_INVITE } from "./helpers";

const req = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`http://canvass.test${url}`, init);
const params = <P>(p: P) => ({ params: Promise.resolve(p) });

describe("public routes", () => {
  it("GET /invites/{token} returns only email, role and validity", async () => {
    const admin = await createUser("ADMIN");
    const invite = await createInvite(admin.id, "ADMIN", { email: "pub@example.com", ...REP_INVITE });
    const token = invite.inviteUrl.split("/invite/")[1]!;
    const res = await getInviteRoute(req(`/api/v1/invites/${token}`), params({ token }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "pub@example.com", role: "REP", valid: true });
  });

  it("returns the error envelope for an unknown token", async () => {
    const res = await getInviteRoute(req("/api/v1/invites/nope"), params({ token: "nope" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "That invite was not found." } });
  });

  it("GET /health reports the database", async () => {
    const res = await healthRoute(req("/api/v1/health"), params({}));
    expect(await res.json()).toMatchObject({ db: true, worker: { lastTickAt: null } });
  });
});

describe("API-key routes", () => {
  const echo = route({ access: { apiScope: "intake:write" }, body: z.object({ name: z.string() }) }, async ({ body, apiKey }) => ({
    name: body.name,
    key: apiKey?.name,
  }));

  async function makeKey(scopes: string, revoked = false) {
    const admin = await createUser("ADMIN");
    const raw = `cvs_${Math.random().toString(36).slice(2)}abcdef`;
    await db().apiKey.create({
      data: { name: "n8n", prefix: raw.slice(0, 8), keyHash: sha256Hex(raw), scopes, createdById: admin.id, revokedAt: revoked ? new Date() : null },
    });
    return raw;
  }

  const post = (key: string | null, body: unknown) =>
    echo(
      req("/api/v1/test", {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      params({}),
    );

  it("accepts a valid key with the scope and records last use", async () => {
    const key = await makeKey("intake:write");
    const res = await post(key, { name: "x" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "x", key: "n8n" });
    expect((await db().apiKey.findUniqueOrThrow({ where: { keyHash: sha256Hex(key) } })).lastUsedAt).not.toBeNull();
  });

  it("returns 401 for a missing or revoked key and 403 for a missing scope", async () => {
    expect((await post(null, { name: "x" })).status).toBe(401);
    expect((await post(await makeKey("intake:write", true), { name: "x" })).status).toBe(401);
    const res = await post(await makeKey("crm:write"), { name: "x" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });

  it("returns 400 with field details for an invalid body", async () => {
    const key = await makeKey("intake:write");
    const res = await post(key, { name: 3 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_FAILED", details: [{ path: "name" }] } });
    expect((await post(key, "{not json")).status).toBe(400);
  });
});
