import { redirect } from "next/navigation";
import { homePath } from "@/lib/auth/permissions";
import { getSessionUser } from "@/lib/auth/session";
import { LoginForm } from "./LoginForm";

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect(homePath(user.role));
  return (
    <>
      <h1 className="text-title-l">Sign in</h1>
      <LoginForm />
    </>
  );
}
