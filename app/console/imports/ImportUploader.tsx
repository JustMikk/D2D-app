"use client";
// Upload, preview, confirm (PRD INT-5, MGR-9). The preview shows what would happen and writes nothing; the
// worker does the import after the admin confirms, and this screen follows its progress.
import { Download, FileUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { Field } from "@/components/ui/Field";
import { onSubmitWith } from "@/components/ui/form";
import { useToast } from "@/components/ui/Toast";
import type { Tone } from "@/lib/ui/status";

type Counts = { received: number; created: number; duplicates: number; merged: number; invalid: number; doNotKnock: number };
type Batch = { id: string; filename: string; status: string; counts: Counts; errors: { row: number; errors: string | null }[] };
type Preview = Batch & { rows: { row: number; company: string; status: string; detail: string | null }[]; truncated: boolean };

const ROW_TONE: Record<string, { tone: Tone; label: string }> = {
  accepted: { tone: "green", label: "New door" },
  duplicate: { tone: "slate", label: "Already imported" },
  merged: { tone: "blue", label: "Added to a door" },
  invalid: { tone: "red", label: "Invalid" },
  do_not_knock: { tone: "amber", label: "Do not knock" },
};

export function CountChips({ counts }: { counts: Counts }) {
  return (
    <div className="flex flex-wrap gap-2" aria-label="Import counts">
      <Chip tone="slate">{counts.received} rows</Chip>
      <Chip tone="green">{counts.created} new</Chip>
      <Chip tone="slate">{counts.duplicates} already imported</Chip>
      <Chip tone="blue">{counts.merged} added to existing doors</Chip>
      <Chip tone={counts.invalid ? "red" : "slate"}>{counts.invalid} invalid</Chip>
      <Chip tone={counts.doNotKnock ? "amber" : "slate"}>{counts.doNotKnock} do not knock</Chip>
    </div>
  );
}

export function ImportUploader() {
  const router = useRouter();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [running, setRunning] = useState<Batch | null>(null);

  async function upload(form: FormData) {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const res = await fetch("/api/v1/imports", { method: "POST", body: form, credentials: "same-origin" });
      const data = await res.json();
      if (!res.ok) return setError(data.error?.details?.[0]?.message ?? data.error?.message ?? "That file couldn't be read.");
      setPreview(data as Preview);
    } catch {
      setError("You're offline. Connect and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    const res = await fetch(`/api/v1/imports/${preview.id}/commit`, { method: "POST", credentials: "same-origin" });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) return setError(data.error?.message ?? "The import couldn't be started.");
    setPreview(null);
    setRunning(data as Batch);
  }

  async function discard() {
    if (!preview) return;
    await fetch(`/api/v1/imports/${preview.id}`, { method: "DELETE", credentials: "same-origin" });
    setPreview(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  // Follow the worker until the import is finished.
  useEffect(() => {
    if (!running || running.status !== "COMMITTING") return;
    const id = setInterval(async () => {
      const res = await fetch(`/api/v1/imports/${running.id}`, { credentials: "same-origin" }).catch(() => null);
      if (!res?.ok) return;
      const next = (await res.json()) as Batch;
      if (next.status !== "COMMITTING") {
        setRunning(next);
        toast.show(next.status === "COMMITTED" ? "Import finished" : "The import failed");
        router.refresh();
      }
    }, 1500);
    return () => clearInterval(id);
  }, [running, router, toast]);

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onSubmitWith((f) => void upload(f))} className="flex flex-wrap items-end gap-4 rounded-md border border-line bg-surface p-5">
        <Field label="Apify LinkedIn jobs (JSON) or a CSV" helper="Up to 5 MB and 2,000 rows. The same rules apply as for the API.">
          {(p) => <input {...p} ref={fileRef} name="file" type="file" accept=".json,.csv,application/json,text/csv" required className="text-body" />}
        </Field>
        <Button type="submit" disabled={busy}>
          <FileUp aria-hidden="true" size={18} />
          {busy && !preview ? "Reading…" : "Preview"}
        </Button>
        {/* A file download from an API route, not a page, so a plain link with `download`. */}
        <a href="/api/v1/imports/template" download className="inline-flex h-10 items-center gap-1.5 text-label text-link underline-offset-4 hover:underline">
          <Download aria-hidden="true" size={18} />
          Download the CSV template
        </a>
      </form>

      {error && (
        <p role="alert" className="rounded-sm bg-red-bg px-4 py-3 text-body text-red-fg">
          {error}
        </p>
      )}

      {preview && (
        <section aria-labelledby="preview-title" className="flex flex-col gap-4 rounded-md border-2 border-outline bg-surface p-5">
          <h3 id="preview-title" className="text-title-s">
            Preview of {preview.filename}
          </h3>
          <CountChips counts={preview.counts} />
          <p className="text-body text-ink-2">Nothing has been imported yet. {preview.counts.created} new doors will be created and sent for address lookup.</p>

          {preview.counts.invalid > 0 && (
            <div className="flex flex-col gap-1">
              <h4 className="text-label">Rows that can&apos;t be imported</h4>
              <ul className="flex flex-col gap-1 text-body">
                {preview.errors.slice(0, 20).map((e) => (
                  <li key={`${e.row}-${e.errors}`}>
                    <span className="tnum font-semibold">Row {e.row}</span>: <span className="text-ink-2">{e.errors}</span>
                  </li>
                ))}
              </ul>
              {preview.errors.length > 20 && <p className="text-caption text-ink-2">And {preview.errors.length - 20} more.</p>}
            </div>
          )}

          <details>
            <summary className="cursor-pointer text-label">All rows ({preview.rows.length}{preview.truncated ? ", first 200" : ""})</summary>
            <table className="mt-2 w-full border-collapse text-body">
              <thead>
                <tr className="border-b border-line text-left text-label text-ink-2">
                  <th className="py-2 pr-4 font-semibold">Row</th>
                  <th className="py-2 pr-4 font-semibold">Company</th>
                  <th className="py-2 pr-4 font-semibold">Result</th>
                  <th className="py-2 font-semibold">Why</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.row} className="border-b border-line">
                    <td className="tnum py-1.5 pr-4">{r.row}</td>
                    <td className="py-1.5 pr-4">{r.company || "—"}</td>
                    <td className="py-1.5 pr-4">
                      <Chip tone={ROW_TONE[r.status]?.tone ?? "slate"}>{ROW_TONE[r.status]?.label ?? r.status}</Chip>
                    </td>
                    <td className="py-1.5 text-ink-2">{r.detail ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>

          <div className="flex gap-2">
            <Button onClick={() => void confirm()} disabled={busy || preview.counts.created + preview.counts.merged === 0}>
              Import {preview.counts.created} {preview.counts.created === 1 ? "prospect" : "prospects"}
            </Button>
            <Button variant="secondary" onClick={() => void discard()} disabled={busy}>
              Discard
            </Button>
          </div>
        </section>
      )}

      {running && (
        <section role="status" aria-live="polite" className="flex flex-col gap-3 rounded-md border border-line bg-surface p-5">
          <h3 className="text-title-s">{running.status === "COMMITTING" ? `Importing ${running.filename}…` : running.status === "COMMITTED" ? `Imported ${running.filename}` : `${running.filename} failed`}</h3>
          {running.status !== "COMMITTING" && <CountChips counts={running.counts} />}
          {running.status === "FAILED" && <p className="text-body text-danger">{running.errors[0]?.errors ?? "Something went wrong. Check Settings for the failed job."}</p>}
        </section>
      )}
    </div>
  );
}
