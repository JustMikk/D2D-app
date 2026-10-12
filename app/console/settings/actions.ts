"use server";

import { revalidatePath } from "next/cache";
import { userActor } from "@/lib/api/audit";
import { ApiError } from "@/lib/api/errors";
import { ADMIN_ROLES } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { createApiKey, revokeApiKey } from "@/lib/services/apiKeys";
import { retryJob, retryOutboxEvent } from "@/lib/services/ops";
import { updateSettings } from "@/lib/settings";

export type CreateKeyResult = { ok: true; key: string; name: string } | { ok: false; error: string };

export async function createApiKeyAction(name: string, scopes: string[]): Promise<CreateKeyResult> {
  const admin = await requireUser(ADMIN_ROLES);
  try {
    const created = await createApiKey(admin.id, { name, scopes });
    revalidatePath("/console/settings");
    return { ok: true, key: created.key, name: created.name };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e.message };
    if (e instanceof Error && "issues" in e) return { ok: false, error: "Give the key a name and pick at least one scope." };
    throw e;
  }
}

export async function revokeApiKeyAction(id: string): Promise<{ error: string | null }> {
  const admin = await requireUser(ADMIN_ROLES);
  try {
    await revokeApiKey(admin.id, id);
  } catch (e) {
    if (e instanceof ApiError) return { error: e.message };
    throw e;
  }
  revalidatePath("/console/settings");
  return { error: null };
}

export type SaveSettingsResult = { ok: true } | { ok: false; error: string; fields: Record<string, string> };

/** Save only the changed settings. A bad value rejects the whole save and names the field. */
export async function saveSettingsAction(patch: Record<string, unknown>): Promise<SaveSettingsResult> {
  const admin = await requireUser(ADMIN_ROLES);
  try {
    await updateSettings(userActor(admin.id), patch);
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e.details?.length ? "Some settings need attention." : e.message, fields: Object.fromEntries((e.details ?? []).map((d) => [d.path, d.message])) };
    throw e;
  }
  revalidatePath("/console/settings");
  return { ok: true };
}

export async function retryJobAction(id: string): Promise<{ error: string | null }> {
  const admin = await requireUser(ADMIN_ROLES);
  try {
    await retryJob(admin.id, id);
  } catch (e) {
    if (e instanceof ApiError) return { error: e.message };
    throw e;
  }
  revalidatePath("/console/settings");
  return { error: null };
}

export async function retryEventAction(id: string): Promise<{ error: string | null }> {
  const admin = await requireUser(ADMIN_ROLES);
  try {
    await retryOutboxEvent(admin.id, id);
  } catch (e) {
    if (e instanceof ApiError) return { error: e.message };
    throw e;
  }
  revalidatePath("/console/settings");
  return { error: null };
}
