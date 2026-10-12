// Enum registry (backend spec §4.3). Enums are stored as strings in SQLite; these arrays are the
// single list of allowed values, and every write goes through the matching zod enum.
import { z } from "zod";

export const ROLES = ["ADMIN", "MANAGER", "REP", "VIEWER"] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

export const DOOR_STATUSES = ["NEW", "NEEDS_REVIEW", "GEOCODED", "ASSIGNED", "SCHEDULED", "VISITED", "CLOSED", "UNASSIGNABLE"] as const;
export const DoorStatus = z.enum(DOOR_STATUSES);
export type DoorStatus = z.infer<typeof DoorStatus>;

export const REVIEW_REASONS = [
  "PO_BOX",
  "MISSING_ADDRESS",
  "LOCATION_MISMATCH",
  "REMOTE_JOB",
  "LOW_GEOCODE_QUALITY",
  "COVERAGE_GAP",
  "BAD_ADDRESS",
  "ROLLOVER_LIMIT",
] as const;
export const ReviewReason = z.enum(REVIEW_REASONS);
export type ReviewReason = z.infer<typeof ReviewReason>;

export const CLOSED_REASONS = ["NOT_INTERESTED", "SOLD", "MAX_ATTEMPTS", "NO_VISIT", "DO_NOT_KNOCK", "MANUAL"] as const;
export const ClosedReason = z.enum(CLOSED_REASONS);
export type ClosedReason = z.infer<typeof ClosedReason>;

export const PRIORITIES = ["NORMAL", "HOT"] as const;
export const Priority = z.enum(PRIORITIES);
export type Priority = z.infer<typeof Priority>;

export const GEOCODE_QUALITIES = ["ROOFTOP", "INTERPOLATED", "CENTER", "APPROXIMATE"] as const;
export const GeocodeQuality = z.enum(GEOCODE_QUALITIES);
export type GeocodeQuality = z.infer<typeof GeocodeQuality>;

export const ADDRESS_SOURCES = ["COMPANY_ADDRESS", "PLACES_MATCH", "METRO_FALLBACK", "MANUAL"] as const;
export const AddressSource = z.enum(ADDRESS_SOURCES);
export type AddressSource = z.infer<typeof AddressSource>;

export const WORKPLACE_TYPES = ["ON_SITE", "HYBRID", "REMOTE", "UNKNOWN"] as const;
export const WorkplaceType = z.enum(WORKPLACE_TYPES);
export type WorkplaceType = z.infer<typeof WorkplaceType>;

export const VISIT_WINDOWS = ["MORNING", "AFTERNOON", "EVENING"] as const;
export const VisitWindow = z.enum(VISIT_WINDOWS);
export type VisitWindow = z.infer<typeof VisitWindow>;

export const DOOR_SOURCES = ["API", "IMPORT", "MANUAL"] as const;
export const DoorSource = z.enum(DOOR_SOURCES);
export type DoorSource = z.infer<typeof DoorSource>;

export const ASSIGNMENT_STATUSES = ["ACTIVE", "COMPLETED", "ROLLED_OVER", "CANCELLED", "SKIPPED"] as const;
export const AssignmentStatus = z.enum(ASSIGNMENT_STATUSES);
export type AssignmentStatus = z.infer<typeof AssignmentStatus>;

export const ASSIGNED_BY = ["ENGINE", "MANAGER"] as const;
export const AssignedBy = z.enum(ASSIGNED_BY);
export type AssignedBy = z.infer<typeof AssignedBy>;

export const OUTCOMES = ["NOT_HOME", "NOT_INTERESTED", "FOLLOW_UP", "APPOINTMENT_SET", "SOLD", "BAD_ADDRESS"] as const;
export const Outcome = z.enum(OUTCOMES);
export type Outcome = z.infer<typeof Outcome>;

export const LOCATION_SOURCES = ["START_DAY", "ARRIVED", "VISIT", "FOREGROUND", "END_DAY"] as const;
export const LocationSource = z.enum(LOCATION_SOURCES);
export type LocationSource = z.infer<typeof LocationSource>;

export const MEDIA_KINDS = ["PHOTO", "SIGNATURE"] as const;
export const MediaKind = z.enum(MEDIA_KINDS);
export type MediaKind = z.infer<typeof MediaKind>;

export const ROUTE_PROVIDERS = ["LOCAL", "GOOGLE"] as const;
export const RouteProvider = z.enum(ROUTE_PROVIDERS);
export type RouteProvider = z.infer<typeof RouteProvider>;

export const ROUTE_TRIGGERS = ["SCHEDULED", "REP", "MANAGER", "HOT_DOOR", "NEW_TODAY"] as const;
export const RouteTrigger = z.enum(ROUTE_TRIGGERS);
export type RouteTrigger = z.infer<typeof RouteTrigger>;

export const ROUTE_PLAN_STATUSES = ["OK", "PARTIAL", "FAILED"] as const;
export const RoutePlanStatus = z.enum(ROUTE_PLAN_STATUSES);
export type RoutePlanStatus = z.infer<typeof RoutePlanStatus>;

export const JOB_STATUSES = ["QUEUED", "RUNNING", "DONE", "FAILED"] as const;
export const JobStatus = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatus>;

export const OUTBOX_STATUSES = ["PENDING", "SENT", "FAILED"] as const;
export const OutboxStatus = z.enum(OUTBOX_STATUSES);
export type OutboxStatus = z.infer<typeof OutboxStatus>;

export const ASSIGN_REASONS = ["NEW", "ROLLOVER", "NOT_HOME", "REVISIT", "RETRY", "REP_CHANGE"] as const;
export const AssignReason = z.enum(ASSIGN_REASONS);
export type AssignReason = z.infer<typeof AssignReason>;

export const SKIP_REASONS = ["CLOSED", "UNSAFE", "OUT_OF_TIME", "OTHER"] as const;
export const SkipReason = z.enum(SKIP_REASONS);
export type SkipReason = z.infer<typeof SkipReason>;

export const DO_NOT_KNOCK_KINDS = ["COMPANY", "ADDRESS"] as const;
export const DoNotKnockKind = z.enum(DO_NOT_KNOCK_KINDS);
export type DoNotKnockKind = z.infer<typeof DoNotKnockKind>;

export const SHIFT_ENDED_BY = ["REP", "SYSTEM"] as const;
export const ShiftEndedBy = z.enum(SHIFT_ENDED_BY);
export type ShiftEndedBy = z.infer<typeof ShiftEndedBy>;

export const ACTOR_TYPES = ["USER", "API_KEY", "SYSTEM"] as const;
export const ActorType = z.enum(ACTOR_TYPES);
export type ActorType = z.infer<typeof ActorType>;

export const IMPORT_FORMATS = ["APIFY_JSON", "CSV"] as const;
export const ImportFormat = z.enum(IMPORT_FORMATS);
export type ImportFormat = z.infer<typeof ImportFormat>;

export const IMPORT_STATUSES = ["PREVIEWED", "COMMITTING", "COMMITTED", "FAILED"] as const;
export const ImportStatus = z.enum(IMPORT_STATUSES);
export type ImportStatus = z.infer<typeof ImportStatus>;

/** Weekday codes as stored in `Rep.workdays` ("MON,TUE,…"). Index 0 is Monday, matching Luxon's weekday - 1. */
export const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
export const Weekday = z.enum(WEEKDAYS);
export type Weekday = z.infer<typeof Weekday>;

/** Door statuses that still count as open (not closed). */
export const OPEN_DOOR_STATUSES = DOOR_STATUSES.filter((s) => s !== "CLOSED");
