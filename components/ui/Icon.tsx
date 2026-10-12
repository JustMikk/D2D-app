// Maps the icon names used by lib/ui/status.ts to lucide-react components.
import {
  Archive,
  BadgeCheck,
  CalendarCheck,
  CalendarClock,
  CircleDashed,
  CircleX,
  DoorClosed,
  DoorOpen,
  MapPin,
  MapPinOff,
  MapPinX,
  Route,
  TriangleAlert,
  UserCheck,
  type LucideProps,
} from "lucide-react";
import type { IconName } from "@/lib/ui/status";

const ICONS = {
  Archive,
  BadgeCheck,
  CalendarCheck,
  CalendarClock,
  CircleDashed,
  CircleX,
  DoorClosed,
  DoorOpen,
  MapPin,
  MapPinOff,
  MapPinX,
  Route,
  TriangleAlert,
  UserCheck,
} satisfies Record<IconName, unknown>;

export function StatusIcon({ name, ...props }: { name: IconName } & LucideProps) {
  const Component = ICONS[name];
  return <Component aria-hidden="true" strokeWidth={1.75} {...props} />;
}
