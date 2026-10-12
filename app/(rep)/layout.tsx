import { requireUser } from "@/lib/auth/session";
import { MonitoringNotice } from "./MonitoringNotice";

// Rep PWA shell (role REP). Reps acknowledge the location monitoring notice before anything else
// (PRD §9, privacy).
export default async function RepLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser(["REP"]);
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[var(--content-max-rep)] flex-col px-[var(--gutter-rep)]">
      {user.monitoringAckAt ? children : <MonitoringNotice />}
    </div>
  );
}
