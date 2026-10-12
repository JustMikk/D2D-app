// Offline and sync indicator (design doc §8.7): a slim banner under the title.
//   amber  "Offline. 3 visits will sync when you're back online."
//   teal   "Syncing 3 visits"
//   red    "2 visits didn't sync. Tap to retry." (never auto-dismisses)
import { CloudOff, LoaderCircle, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

export type BannerTone = "offline" | "syncing" | "failed" | "auth";

const TONE: Record<BannerTone, { classes: string; Icon: typeof CloudOff }> = {
  offline: { classes: "bg-amber-bg text-amber-fg", Icon: CloudOff },
  syncing: { classes: "bg-teal-bg text-teal-fg", Icon: LoaderCircle },
  failed: { classes: "bg-red-bg text-red-fg", Icon: TriangleAlert },
  auth: { classes: "bg-red-bg text-red-fg", Icon: TriangleAlert },
};

export function OfflineBanner({ tone, children, onClick }: { tone: BannerTone; children: ReactNode; onClick?: () => void }) {
  const { classes, Icon } = TONE[tone];
  const body = (
    <>
      <Icon aria-hidden="true" size={18} className={tone === "syncing" ? "animate-spin" : undefined} />
      <span>{children}</span>
    </>
  );
  const common = `flex min-h-12 w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-body ${classes}`;
  return onClick ? (
    <button type="button" role="status" onClick={onClick} className={common}>
      {body}
    </button>
  ) : (
    <div role="status" className={common}>
      {body}
    </div>
  );
}
