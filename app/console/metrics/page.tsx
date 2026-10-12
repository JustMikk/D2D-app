import { CircleCheck, CircleHelp, Download, TriangleAlert } from "lucide-react";
import { buttonClasses } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { CONSOLE_ROLES } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { addDays, localToday } from "@/lib/domain/time";
import { getMetrics, getPilotHealth, MAX_RANGE_DAYS, type DayMetrics } from "@/lib/services/metrics";
import { repChoices } from "@/lib/services/reps";
import { getSetting } from "@/lib/settings";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 1000) / 10}%`);
const num = (v: number | null) => (v === null ? "—" : String(v));

// Metrics (PRD MGR-8) and pilot health (PRD §3): per rep, per day and for a date range, with CSV export.
export default async function MetricsPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireUser(CONSOLE_ROLES);
  const sp = await searchParams;
  const today = localToday(await getSetting("schedule.digestTimeZone"), new Date());
  const from = /^\d{4}-\d{2}-\d{2}$/.test(one(sp.from) ?? "") ? one(sp.from)! : addDays(today, -6);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(one(sp.to) ?? "") ? one(sp.to)! : today;
  const repId = one(sp.repId);

  const [reps, result, health] = await Promise.all([
    repChoices(),
    getMetrics({ from, to, repId }).then(
      (m) => ({ ok: true as const, m }),
      (e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : "That range can't be shown." }),
    ),
    getPilotHealth({ from, to }).catch(() => []),
  ]);
  const csvParams = new URLSearchParams({ from, to, format: "csv", ...(repId ? { repId } : {}) });

  return (
    <div className="flex max-w-[1200px] flex-col gap-8">
      <h1 className="text-title-l">Metrics</h1>

      <form className="flex flex-wrap items-end gap-3" role="search" aria-label="Metrics range">
        <label className="flex flex-col gap-1.5 text-label">
          From
          <input type="date" name="from" defaultValue={from} className="h-10 rounded-sm border border-line-strong bg-surface px-3 text-body" />
        </label>
        <label className="flex flex-col gap-1.5 text-label">
          To
          <input type="date" name="to" defaultValue={to} className="h-10 rounded-sm border border-line-strong bg-surface px-3 text-body" />
        </label>
        <label className="flex flex-col gap-1.5 text-label">
          Rep
          <select name="repId" defaultValue={repId ?? ""} className="h-10 rounded-sm border border-line-strong bg-surface px-3 text-body">
            <option value="">All reps</option>
            {reps.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={buttonClasses("secondary")}>
          Apply
        </button>
        {/* A file download from an API route, so a plain link. */}
        <a href={`/api/v1/metrics?${csvParams.toString()}`} download className={buttonClasses("secondary", "console", "gap-1.5")}>
          <Download aria-hidden="true" size={18} />
          Export CSV
        </a>
      </form>

      {!result.ok ? (
        <p role="alert" className="rounded-sm bg-red-bg px-4 py-3 text-body text-red-fg">
          {result.message} Pick at most {MAX_RANGE_DAYS} days.
        </p>
      ) : (
        <>
          <section aria-labelledby="by-rep" className="flex flex-col gap-3">
            <h2 id="by-rep" className="text-title-m">
              By rep
            </h2>
            {result.m.perRep.length === 0 ? (
              <p className="text-body text-ink-2">No visits in this range.</p>
            ) : (
              <MetricsTable
                rows={[...result.m.perRep.map((r) => ({ key: r.repId, label: r.repName, sub: `${r.days} ${r.days === 1 ? "day" : "days"}`, ...r })), { key: "total", label: "All reps", sub: "", bold: true, ...result.m.totals }]}
              />
            )}
          </section>

          <section aria-labelledby="by-day" className="flex flex-col gap-3">
            <h2 id="by-day" className="text-title-m">
              By day
            </h2>
            {result.m.rows.length === 0 ? (
              <p className="text-body text-ink-2">Nothing to show.</p>
            ) : (
              <MetricsTable rows={result.m.rows.map((r: DayMetrics) => ({ key: `${r.repId}|${r.date}`, label: r.date, sub: r.repName, ...r }))} />
            )}
          </section>
        </>
      )}

      <section aria-labelledby="health" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="health" className="text-title-m">
            Pilot health
          </h2>
          <p className="text-body text-ink-2">The success measures from the product requirements, worked out from what actually happened in this range.</p>
        </div>
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {health.map((h) => (
            <li key={h.id} className="flex flex-col gap-2 rounded-md border border-line bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-title-s">{h.label}</h3>
                {h.pass === null ? (
                  <Chip tone="slate" icon={<CircleHelp aria-hidden="true" size={16} />}>
                    No data
                  </Chip>
                ) : h.pass ? (
                  <Chip tone="green" icon={<CircleCheck aria-hidden="true" size={16} />}>
                    On target
                  </Chip>
                ) : (
                  <Chip tone="amber" icon={<TriangleAlert aria-hidden="true" size={16} />}>
                    Off target
                  </Chip>
                )}
              </div>
              <p className="tnum text-title-m">{h.display}</p>
              <p className="text-caption text-ink-2">
                Target: {h.target}. Based on {h.sample} {h.sample === 1 ? "record" : "records"}.
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

type Row = { key: string; label: string; sub: string; bold?: boolean; visited: number; contacts: number; appointments: number; sales: number; contactRate: number | null; driveMinutes: number; driveMinutesPerVisit: number | null };

function MetricsTable({ rows }: { rows: Row[] }) {
  return (
    <table className="w-full border-collapse text-body">
      <thead>
        <tr className="border-b border-line text-left text-label text-ink-2">
          <th className="py-2 pr-4 font-semibold">Rep or day</th>
          <th className="py-2 pr-4 text-right font-semibold">Visited</th>
          <th className="py-2 pr-4 text-right font-semibold">Contacts</th>
          <th className="py-2 pr-4 text-right font-semibold">Appointments</th>
          <th className="py-2 pr-4 text-right font-semibold">Sales</th>
          <th className="py-2 pr-4 text-right font-semibold">Contact rate</th>
          <th className="py-2 pr-4 text-right font-semibold">Drive min</th>
          <th className="py-2 text-right font-semibold">Drive min per visit</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className={`border-b border-line ${r.bold ? "font-semibold" : ""}`}>
            <td className="py-2.5 pr-4">
              {r.label}
              {r.sub && <span className="ml-2 text-caption font-normal text-ink-2">{r.sub}</span>}
            </td>
            <td className="tnum py-2.5 pr-4 text-right">{r.visited}</td>
            <td className="tnum py-2.5 pr-4 text-right">{r.contacts}</td>
            <td className="tnum py-2.5 pr-4 text-right">{r.appointments}</td>
            <td className="tnum py-2.5 pr-4 text-right">{r.sales}</td>
            <td className="tnum py-2.5 pr-4 text-right">{pct(r.contactRate)}</td>
            <td className="tnum py-2.5 pr-4 text-right">{r.driveMinutes}</td>
            <td className="tnum py-2.5 text-right">{num(r.driveMinutesPerVisit)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
