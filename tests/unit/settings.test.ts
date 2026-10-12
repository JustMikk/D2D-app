import { describe, expect, it } from "vitest";
import { SETTINGS_DEFAULTS } from "@/lib/domain/settings";
import { mergeStored, parseSettingsPatch, SETTING_KEYS } from "@/lib/settings";

describe("settings registry", () => {
  it("covers every default key", () => {
    expect(SETTING_KEYS.sort()).toEqual(Object.keys(SETTINGS_DEFAULTS).sort());
  });

  it("merges valid stored values over the defaults and ignores bad rows", () => {
    const merged = mergeStored([
      { key: "assignment.maxDriveMinutes", value: "90" },
      { key: "routing.provider", value: '"GOOGLE"' },
      { key: "schedule.digestTime", value: '"7pm"' }, // invalid: ignored
      { key: "address.metroRadiusMiles", value: "not json" }, // invalid JSON: ignored
      { key: "unknown.key", value: "1" }, // unknown: ignored
    ]);
    expect(merged["assignment.maxDriveMinutes"]).toBe(90);
    expect(merged["routing.provider"]).toBe("GOOGLE");
    expect(merged["schedule.digestTime"]).toBe("19:00");
    expect(merged["address.metroRadiusMiles"]).toBe(30);
    expect("unknown.key" in merged).toBe(false);
  });

  it("validates a patch per key", () => {
    expect(parseSettingsPatch({ "assignment.cutoffLocalTime": "10:30", "webhooks.outboundUrl": null })).toEqual({
      "assignment.cutoffLocalTime": "10:30",
      "webhooks.outboundUrl": null,
    });
    expect(() => parseSettingsPatch({ "assignment.cutoffLocalTime": "25:00" })).toThrow();
    try {
      parseSettingsPatch({ "nope.key": 1, "assignment.shortlistSize": 0, "schedule.digestTimeZone": "Mars/Base" });
      expect.unreachable();
    } catch (e) {
      expect((e as { details: { path: string }[] }).details.map((d) => d.path).sort()).toEqual([
        "assignment.shortlistSize",
        "nope.key",
        "schedule.digestTimeZone",
      ]);
    }
    expect(() => parseSettingsPatch([1, 2])).toThrow();
  });
});
