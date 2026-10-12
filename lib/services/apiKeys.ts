// API keys (PRD MGR-7, backend spec §11): 32 random bytes, base64url, "cvs_" prefix. Only the SHA-256
// is stored; the full key is shown once.
import { z } from "zod";
import { audit, userActor } from "@/lib/api/audit";
import { conflict, notFound } from "@/lib/api/errors";
import { randomToken, sha256Hex } from "@/lib/auth/tokens";
import { db } from "@/lib/db";

export const API_SCOPES = ["intake:write", "crm:write"] as const;

export const ApiKeyCreate = z.object({
  name: z.string().trim().min(1, "Required").max(80),
  scopes: z.array(z.enum(API_SCOPES)).min(1, "Pick at least one scope"),
});

export async function listApiKeys() {
  const keys = await db().apiKey.findMany({ orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }], include: { createdBy: { select: { name: true } } } });
  return keys.map((k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes.split(",").filter(Boolean),
    lastUsedAt: k.lastUsedAt,
    revokedAt: k.revokedAt,
    createdAt: k.createdAt,
    createdBy: k.createdBy.name,
  }));
}

export async function createApiKey(actorUserId: string, input: unknown) {
  const { name, scopes } = ApiKeyCreate.parse(input);
  const key = `cvs_${randomToken()}`;
  const created = await db().$transaction(async (tx) => {
    const row = await tx.apiKey.create({
      data: { name, prefix: key.slice(0, 8), keyHash: sha256Hex(key), scopes: [...new Set(scopes)].join(","), createdById: actorUserId },
    });
    await audit(tx, userActor(actorUserId), "api_key.created", "API_KEY", row.id, { name, scopes });
    return row;
  });
  return { id: created.id, name, prefix: created.prefix, scopes, key };
}

export async function revokeApiKey(actorUserId: string, keyId: string, now = new Date()) {
  const key = await db().apiKey.findUnique({ where: { id: keyId } });
  if (!key) throw notFound("That API key");
  if (key.revokedAt) throw conflict("This key is already revoked.");
  await db().$transaction(async (tx) => {
    await tx.apiKey.update({ where: { id: keyId }, data: { revokedAt: now } });
    await audit(tx, userActor(actorUserId), "api_key.revoked", "API_KEY", keyId, { name: key.name });
  });
  return { id: keyId, revokedAt: now };
}
