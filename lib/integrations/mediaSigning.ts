// Signed media URLs (backend spec §9.5): GET /api/v1/media/{id}?exp={unix}&sig={HMAC(secret, "id.exp")},
// valid for 7 days, so n8n and CRM links can open photos without a session.
import { createHmac } from "node:crypto";
import { safeEqual } from "@/lib/auth/tokens";

export const MEDIA_URL_TTL_S = 7 * 24 * 3600;

function sign(secret: string, mediaId: string, exp: number): string {
  return createHmac("sha256", secret).update(`${mediaId}.${exp}`).digest("base64url");
}

export function signedMediaUrl(baseUrl: string, secret: string, mediaId: string, now = new Date()): string {
  const exp = Math.floor(now.getTime() / 1000) + MEDIA_URL_TTL_S;
  const url = new URL(`/api/v1/media/${mediaId}`, baseUrl);
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", sign(secret, mediaId, exp));
  return url.toString();
}

export function verifyMediaSignature(secret: string, mediaId: string, exp: string | null, sig: string | null, now = new Date()): boolean {
  const e = Number(exp);
  if (!sig || !Number.isInteger(e) || e < now.getTime() / 1000) return false;
  return safeEqual(sign(secret, mediaId, e), sig);
}
