// Settings registry (backend spec §7). Values live in AppSetting as JSON, validated per key with zod,
// falling back to the defaults in lib/domain/settings.ts. Reads are cached in memory for 30 seconds.
import { z } from "zod";
import { audit, type Actor } from "@/lib/api/audit";
import { validationFailed, type ErrorDetail } from "@/lib/api/errors";
import { db, type Db } from "@/lib/db";
import { SETTINGS_DEFAULTS, type SettingKey, type SettingsMap } from "@/lib/domain/settings";
import { isValidTimeZone } from "@/lib/domain/time";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm, for example 09:30");
const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const SETTINGS_SCHEMA = {
  "assignment.maxDriveMinutes": int(5, 600),
  "assignment.shortlistSize": int(1, 25),
  "assignment.cutoffLocalTime": hhmm,
  "assignment.locationStalenessMinutes": int(5, 24 * 60),
  "assignment.maxRollovers": int(0, 30),
  "rep.defaultDailyCapacity": int(1, 100),
  "address.nameMatchThreshold": z.number().min(0).max(1),
  "address.metroRadiusMiles": z.number().min(0).max(500),
  "routing.provider": z.enum(["LOCAL", "GOOGLE"]),
  "routing.visitDurationMinutes": int(1, 240),
  "routing.roadFactor": z.number().min(1).max(3),
  "routing.avgSpeedMph": z.number().min(5).max(80),
  "routing.useRouteMatrix": z.boolean(),
  "visit.arrivalRadiusMeters": int(10, 5000),
  "outcome.maxNotHomeAttempts": int(1, 20),
  "schedule.routePlanLocalTime": hhmm,
  "schedule.rolloverLocalTime": hhmm,
  "schedule.digestTime": hhmm,
  "schedule.digestTimeZone": z.string().refine(isValidTimeZone, "Unknown time zone"),
  "location.foregroundPingSeconds": int(30, 3600),
  "location.retentionDays": int(1, 3650),
  "webhooks.outboundUrl": z.url().nullable(),
} satisfies { [K in SettingKey]: z.ZodType<SettingsMap[K]> };

export const SETTING_KEYS = Object.keys(SETTINGS_SCHEMA) as SettingKey[];

const CACHE_MS = 30_000;
const globalForSettings = globalThis as unknown as { settingsCache?: { at: number; value: SettingsMap } };

/** Merge stored rows over the defaults. Rows that fail validation are ignored (and logged). */
export function mergeStored(rows: readonly { key: string; value: string }[]): SettingsMap {
  const merged: Record<string, unknown> = { ...SETTINGS_DEFAULTS };
  for (const row of rows) {
    if (!(row.key in SETTINGS_SCHEMA)) continue;
    const schema = SETTINGS_SCHEMA[row.key as SettingKey];
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      console.warn(`Setting ${row.key} is not valid JSON; using the default.`);
      continue;
    }
    const result = schema.safeParse(parsed);
    if (result.success) merged[row.key] = result.data;
    else console.warn(`Setting ${row.key} is invalid; using the default.`);
  }
  return merged as SettingsMap;
}

export async function getSettings(client: Db = db()): Promise<SettingsMap> {
  const cached = globalForSettings.settingsCache;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = mergeStored(await client.appSetting.findMany());
  globalForSettings.settingsCache = { at: Date.now(), value };
  return value;
}

export async function getSetting<K extends SettingKey>(key: K, client?: Db): Promise<SettingsMap[K]> {
  return (await getSettings(client))[key];
}

export function invalidateSettingsCache(): void {
  globalForSettings.settingsCache = undefined;
}

/** Validate a partial map of keys. Unknown keys and invalid values are reported per key. */
export function parseSettingsPatch(input: unknown): Partial<SettingsMap> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw validationFailed([{ path: "(root)", message: "Send an object of setting keys and values" }]);
  }
  const details: ErrorDetail[] = [];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!(key in SETTINGS_SCHEMA)) {
      details.push({ path: key, message: "Unknown setting" });
      continue;
    }
    const result = SETTINGS_SCHEMA[key as SettingKey].safeParse(value);
    if (result.success) out[key] = result.data;
    else details.push({ path: key, message: result.error.issues[0]?.message ?? "Invalid value" });
  }
  if (details.length) throw validationFailed(details);
  return out as Partial<SettingsMap>;
}

/** Apply a validated patch, audit before and after, and clear the cache. */
export async function updateSettings(actor: Actor, input: unknown): Promise<SettingsMap> {
  const patch = parseSettingsPatch(input);
  const userId = actor.type === "USER" ? actor.userId : null;
  await db().$transaction(async (tx) => {
    const before = mergeStored(await tx.appSetting.findMany());
    for (const [key, value] of Object.entries(patch)) {
      const json = JSON.stringify(value);
      await tx.appSetting.upsert({
        where: { key },
        create: { key, value: json, updatedById: userId },
        update: { value: json, updatedById: userId },
      });
    }
    const changed = Object.fromEntries(
      Object.entries(patch).map(([k, v]) => [k, { before: before[k as SettingKey], after: v }]),
    );
    await audit(tx, actor, "settings.updated", "SETTING", "app", changed);
  });
  invalidateSettingsCache();
  return getSettings();
}
