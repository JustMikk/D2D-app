"use client";
// Rep settings (PRD REP-12): theme, maps app, notifications, install, sign out.
import { ChevronLeft } from "lucide-react";
import { signOutAction } from "@/app/actions";
import { Button } from "@/components/ui/Button";
import { SegmentedToggle } from "@/components/ui/BottomBar";
import { ThemeSwitcher } from "@/components/ui/ThemeSwitcher";
import { useToast } from "@/components/ui/Toast";
import type { MapsApp } from "@/lib/rep/helpers";
import { type PushStatus } from "@/lib/rep/hooks";
import { outbox } from "@/lib/rep/outbox";
import type { Preferences } from "@/lib/services/users";
import { InstallCard } from "./InstallCard";

const PUSH_TEXT: Record<PushStatus, string> = {
  unsupported: "Not available here. On iPhone, add Canvass to your home screen first. The app checks for new doors every minute while it's open.",
  denied: "Turned off in your phone's settings. Turn it on there, then come back.",
  off: "Off. Turn on to hear about new hot doors and route changes.",
  on: "On. You'll hear about new hot doors and route changes.",
};

export function SettingsView({
  prefs,
  mapsApp,
  onMapsApp,
  push,
  pending,
  online,
  onBack,
}: {
  prefs: Preferences;
  mapsApp: MapsApp;
  onMapsApp: (app: MapsApp) => void;
  push: { status: PushStatus; enable: () => Promise<boolean>; disable: () => Promise<void> };
  pending: number;
  online: boolean;
  onBack: () => void;
}) {
  const toast = useToast();

  async function signOut() {
    if (pending > 0) return toast.show(`${pending} ${pending === 1 ? "item hasn't" : "items haven't"} synced yet. Stay connected until they do, then sign out.`);
    // Pings and analytics belong to the person leaving: they must not be sent as the next person to sign in.
    await outbox().discardKinds(["ping", "event"]);
    await outbox().clearCache();
    navigator.serviceWorker?.controller?.postMessage({ type: "CLEAR" });
    await signOutAction();
  }

  return (
    <section className="flex flex-col gap-8 pb-[calc(var(--bar-height)+env(safe-area-inset-bottom)+24px)] pt-6">
      <header className="flex items-center gap-2">
        <button type="button" onClick={onBack} aria-label="Back to Today" className="-ml-3 grid size-12 place-items-center rounded-sm text-ink-2">
          <ChevronLeft aria-hidden="true" size={24} />
        </button>
        <h1 className="text-title-l">Settings</h1>
      </header>

      <div className="flex flex-col gap-3">
        <h2 className="text-title-s">Theme</h2>
        <ThemeSwitcher initial={prefs.theme ?? "auto"} size="rep" />
        <p className="text-caption text-ink-2">Automatic switches to dusk after sunset where you&apos;re working. Dusk is easier on the eyes when you&apos;re knocking in the evening.</p>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-title-s">Maps app</h2>
        <div className="self-start rounded-sm bg-surface-inverse p-0.5">
          <SegmentedToggle
            label="Maps app"
            value={mapsApp}
            options={[
              { value: "apple", label: "Apple Maps" },
              { value: "google", label: "Google Maps" },
            ]}
            onChange={onMapsApp}
          />
        </div>
        <p className="text-caption text-ink-2">&ldquo;Navigate&rdquo; opens this app.</p>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-title-s">Notifications</h2>
        <p className="text-body-l">{PUSH_TEXT[push.status]}</p>
        {push.status === "off" && (
          <Button size="rep" variant="secondary" onClick={() => void push.enable().then((ok) => toast.show(ok ? "Notifications on" : "Notifications weren't turned on"))}>
            Turn on notifications
          </Button>
        )}
        {push.status === "on" && (
          <Button size="rep" variant="secondary" onClick={() => void push.disable().then(() => toast.show("Notifications off"))}>
            Turn off notifications
          </Button>
        )}
      </div>

      <InstallCard onDismiss={() => undefined} />

      <Button size="rep" variant="secondary" block onClick={() => void signOut()} disabled={!online && pending === 0}>
        Sign out
      </Button>
    </section>
  );
}
