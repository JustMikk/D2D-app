import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api/errors";
import { route } from "@/lib/api/route";
import { verifyMediaSignature } from "@/lib/integrations/mediaSigning";
import { ROLES } from "@/lib/domain/enums";
import { getSessionUser } from "@/lib/auth/session";
import { parseEnv } from "@/lib/env";
import { readMedia } from "@/lib/services/media";

// GET /api/v1/media/{id}: the uploader or a console user with a session, or a signed URL
// (?exp=&sig=) for n8n and CRM links. Served inline with the stored type only.
export const GET = route<{ id: string }>({ access: { public: true } }, async ({ req, params }) => {
  const { exp, sig } = Object.fromEntries(req.nextUrl.searchParams) as { exp?: string; sig?: string };
  let access: Parameters<typeof readMedia>[1];
  if (sig) {
    const { MEDIA_SIGNING_SECRET } = parseEnv(["MEDIA_SIGNING_SECRET"] as const);
    if (!verifyMediaSignature(MEDIA_SIGNING_SECRET, params.id, exp ?? null, sig)) throw new ApiError("FORBIDDEN", "This link has expired or is not valid.");
    access = { signed: true };
  } else {
    const user = await getSessionUser();
    if (!user || !ROLES.includes(user.role)) throw new ApiError("UNAUTHENTICATED", "Sign in to continue.");
    access = { userId: user.id, role: user.role };
  }
  const { bytes, mimeType } = await readMedia(params.id, access);
  return new NextResponse(new Uint8Array(bytes), {
    headers: { "content-type": mimeType, "content-disposition": "inline", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" },
  });
});
