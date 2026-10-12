"use client";
// Install guide (PRD REP-1): the right steps for the phone. iOS has no install prompt, and push only works
// once the app is on the home screen (iOS 16.4+), so the card explains both.
import { Share, SquarePlus, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useInstall } from "@/lib/rep/hooks";

export function InstallCard({ onDismiss }: { onDismiss: () => void }) {
  const { standalone, ios, canPrompt, install } = useInstall();
  if (standalone) return null;
  return (
    <section aria-label="Install Canvass" className="relative flex flex-col gap-3 rounded-md border-2 border-outline bg-surface p-4">
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="absolute right-1 top-1 grid size-12 place-items-center text-ink-2">
        <X aria-hidden="true" size={20} />
      </button>
      <h2 className="pr-10 text-title-s">Add Canvass to your home screen</h2>
      {ios ? (
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-body-l">
          <li>
            Tap <Share aria-hidden="true" size={18} className="inline align-text-bottom" /> Share at the bottom of Safari.
          </li>
          <li>
            Tap <SquarePlus aria-hidden="true" size={18} className="inline align-text-bottom" /> Add to Home Screen, then Add.
          </li>
          <li>Open Canvass from your home screen. Notifications only work from there.</li>
        </ol>
      ) : canPrompt ? (
        <>
          <p className="text-body-l">Install it for one-tap access and notifications.</p>
          <Button size="rep" block onClick={() => void install()}>
            Install app
          </Button>
        </>
      ) : (
        <p className="text-body-l">Open the browser menu and tap Install app (or Add to Home screen).</p>
      )}
    </section>
  );
}
