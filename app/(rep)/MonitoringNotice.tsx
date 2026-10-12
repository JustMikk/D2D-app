import { MapPin } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { getSettings } from "@/lib/settings";
import { acknowledgeMonitoringAction } from "./actions";

// Written monitoring notice shown at first sign-in (PRD §9, privacy; REP-8).
export async function MonitoringNotice() {
  const settings = await getSettings();
  const pingMinutes = Math.round(settings["location.foregroundPingSeconds"] / 60);
  const retentionDays = settings["location.retentionDays"];
  return (
    <section className="flex flex-1 flex-col gap-6 py-10">
      <MapPin aria-hidden="true" size={32} className="text-link" />
      <h1 className="text-title-l">How Canvass uses your location</h1>
      <div className="flex flex-col gap-4 text-body-l text-ink-2">
        <p>Canvass records your location only while your day is on, between &quot;Start day&quot; and &quot;End day&quot;.</p>
        <p>
          It takes a fix when you start and end the day, when you arrive at a stop and when you log a visit. While the app is open
          during your day, it also sends one every {pingMinutes} {pingMinutes === 1 ? "minute" : "minutes"}. Nothing is collected when your day is off.
        </p>
        <p>Your manager and admins can see these locations. They are deleted after {retentionDays} days.</p>
      </div>
      <form action={acknowledgeMonitoringAction} className="mt-auto pb-[calc(env(safe-area-inset-bottom)+16px)]">
        <Button type="submit" size="rep" block>
          I understand
        </Button>
      </form>
    </section>
  );
}
