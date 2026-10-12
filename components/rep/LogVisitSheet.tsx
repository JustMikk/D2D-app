"use client";
// "How did it go?" (PRD REP-6): outcome tiles, then only the fields that outcome needs. Saving works
// offline: everything goes into the outbox in one step, and the app syncs it when it can.
import { Camera, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { onSubmitWith } from "@/components/ui/form";
import { OutcomePicker } from "@/components/ui/OutcomePicker";
import { Sheet } from "@/components/ui/Sheet";
import type { Outcome } from "@/lib/domain/enums";
import { visitFieldErrors } from "@/lib/domain/outcomes";
import { newClientId, nextStepIso } from "@/lib/rep/helpers";
import { compressImage, MAX_PHOTO_BYTES } from "@/lib/rep/image";
import type { Fix, NewItem, VisitPayload } from "@/lib/rep/outbox";
import type { TodayStop } from "@/lib/services/repApp";
import { SignaturePad, type SignaturePadHandle } from "./SignaturePad";

const NEEDS_DECISION_MAKER: Outcome[] = ["NOT_INTERESTED", "FOLLOW_UP", "APPOINTMENT_SET", "SOLD"];
const NEEDS_NEXT_STEP: Outcome[] = ["FOLLOW_UP", "APPOINTMENT_SET"];

type Photo = { id: string; blob: Blob; url: string };
type Errors = Partial<Record<"outcome" | "nextStepAt" | "signatureMediaId" | "photo" | "form", string>>;

export function LogVisitSheet({
  stop,
  timeZone,
  onClose,
  onSave,
}: {
  stop: TodayStop | null;
  timeZone: string;
  onClose: () => void;
  /** Queue the visit (and its files). The sheet closes after this resolves. */
  onSave: (stop: TodayStop, items: NewItem[], blobs: { id: string; blob: Blob }[]) => Promise<void>;
}) {
  const open = stop !== null;
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [decisionMaker, setDecisionMaker] = useState<boolean | null>(null);
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("10:00");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [signed, setSigned] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const opened = useRef(0);
  const sigRef = useRef<SignaturePadHandle>(null);
  const stopId = stop?.assignmentId;

  // A fresh form for every stop.
  useEffect(() => {
    if (!stopId) return;
    setOutcome(null);
    setDecisionMaker(null);
    setNotes("");
    setDate("");
    setTime("10:00");
    setPhotos((old) => {
      old.forEach((p) => URL.revokeObjectURL(p.url));
      return [];
    });
    setSigned(false);
    setErrors({});
    setSaving(false);
    opened.current = Date.now();
  }, [stopId]);

  const showNextStep = outcome !== null && NEEDS_NEXT_STEP.includes(outcome);
  const showDecisionMaker = outcome !== null && NEEDS_DECISION_MAKER.includes(outcome);
  const showSignature = outcome === "SOLD";
  const minDate = useMemo(() => new Date().toISOString().slice(0, 10), []);

  async function addPhoto(files: FileList | null) {
    if (!files?.length) return;
    setErrors((e) => ({ ...e, photo: undefined }));
    for (const file of Array.from(files)) {
      if (photos.length >= 3) break;
      try {
        const blob = await compressImage(file);
        if (blob.size > MAX_PHOTO_BYTES) throw new Error("Photo is over 5 MB. Take a smaller one or skip it.");
        setPhotos((p) => (p.length >= 3 ? p : [...p, { id: newClientId(), blob, url: URL.createObjectURL(blob) }]));
      } catch (error) {
        setErrors((e) => ({ ...e, photo: error instanceof Error ? error.message : "That photo couldn't be added." }));
      }
    }
  }

  async function save() {
    if (!stop || !outcome) return setErrors({ outcome: "Pick how it went." });
    const nextStepAt = showNextStep && date ? nextStepIso(date, time, timeZone) : null;
    const now = new Date();
    const problems = visitFieldErrors({ outcome, nextStepAt: nextStepAt ? new Date(nextStepAt) : null, signatureMediaId: showSignature && signed ? "pending" : null, photoMediaIds: photos.map((p) => p.id) }, now);
    if (problems.length) {
      return setErrors(Object.fromEntries(problems.map((p) => [p.path, p.message])));
    }
    setSaving(true);
    setErrors({});
    try {
      const blobs = photos.map((p) => ({ id: p.id, blob: p.blob }));
      const items: NewItem[] = photos.map((p) => ({ kind: "media", payload: { clientId: p.id, kind: "PHOTO" } }));
      let signatureClientId: string | undefined;
      if (showSignature) {
        const png = await sigRef.current?.toBlob();
        if (!png) throw new Error("The signature couldn't be saved. Try again.");
        signatureClientId = newClientId();
        blobs.push({ id: signatureClientId, blob: png });
        items.push({ kind: "media", payload: { clientId: signatureClientId, kind: "SIGNATURE" } });
      }
      const location = await quickFix();
      const payload: VisitPayload = {
        clientId: newClientId(),
        assignmentId: stop.assignmentId,
        doorId: stop.door.id,
        outcome,
        ...(showDecisionMaker && decisionMaker !== null ? { decisionMakerPresent: decisionMaker } : {}),
        notes: notes.trim(),
        ...(nextStepAt ? { nextStepAt } : {}),
        ...(photos.length ? { photoClientIds: photos.map((p) => p.id) } : {}),
        ...(signatureClientId ? { signatureClientId } : {}),
        ...(location ? { location } : {}),
        recordedAt: now.toISOString(),
        formDurationS: Math.round((now.getTime() - opened.current) / 1000),
      };
      items.push({ kind: "visit", payload });
      await onSave(stop, items, blobs);
    } catch (error) {
      setErrors({ form: error instanceof Error ? error.message : "The visit couldn't be saved. Try again." });
      setSaving(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      side="bottom"
      title="How did it go?"
      footer={
        <Button type="submit" form="visit-form" size="rep" block disabled={saving || !outcome}>
          {saving ? "Saving…" : "Save visit"}
        </Button>
      }
    >
      <form id="visit-form" onSubmit={onSubmitWith(() => void save())} className="flex flex-col gap-6">
        {stop && <p className="text-body-l text-ink-2">{stop.door.companyName}</p>}
        {errors.form && (
          <p role="alert" className="rounded-sm bg-red-bg px-4 py-3 text-body text-red-fg">
            {errors.form}
          </p>
        )}
        <OutcomePicker value={outcome} onChange={(o) => { setOutcome(o); setErrors({}); }} error={errors.outcome} />

        {showDecisionMaker && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-label">Decision-maker present</legend>
            <div className="flex gap-2" role="radiogroup" aria-label="Decision-maker present">
              {[true, false].map((v) => (
                <button
                  key={String(v)}
                  type="button"
                  role="radio"
                  aria-checked={decisionMaker === v}
                  onClick={() => setDecisionMaker(v)}
                  className={`h-12 flex-1 rounded-sm border-2 text-label font-bold ${decisionMaker === v ? "border-outline bg-surface-inverse text-ink-inverse" : "border-line-strong bg-surface text-ink"}`}
                >
                  {v ? "Yes" : "No"}
                </button>
              ))}
            </div>
          </fieldset>
        )}

        {outcome && (
          <Field label="Notes">
            {(p) => (
              <textarea
                {...p}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={2000}
                rows={3}
                className="w-full rounded-sm border-2 border-line-strong bg-surface px-3 py-2 text-body-l text-ink outline-none focus-visible:outline-[3px] focus-visible:outline-focus"
              />
            )}
          </Field>
        )}

        {showNextStep && (
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Field label={outcome === "APPOINTMENT_SET" ? "Appointment date" : "Follow up on"} error={errors.nextStepAt}>
              {(p) => <Input {...p} size="rep" type="date" min={minDate} value={date} onChange={(e) => setDate(e.target.value)} />}
            </Field>
            <Field label="Time">{(p) => <Input {...p} size="rep" type="time" value={time} onChange={(e) => setTime(e.target.value)} />}</Field>
          </div>
        )}

        {outcome && (
          <div className="flex flex-col gap-2">
            <span className="text-label">Photos (optional)</span>
            <div className="flex flex-wrap gap-2">
              {photos.map((p) => (
                <div key={p.id} className="relative size-20 overflow-hidden rounded-sm border-2 border-line-strong">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL, not a remote image */}
                  <img src={p.url} alt="Visit photo" className="size-full object-cover" />
                  <button
                    type="button"
                    aria-label="Remove photo"
                    onClick={() => {
                      URL.revokeObjectURL(p.url);
                      setPhotos((all) => all.filter((x) => x.id !== p.id));
                    }}
                    className="absolute right-0 top-0 grid size-8 place-items-center bg-surface-inverse text-ink-inverse"
                  >
                    <X aria-hidden="true" size={16} />
                  </button>
                </div>
              ))}
              {photos.length < 3 && (
                <label className="grid size-20 cursor-pointer place-items-center rounded-sm border-2 border-dashed border-line-strong text-ink-2">
                  <Camera aria-hidden="true" size={24} />
                  <span className="sr-only">Add a photo</span>
                  <input type="file" accept="image/*" capture="environment" className="sr-only" data-testid="photo-input" onChange={(e) => { void addPhoto(e.target.files); e.target.value = ""; }} />
                </label>
              )}
            </div>
            {errors.photo && <p className="text-caption text-danger">{errors.photo}</p>}
          </div>
        )}

        {showSignature && <SignaturePad ref={sigRef} onChange={(empty) => setSigned(!empty)} error={errors.signatureMediaId} />}
      </form>
    </Sheet>
  );
}

/** A fix for the visit's GPS stamp: quick, because the rep is waiting. Null when denied or too slow. */
async function quickFix(): Promise<Fix | null> {
  const { getFix } = await import("@/lib/rep/geo");
  return (await getFix(3000, 120_000)).fix;
}
