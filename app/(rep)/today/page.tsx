import { RepRoot } from "@/components/rep/RepRoot";
import { requireUser } from "@/lib/auth/session";

// The rep app (PRD §7.5). A single page: Today, the map and Settings all live inside it, so after the first
// load nothing needs the network to move between them. Only an opaque user ID is passed in.
export default async function TodayPage() {
  const user = await requireUser(["REP"]);
  return <RepRoot userId={user.id} />;
}
