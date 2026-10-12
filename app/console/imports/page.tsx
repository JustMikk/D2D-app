import { DateTime } from "luxon";
import { Chip } from "@/components/ui/Chip";
import { ADMIN_ROLES } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { listDoNotKnock } from "@/lib/services/doNotKnock";
import { listImports } from "@/lib/services/imports";
import { DoNotKnockSection } from "./DoNotKnockSection";
import { CountChips, ImportUploader } from "./ImportUploader";

// Imports and the do-not-knock list (PRD INT-5, INT-6, MGR-9). Admin only.
export default async function ImportsPage() {
  await requireUser(ADMIN_ROLES);
  const [history, entries] = await Promise.all([listImports(), listDoNotKnock()]);

  return (
    <div className="flex max-w-[1100px] flex-col gap-10">
      <h1 className="text-title-l">Imports</h1>

      <section className="flex flex-col gap-3" aria-labelledby="new-import">
        <h2 id="new-import" className="text-title-m">
          New import
        </h2>
        <ImportUploader />
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="history">
        <h2 id="history" className="text-title-m">
          History
        </h2>
        {history.length === 0 ? (
          <p className="text-body text-ink-2">No imports yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {history.map((b) => (
              <li key={b.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-title-s">{b.filename}</span>
                  <Chip tone={b.status === "COMMITTED" ? "green" : b.status === "FAILED" ? "red" : b.status === "COMMITTING" ? "teal" : "slate"}>
                    {b.status === "COMMITTED" ? "Imported" : b.status === "COMMITTING" ? "Importing" : b.status === "FAILED" ? "Failed" : "Not confirmed"}
                  </Chip>
                  <span className="text-caption text-ink-2">
                    {DateTime.fromJSDate(b.createdAt).toLocaleString(DateTime.DATETIME_MED)}
                    {b.createdBy ? ` by ${b.createdBy}` : ""}
                  </span>
                </div>
                <CountChips counts={b.counts} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="dnk">
        <div className="flex flex-col gap-1">
          <h2 id="dnk" className="text-title-m">
            Do not knock
          </h2>
          <p className="text-body text-ink-2">Prospects that match are rejected at intake, and any open doors that match are closed.</p>
        </div>
        <DoNotKnockSection entries={JSON.parse(JSON.stringify(entries))} />
      </section>
    </div>
  );
}
