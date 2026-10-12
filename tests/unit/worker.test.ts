import { describe, expect, it } from "vitest";
import { parseWorkdays } from "@/lib/domain/time";
import { afterFailure, RETRY_SCHEDULE_MS } from "@/worker/outbox";
import { backoffMs } from "@/worker/runner";
import { dueJobs, type ScheduleInput, type ScheduleRep } from "@/worker/scheduler";

describe("job backoff", () => {
  it("doubles from 15 s and caps at 30 minutes", () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(backoffMs(20)).toBe(30 * 60_000);
  });
});

describe("outbox retry schedule", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  it("retries 10 times over about 24 hours, then fails", () => {
    expect(RETRY_SCHEDULE_MS.reduce((a, b) => a + b, 0) / 3600_000).toBeCloseTo(23.85, 1);
    expect(afterFailure(1, now)).toEqual({ status: "PENDING", nextAttemptAt: new Date(now.getTime() + 30_000) });
    expect(afterFailure(10, now)).toEqual({ status: "PENDING", nextAttemptAt: new Date(now.getTime() + 8 * 3600_000) });
    expect(afterFailure(11, now)).toEqual({ status: "FAILED" });
  });
});

describe("scheduler dueJobs", () => {
  const settings: ScheduleInput["settings"] = {
    "schedule.routePlanLocalTime": "06:30",
    "schedule.rolloverLocalTime": "21:00",
    "schedule.digestTime": "19:00",
    "schedule.digestTimeZone": "America/Chicago",
  };
  const chicago: ScheduleRep = { id: "chi", timeZone: "America/Chicago", workdays: parseWorkdays("MON,TUE,WED,THU,FRI,SAT"), unavailableDates: [] };
  const la: ScheduleRep = { id: "la", timeZone: "America/Los_Angeles", workdays: parseWorkdays("MON,TUE,WED,THU,FRI,SAT"), unavailableDates: [] };
  const at = (iso: string, reps = [chicago, la]) =>
    dueJobs({ now: new Date(iso), reps, settings, serverTimeZone: "UTC" }).map((j) => j.key);

  it("plans each rep's route at 06:30 in their own time zone", () => {
    // 12:00 UTC on Wednesday: 07:00 Chicago (due), 05:00 Los Angeles (not yet).
    expect(at("2026-10-07T12:00:00Z")).toEqual(["plan:chi:2026-10-07:scheduled", "retention:2026-10-07", "unassignable-retry:2026-10-07"]);
    // 14:00 UTC: 07:00 in Los Angeles too.
    expect(at("2026-10-07T14:00:00Z")).toContain("plan:la:2026-10-07:scheduled");
  });

  it("does not plan on a non-workday or an unavailable day, but still rolls over", () => {
    // Sunday 2026-10-11, 21:30 Chicago.
    // 02:30 UTC is before the 03:00 server-time maintenance window.
    expect(at("2026-10-12T02:30:00Z", [chicago])).toEqual(["rollover:chi:2026-10-11", "digest:2026-10-11"]);
    const off = { ...chicago, unavailableDates: ["2026-10-07"] };
    expect(at("2026-10-07T12:00:00Z", [off]).some((k) => k.startsWith("plan:"))).toBe(false);
  });

  it("sends the digest at 19:00 in the digest time zone", () => {
    expect(at("2026-10-07T23:59:00Z", [])).not.toContain("digest:2026-10-07"); // 18:59 CDT
    expect(at("2026-10-08T00:00:00Z", [])).toContain("digest:2026-10-07"); // 19:00 CDT
  });

  it("catches up: anything past its time and not done is still due", () => {
    // 03:00 UTC Thursday = 22:00 Wednesday in Chicago: plan, rollover and digest are all due for Wednesday.
    const keys = at("2026-10-08T03:00:00Z", [chicago]);
    expect(keys).toEqual(expect.arrayContaining(["plan:chi:2026-10-07:scheduled", "rollover:chi:2026-10-07", "digest:2026-10-07"]));
  });
});
