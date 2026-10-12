// The door-hanger card (design doc §8.1): the current stop, drawn as a card with a tab and a punched hole.
// The only decorative element in the product. A hot door gets an Interstate-blue tab.
import type { ReactNode } from "react";

export function HangerCard({
  stopNumber,
  hot,
  swinging,
  rising,
  ghost,
  children,
  ...rest
}: {
  stopNumber: number | null;
  hot?: boolean;
  swinging?: boolean;
  rising?: boolean;
  /** The card that is leaving after a saved visit: decoration only, hidden from assistive tech. */
  ghost?: boolean;
  children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, "children">) {
  return (
    <article
      className={`hanger ${hot ? "hanger--hot" : ""} ${swinging ? "hanger--swing" : ""} ${rising ? "hanger--rise" : ""}`}
      aria-hidden={ghost ? true : undefined}
      {...rest}
    >
      <div className="hanger__tab">
        {/* Below the hole: the 64px tab cannot fit display-size type under it. */}
        <p className="tnum absolute inset-x-0 bottom-0 text-center text-title-l">{stopNumber === null ? "Stop" : `Stop ${stopNumber}`}</p>
      </div>
      <div className="hanger__ring" aria-hidden="true" />
      <div className="flex flex-col gap-3 p-4">{children}</div>
    </article>
  );
}
