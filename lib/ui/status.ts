// Status and outcome system (design doc §4). One constant per enum so the chip, map pin, list row and
// filter menu can never disagree. Icons are lucide-react component names.
import type { DoorStatus, Outcome, ReviewReason } from "@/lib/domain/enums";

export type Tone = "slate" | "amber" | "red" | "blue" | "violet" | "teal" | "green" | "ink";

export type StatusMeta = { label: string; tone: Tone; icon: IconName; outlined?: boolean };

export type IconName =
  | "CircleDashed"
  | "TriangleAlert"
  | "MapPin"
  | "UserCheck"
  | "Route"
  | "DoorOpen"
  | "Archive"
  | "MapPinOff"
  | "DoorClosed"
  | "CircleX"
  | "CalendarClock"
  | "CalendarCheck"
  | "BadgeCheck"
  | "MapPinX";

export const DOOR_STATUS = {
  NEW: { label: "New", tone: "slate", icon: "CircleDashed" },
  NEEDS_REVIEW: { label: "Needs review", tone: "amber", icon: "TriangleAlert" },
  GEOCODED: { label: "Ready", tone: "teal", icon: "MapPin" },
  ASSIGNED: { label: "Assigned", tone: "blue", icon: "UserCheck", outlined: true },
  SCHEDULED: { label: "Scheduled", tone: "blue", icon: "Route" },
  VISITED: { label: "Visited", tone: "violet", icon: "DoorOpen" },
  CLOSED: { label: "Closed", tone: "ink", icon: "Archive" },
  UNASSIGNABLE: { label: "No rep nearby", tone: "red", icon: "MapPinOff" },
} as const satisfies Record<DoorStatus, StatusMeta>;

export const VISIT_OUTCOME = {
  NOT_HOME: { label: "Not home", tone: "slate", icon: "DoorClosed" },
  NOT_INTERESTED: { label: "Not interested", tone: "ink", icon: "CircleX" },
  FOLLOW_UP: { label: "Follow-up", tone: "amber", icon: "CalendarClock" },
  APPOINTMENT_SET: { label: "Appointment set", tone: "blue", icon: "CalendarCheck" },
  SOLD: { label: "Sold", tone: "green", icon: "BadgeCheck" },
  BAD_ADDRESS: { label: "Bad address", tone: "red", icon: "MapPinX" },
} as const satisfies Record<Outcome, StatusMeta>;

export const REVIEW_REASON = {
  PO_BOX: { label: "Address is a PO box" },
  MISSING_ADDRESS: { label: "No street address" },
  LOCATION_MISMATCH: { label: "Company address is far from the job city" },
  REMOTE_JOB: { label: "Remote job, nothing to visit" },
  LOW_GEOCODE_QUALITY: { label: "Address could not be pinned exactly" },
  COVERAGE_GAP: { label: "No rep within driving range" },
  BAD_ADDRESS: { label: "Rep reported a bad address" },
  ROLLOVER_LIMIT: { label: "Moved to the next day too many times" },
} as const satisfies Record<ReviewReason, { label: string }>;

/**
 * Tone classes, written out in full so Tailwind can see them.
 * Chip = `bg-{tone}-bg text-{tone}-fg`; pin fill = `{tone}-solid` with a 2px outline stroke.
 */
export const TONE_CLASSES: Record<Tone, { chip: string; outlined: string; solid: string; fg: string; tile: string }> = {
  slate: { tile: "bg-slate-bg border-slate-fg text-slate-fg", chip: "bg-slate-bg text-slate-fg", outlined: "border-slate-fg text-slate-fg", solid: "bg-slate-solid", fg: "text-slate-fg" },
  amber: { tile: "bg-amber-bg border-amber-fg text-amber-fg", chip: "bg-amber-bg text-amber-fg", outlined: "border-amber-fg text-amber-fg", solid: "bg-amber-solid", fg: "text-amber-fg" },
  red: { tile: "bg-red-bg border-red-fg text-red-fg", chip: "bg-red-bg text-red-fg", outlined: "border-red-fg text-red-fg", solid: "bg-red-solid", fg: "text-red-fg" },
  blue: { tile: "bg-blue-bg border-blue-fg text-blue-fg", chip: "bg-blue-bg text-blue-fg", outlined: "border-blue-fg text-blue-fg", solid: "bg-blue-solid", fg: "text-blue-fg" },
  violet: { tile: "bg-violet-bg border-violet-fg text-violet-fg", chip: "bg-violet-bg text-violet-fg", outlined: "border-violet-fg text-violet-fg", solid: "bg-violet-solid", fg: "text-violet-fg" },
  teal: { tile: "bg-teal-bg border-teal-fg text-teal-fg", chip: "bg-teal-bg text-teal-fg", outlined: "border-teal-fg text-teal-fg", solid: "bg-teal-solid", fg: "text-teal-fg" },
  green: { tile: "bg-green-bg border-green-fg text-green-fg", chip: "bg-green-bg text-green-fg", outlined: "border-green-fg text-green-fg", solid: "bg-green-solid", fg: "text-green-fg" },
  ink: { tile: "bg-ink-tone-bg border-ink-tone-fg text-ink-tone-fg", chip: "bg-ink-tone-bg text-ink-tone-fg", outlined: "border-ink-tone-fg text-ink-tone-fg", solid: "bg-ink-tone-solid", fg: "text-ink-tone-fg" },
};
