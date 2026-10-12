// How each setting is labelled and edited on the console Settings screen (PRD MGR-6, ADR-5).
import type { SettingKey } from "@/lib/domain/settings";

export type FieldKind = "int" | "number" | "time" | "select" | "bool" | "url" | "timezone";

export type SettingField = {
  key: SettingKey;
  label: string;
  help?: string;
  kind: FieldKind;
  unit?: string;
  options?: { value: string; label: string }[];
};

export type SettingGroup = { id: string; title: string; description: string; fields: SettingField[] };

export const US_TIME_ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"];

export const SETTING_GROUPS: SettingGroup[] = [
  {
    id: "assignment",
    title: "Assignment",
    description: "How new doors are given to reps.",
    fields: [
      { key: "assignment.maxDriveMinutes", label: "Longest drive to a door", unit: "minutes", kind: "int", help: "Doors farther than this from every rep become coverage gaps." },
      { key: "assignment.cutoffLocalTime", label: "Same-day cutoff", kind: "time", help: "A door that arrives before this time (rep's local time) can be visited today." },
      { key: "assignment.shortlistSize", label: "Reps compared at once", kind: "int", help: "The nearest reps by distance get real drive times; the next group is tried if they are full." },
      { key: "assignment.locationStalenessMinutes", label: "Use a rep's location for", unit: "minutes", kind: "int", help: "Older fixes are ignored and the deployment base is used instead." },
      { key: "assignment.maxRollovers", label: "Moves to the next day before review", kind: "int" },
      { key: "rep.defaultDailyCapacity", label: "Default doors per rep per day", kind: "int", help: "Used for new reps. Each rep can have their own." },
      { key: "outcome.maxNotHomeAttempts", label: "Not-home attempts before closing", kind: "int" },
    ],
  },
  {
    id: "routing",
    title: "Routing",
    description: "How each rep's day is ordered.",
    fields: [
      {
        key: "routing.provider",
        label: "Route provider",
        kind: "select",
        options: [
          { value: "LOCAL", label: "Built in (no setup)" },
          { value: "GOOGLE", label: "Google Route Optimization" },
        ],
        help: "Google needs a Cloud project and service account. If it fails, the built-in planner takes over.",
      },
      { key: "routing.visitDurationMinutes", label: "Time at each door", unit: "minutes", kind: "int" },
      { key: "routing.roadFactor", label: "Road factor", kind: "number", help: "Multiplies straight-line distance to estimate road distance." },
      { key: "routing.avgSpeedMph", label: "Average speed", unit: "mph", kind: "number" },
      { key: "visit.arrivalRadiusMeters", label: "On-site radius", unit: "meters", kind: "int", help: "Arriving farther than this from the door is flagged off-site." },
    ],
  },
  {
    id: "address",
    title: "Address matching",
    description: "How the visit address is chosen.",
    fields: [
      { key: "address.nameMatchThreshold", label: "Company name match", kind: "number", help: "0 to 1. A Google Places result must match the company name at least this closely." },
      { key: "address.metroRadiusMiles", label: "Metro radius", unit: "miles", kind: "number", help: "A company address farther than this from the job city goes to review." },
    ],
  },
  {
    id: "schedule",
    title: "Schedule",
    description: "Daily jobs. Route plans and rollover use each rep's time zone.",
    fields: [
      { key: "schedule.routePlanLocalTime", label: "Plan routes at", kind: "time" },
      { key: "schedule.rolloverLocalTime", label: "Roll over unvisited doors at", kind: "time" },
      { key: "schedule.digestTime", label: "Send the daily digest at", kind: "time" },
      { key: "schedule.digestTimeZone", label: "Digest time zone", kind: "timezone" },
    ],
  },
  {
    id: "location",
    title: "Location",
    description: "What the rep app collects during a shift.",
    fields: [
      { key: "location.foregroundPingSeconds", label: "Location update every", unit: "seconds", kind: "int", help: "While the app is open during a shift." },
      { key: "location.retentionDays", label: "Keep location history", unit: "days", kind: "int" },
    ],
  },
  {
    id: "integrations",
    title: "Integrations",
    description: "Where events go. The signing secret stays in the server environment, never here.",
    fields: [{ key: "webhooks.outboundUrl", label: "n8n webhook URL", kind: "url", help: "Leave blank to hold events until it is set." }],
  },
];
