import { CONSOLE_ROLES } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { getLiveMap } from "@/lib/services/mapLive";
import { LiveMap } from "./LiveMap";

// The console home (PRD §6.3, MGR-1): where the reps are, and today's doors by status.
export default async function MapPage() {
  await requireUser(CONSOLE_ROLES);
  const initial = await getLiveMap({});
  // "Today" for the date picker: the day the server is in (each rep's own day is used when no date is chosen).
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-title-l">Map</h1>
      <LiveMap initial={JSON.parse(JSON.stringify(initial))} defaultDate={initial.reps[0]?.date ?? initial.generatedAt.slice(0, 10)} />
    </div>
  );
}
