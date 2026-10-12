import { redirect } from "next/navigation";
import { homePath } from "@/lib/auth/permissions";
import { getSessionUser } from "@/lib/auth/session";

// Send each role to its home: reps to Today, everyone else to the console.
export default async function Home() {
  const user = await getSessionUser();
  redirect(user ? homePath(user.role) : "/login");
}
