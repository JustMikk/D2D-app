"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { acknowledgeMonitoring } from "@/lib/services/users";

export async function acknowledgeMonitoringAction() {
  const user = await requireUser(["REP"]);
  await acknowledgeMonitoring(user.id);
  revalidatePath("/", "layout");
}
