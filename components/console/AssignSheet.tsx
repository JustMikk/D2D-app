"use client";
// Assign or reassign a door to a rep for a date (PRD ASN-3). Manual assignments may exceed capacity and
// are never overridden by the engine.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { onSubmitWith } from "@/components/ui/form";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";

export type RepChoice = { id: string; name: string; timeZone: string; today: string };

export function AssignSheet({
  open,
  onClose,
  doorId,
  doorName,
  reps,
  defaultRepId,
  defaultDate,
}: {
  open: boolean;
  onClose: () => void;
  doorId: string;
  doorName: string;
  reps: RepChoice[];
  defaultRepId?: string;
  defaultDate?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [repId, setRepId] = useState(defaultRepId ?? reps[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const rep = reps.find((r) => r.id === repId);

  async function submit(form: FormData) {
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await fetch(`/api/v1/doors/${doorId}/assign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repId, date: String(form.get("date") ?? ""), reason: String(form.get("reason") ?? "") || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        const details: { path: string; message: string }[] = data.error?.details ?? [];
        setFieldErrors(Object.fromEntries(details.map((d) => [d.path, d.message])));
        if (!details.length) setError(data.error?.message ?? "The door could not be assigned.");
        return;
      }
      toast.show(`Assigned to ${rep?.name ?? "rep"}`);
      onClose();
      router.refresh();
    } catch {
      setError("You're offline. Connect and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Assign door"
      footer={
        <Button block type="submit" form="assign-form" disabled={pending || reps.length === 0}>
          {pending ? "Assigning…" : "Assign"}
        </Button>
      }
    >
      <form id="assign-form" onSubmit={onSubmitWith((f) => void submit(f))} className="flex flex-col gap-5">
        <p className="text-body text-ink-2">{doorName}</p>
        {error && (
          <p role="alert" className="rounded-sm bg-red-bg px-4 py-3 text-body text-red-fg">
            {error}
          </p>
        )}
        {reps.length === 0 ? (
          <p className="text-body">There are no active reps to assign to.</p>
        ) : (
          <>
            <Field label="Rep">
              {(p) => (
                <Select {...p} value={repId} onChange={(e) => setRepId(e.target.value)}>
                  {reps.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.timeZone.split("/")[1]?.replace("_", " ")})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Date" helper="In the rep's time zone." error={fieldErrors.date}>
              {(p) => <Input {...p} key={repId} type="date" name="date" required min={rep?.today} defaultValue={defaultDate && rep && defaultDate >= rep.today ? defaultDate : rep?.today} />}
            </Field>
            <Field label="Note" helper="Optional. Kept in the door's history." error={fieldErrors.reason}>
              {(p) => <Input {...p} name="reason" maxLength={300} />}
            </Field>
          </>
        )}
      </form>
    </Sheet>
  );
}
