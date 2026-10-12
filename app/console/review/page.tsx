import { CircleCheck } from "lucide-react";
import { CONSOLE_ROLES, canManage } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { getReviewQueue } from "@/lib/services/review";
import { REVIEW_REASON } from "@/lib/ui/status";
import { ReviewCard } from "./ReviewCard";

// Review queue (PRD MGR-2, ADR-3, ADR-4): grouped by reason, oldest first, evidence side by side.
export default async function ReviewPage() {
  const user = await requireUser(CONSOLE_ROLES);
  const queue = await getReviewQueue();
  const editable = canManage(user.role);

  return (
    <div className="flex max-w-[1100px] flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-title-l">Review</h1>
        <p className="text-body text-ink-2">
          {queue.total === 0 ? "Nothing waiting." : `${queue.total} ${queue.total === 1 ? "door needs" : "doors need"} an address decision`}
        </p>
      </header>

      {queue.total === 0 && (
        <div className="flex items-center gap-3 rounded-md border border-line bg-surface px-5 py-6 text-body-l">
          <CircleCheck aria-hidden="true" className="text-success" />
          No doors need a decision
        </div>
      )}

      {queue.groups.map((group) => (
        <section key={group.reason} className="flex flex-col gap-3" aria-labelledby={`group-${group.reason}`}>
          <h2 id={`group-${group.reason}`} className="text-title-m">
            {REVIEW_REASON[group.reason].label} <span className="tnum text-ink-2">({group.count})</span>
          </h2>
          <ul className="flex flex-col gap-3">
            {group.items.map((item) => (
              <li key={item.id}>
                <ReviewCard item={JSON.parse(JSON.stringify(item))} editable={editable} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
