// Bottom action bar (design doc §8.5): inverse fill, fixed, safe-area padded. The List/Map toggle on the left
// and the one primary action for the current state on the right.
import type { ReactNode } from "react";

export function BottomBar({ left, right }: { left?: ReactNode; right: ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-[var(--z-bar)] bg-surface-inverse text-ink-inverse pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto flex h-[var(--bar-height)] max-w-[var(--content-max-rep)] items-center justify-between gap-3 px-[var(--gutter-rep)]">
        <div>{left}</div>
        <div className="flex-1">{right}</div>
      </div>
    </div>
  );
}

export function SegmentedToggle<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-sm border-2 border-ink-inverse p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`h-12 min-w-16 rounded-xs px-3 text-label font-bold ${value === o.value ? "bg-surface text-ink" : "text-ink-inverse"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
