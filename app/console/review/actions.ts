"use server";

import { revalidatePath } from "next/cache";
import { ApiError } from "@/lib/api/errors";
import { MANAGER_ROLES } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { google } from "@/lib/integrations/google";
import { resolveReview, type ReviewResolve } from "@/lib/services/review";

export type ResolveResult = { ok: true } | { ok: false; error: string; fields?: Record<string, string> };

export async function resolveAction(doorId: string, action: ReviewResolve): Promise<ResolveResult> {
  const user = await requireUser(MANAGER_ROLES);
  try {
    await resolveReview(user.id, doorId, action, google());
  } catch (error) {
    if (error instanceof ApiError) {
      const fields = Object.fromEntries((error.details ?? []).map((d) => [d.path.replace(/^address\./, ""), d.message]));
      return { ok: false, error: error.details?.[0]?.message ?? error.message, fields };
    }
    if (error instanceof Error && /GOOGLE_MAPS_API_KEY/.test(error.message)) {
      return { ok: false, error: "Address lookup is not set up yet (no Google Maps key). Ask an admin." };
    }
    throw error;
  }
  revalidatePath("/console", "layout");
  return { ok: true };
}
