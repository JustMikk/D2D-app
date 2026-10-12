import { DateTime } from "luxon";
import { Flame } from "lucide-react";
import Link from "next/link";
import { Chip, StatusChip } from "@/components/ui/Chip";
import { buttonClasses } from "@/components/ui/Button";
import { ApiError } from "@/lib/api/errors";
import { CONSOLE_ROLES, canManage } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { DOOR_SOURCES, DOOR_STATUSES, type DoorStatus } from "@/lib/domain/enums";
import { DoorListQuery, getDoorDetail, listDoors } from "@/lib/services/doors";
import { repChoices } from "@/lib/services/reps";
import { DOOR_STATUS } from "@/lib/ui/status";
import { DoorDrawer } from "./DoorDrawer";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

// Doors table (PRD MGR-3): search by company or address; filter by status and source; detail drawer.
export default async function DoorsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser(CONSOLE_ROLES);
  const sp = await searchParams;
  const parsed = DoorListQuery.safeParse({ q: one(sp.q), status: one(sp.status), source: one(sp.source), cursor: one(sp.cursor), limit: 50 });
  const query = parsed.success ? parsed.data : DoorListQuery.parse({ limit: 50 });
  const page = await listDoors(query);

  const doorId = one(sp.door);
  const reps = doorId ? await repChoices() : [];
  const detail = doorId
    ? await getDoorDetail(doorId).catch((e: unknown) => {
        if (e instanceof ApiError && e.code === "NOT_FOUND") return null;
        throw e;
      })
    : null;

  const filters = new URLSearchParams(Object.entries({ q: query.q, status: query.status, source: query.source }).filter(([, v]) => v) as [string, string][]);
  const withParams = (extra: Record<string, string>) => {
    const p = new URLSearchParams(filters);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return `/console/doors?${p.toString()}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-title-l">Doors</h1>

      <form className="flex flex-wrap items-end gap-3" role="search">
        <label className="flex flex-col gap-1.5 text-label">
          Search
          <input
            name="q"
            defaultValue={query.q ?? ""}
            placeholder="Company, address or prospect ID"
            className="h-10 w-80 rounded-sm border border-line-strong bg-surface px-3 text-body"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-label">
          Status
          <select name="status" defaultValue={query.status ?? ""} className="h-10 rounded-sm border border-line-strong bg-surface px-3 text-body">
            <option value="">Any status</option>
            {DOOR_STATUSES.map((s) => (
              <option key={s} value={s}>
                {DOOR_STATUS[s].label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-label">
          Source
          <select name="source" defaultValue={query.source ?? ""} className="h-10 rounded-sm border border-line-strong bg-surface px-3 text-body">
            <option value="">Any source</option>
            {DOOR_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={buttonClasses("secondary")}>
          Apply
        </button>
        {filters.size > 0 && (
          <Link href="/console/doors" className="h-10 content-center text-label text-link">
            Clear filters
          </Link>
        )}
      </form>

      {page.items.length === 0 ? (
        <p className="text-body text-ink-2">No doors match these filters.</p>
      ) : (
        <table className="w-full border-collapse text-body">
          <thead>
            <tr className="border-b border-line text-left text-label text-ink-2">
              <th className="py-2 pr-4 font-semibold">Company</th>
              <th className="py-2 pr-4 font-semibold">Address</th>
              <th className="py-2 pr-4 font-semibold">Status</th>
              <th className="py-2 pr-4 font-semibold">Rep</th>
              <th className="py-2 pr-4 font-semibold">Source</th>
              <th className="py-2 font-semibold">Updated</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((d) => (
              <tr key={d.id} className="border-b border-line hover:bg-surface-sunken">
                <td className="py-2.5 pr-4">
                  <Link href={withParams({ door: d.id })} scroll={false} className="inline-flex items-center gap-1.5 font-semibold text-ink hover:underline">
                    {d.priority === "HOT" && <Flame aria-label="Hot" size={16} className="text-hot-text" />}
                    {d.companyName}
                  </Link>
                </td>
                <td className="py-2.5 pr-4 text-ink-2">{d.address || d.jobLocation || "—"}</td>
                <td className="py-2.5 pr-4">
                  <StatusChip status={d.status as DoorStatus} />
                </td>
                <td className="py-2.5 pr-4">{d.rep ? `${d.rep.name}, ${d.rep.scheduledFor}` : "—"}</td>
                <td className="py-2.5 pr-4">
                  <Chip tone="slate">{d.source.charAt(0) + d.source.slice(1).toLowerCase()}</Chip>
                </td>
                <td className="tnum py-2.5 text-ink-2">{DateTime.fromJSDate(d.updatedAt).toRelative()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="flex gap-3">
        {query.cursor && (
          <Link href={`/console/doors?${filters.toString()}`} className={buttonClasses("secondary")}>
            First page
          </Link>
        )}
        {page.nextCursor && (
          <Link href={withParams({ cursor: page.nextCursor })} className={buttonClasses("secondary")}>
            Next page
          </Link>
        )}
      </div>

      {detail && <DoorDrawer detail={JSON.parse(JSON.stringify(detail))} closeHref={`/console/doors?${new URLSearchParams([...filters, ...(query.cursor ? [["cursor", query.cursor]] : [])]).toString()}`} editable={canManage(user.role)} reps={reps} />}
    </div>
  );
}
