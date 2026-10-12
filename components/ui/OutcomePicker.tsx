"use client";
// Outcome picker (design doc §8.3): a 2-column grid of six large toggle tiles, 56px tall. The selected tile
// takes its tone's fill with a 2px border in the tone's text color.
import { OUTCOMES, type Outcome } from "@/lib/domain/enums";
import { TONE_CLASSES, VISIT_OUTCOME } from "@/lib/ui/status";
import { StatusIcon } from "./Icon";

export function OutcomePicker({ value, onChange, error }: { value: Outcome | null; onChange: (o: Outcome) => void; error?: string | null }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-label">Outcome</legend>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Outcome">
        {OUTCOMES.map((o) => {
          const meta = VISIT_OUTCOME[o];
          const selected = value === o;
          return (
            <button
              key={o}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(o)}
              className={`flex h-14 items-center gap-2 rounded-sm border-2 px-3 text-left text-label font-bold ${selected ? TONE_CLASSES[meta.tone].tile : "border-line-strong bg-surface text-ink"}`}
            >
              <StatusIcon name={meta.icon} size={24} />
              {meta.label}
            </button>
          );
        })}
      </div>
      {error && <p className="text-caption text-danger">{error}</p>}
    </fieldset>
  );
}
