// Chips (design doc §8.4): pill, 28px, a 16px icon then the label. Filled for status; outlined for
// "Assigned" and filter chips. Status is never color alone: the icon and label are always present.
import type { ReactNode } from "react";
import type { DoorStatus, Outcome } from "@/lib/domain/enums";
import { DOOR_STATUS, TONE_CLASSES, VISIT_OUTCOME, type StatusMeta, type Tone } from "@/lib/ui/status";
import { StatusIcon } from "./Icon";

export function Chip({ tone, outlined, icon, children }: { tone: Tone; outlined?: boolean; icon?: ReactNode; children: ReactNode }) {
  const toneClasses = outlined ? `border ${TONE_CLASSES[tone].outlined} bg-transparent` : TONE_CLASSES[tone].chip;
  return (
    <span className={`inline-flex h-7 items-center gap-1.5 rounded-pill px-2.5 text-label whitespace-nowrap ${toneClasses}`}>
      {icon}
      {children}
    </span>
  );
}

function MetaChip({ meta }: { meta: StatusMeta }) {
  return (
    <Chip tone={meta.tone} outlined={meta.outlined} icon={<StatusIcon name={meta.icon} size={16} />}>
      {meta.label}
    </Chip>
  );
}

export function StatusChip({ status }: { status: DoorStatus }) {
  return <MetaChip meta={DOOR_STATUS[status]} />;
}

export function OutcomeChip({ outcome }: { outcome: Outcome }) {
  return <MetaChip meta={VISIT_OUTCOME[outcome]} />;
}
