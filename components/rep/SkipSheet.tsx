"use client";
// Skip a stop (PRD REP-11): the rep gives a reason, and the stop leaves today and goes back to assignment.
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import type { SkipPayload } from "@/lib/rep/outbox";

const REASONS: { value: SkipPayload["reason"]; label: string }[] = [
  { value: "CLOSED", label: "It's closed" },
  { value: "UNSAFE", label: "It doesn't feel safe" },
  { value: "OUT_OF_TIME", label: "I ran out of time" },
  { value: "OTHER", label: "Something else" },
];

export function SkipSheet({ companyName, open, onCancel, onConfirm }: { companyName: string; open: boolean; onCancel: () => void; onConfirm: (reason: SkipPayload["reason"], note: string) => void }) {
  const [reason, setReason] = useState<SkipPayload["reason"] | null>(null);
  const [note, setNote] = useState("");
  const finish = () => {
    if (!reason) return;
    onConfirm(reason, note.trim());
    setReason(null);
    setNote("");
  };
  return (
    <Sheet
      open={open}
      onClose={onCancel}
      side="bottom"
      title="Skip this stop?"
      footer={
        <div className="flex flex-col gap-2">
          <Button size="rep" block disabled={!reason} onClick={finish}>
            Skip stop
          </Button>
          <Button size="rep" variant="secondary" block onClick={onCancel}>
            Keep it
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-body-l text-ink-2">{companyName} leaves today and goes back to be assigned. You won&apos;t get it again today.</p>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-label">Why?</legend>
          <div role="radiogroup" aria-label="Reason" className="flex flex-col gap-2">
            {REASONS.map((r) => (
              <button
                key={r.value}
                type="button"
                role="radio"
                aria-checked={reason === r.value}
                onClick={() => setReason(r.value)}
                className={`h-14 rounded-sm border-2 px-4 text-left text-label font-bold ${reason === r.value ? "border-outline bg-surface-inverse text-ink-inverse" : "border-line-strong bg-surface text-ink"}`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </fieldset>
        {reason === "OTHER" && (
          <label className="flex flex-col gap-1.5 text-label">
            Tell us more (optional)
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} rows={2} className="rounded-sm border-2 border-line-strong bg-surface px-3 py-2 text-body-l text-ink" />
          </label>
        )}
      </div>
    </Sheet>
  );
}
