"use server";

import { revalidatePath } from "next/cache";
import { ApiError } from "@/lib/api/errors";
import { ADMIN_ROLES } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { updateUser } from "@/lib/services/users";

export async function setUserActiveAction(userId: string, active: boolean): Promise<{ error: string | null }> {
  const admin = await requireUser(ADMIN_ROLES);
  try {
    await updateUser(admin.id, userId, { active });
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  revalidatePath("/console/reps");
  return { error: null };
}
