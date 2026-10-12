"use server";

import { revalidatePath } from "next/cache";
import { ApiError } from "@/lib/api/errors";
import { MANAGER_ROLES } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { closeDoor, updateDoor } from "@/lib/services/doors";

export async function setPriorityAction(doorId: string, priority: "NORMAL" | "HOT"): Promise<{ error: string | null }> {
  const user = await requireUser(MANAGER_ROLES);
  try {
    await updateDoor(user.id, doorId, { priority });
  } catch (e) {
    if (e instanceof ApiError) return { error: e.message };
    throw e;
  }
  revalidatePath("/console/doors");
  return { error: null };
}

export async function closeDoorAction(doorId: string, note: string): Promise<{ error: string | null }> {
  const user = await requireUser(MANAGER_ROLES);
  try {
    await closeDoor(user.id, doorId, { reason: "MANUAL", note: note || undefined });
  } catch (e) {
    if (e instanceof ApiError) return { error: e.message };
    throw e;
  }
  revalidatePath("/console", "layout");
  return { error: null };
}
