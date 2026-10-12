// Default values for the settings registry (backend spec §7). lib/settings.ts stores overrides in
// AppSetting and validates them; the domain functions take the subset they need as plain values.

export const SETTINGS_DEFAULTS = {
  "assignment.maxDriveMinutes": 120,
  "assignment.shortlistSize": 5,
  "assignment.cutoffLocalTime": "11:00",
  "assignment.locationStalenessMinutes": 120,
  "assignment.maxRollovers": 3,
  "rep.defaultDailyCapacity": 20,
  "address.nameMatchThreshold": 0.8,
  "address.metroRadiusMiles": 30,
  "routing.provider": "LOCAL" as "LOCAL" | "GOOGLE",
  "routing.visitDurationMinutes": 20,
  "routing.roadFactor": 1.3,
  "routing.avgSpeedMph": 30,
  "routing.useRouteMatrix": false,
  "visit.arrivalRadiusMeters": 200,
  "outcome.maxNotHomeAttempts": 3,
  "schedule.routePlanLocalTime": "06:30",
  "schedule.rolloverLocalTime": "21:00",
  "schedule.digestTime": "19:00",
  "schedule.digestTimeZone": "America/Chicago",
  "location.foregroundPingSeconds": 120,
  "location.retentionDays": 90,
  "webhooks.outboundUrl": null as string | null,
};

export type SettingsMap = typeof SETTINGS_DEFAULTS;
export type SettingKey = keyof SettingsMap;

/** Travel-time estimate inputs shared by assignment and routing. */
export type TravelSettings = { roadFactor: number; avgSpeedMph: number };

export const DEFAULT_TRAVEL: TravelSettings = {
  roadFactor: SETTINGS_DEFAULTS["routing.roadFactor"],
  avgSpeedMph: SETTINGS_DEFAULTS["routing.avgSpeedMph"],
};
