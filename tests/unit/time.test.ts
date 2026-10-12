import { describe, expect, it } from "vitest";
import {
  addDays,
  atLocal,
  isWorkday,
  localDateOf,
  localTime,
  localToday,
  nextWorkday,
  parseWorkdays,
  weekdayOf,
  workdayOnOrAfter,
} from "@/lib/domain/time";

const DENVER = "America/Denver";
const MON_SAT = parseWorkdays("MON,TUE,WED,THU,FRI,SAT");
const MON_FRI = parseWorkdays("MON,TUE,WED,THU,FRI");

describe("DST in America/Denver", () => {
  // 2026: DST starts Sunday March 8, ends Sunday November 1.
  it("maps a local time to UTC on both sides of the spring change", () => {
    expect(atLocal(DENVER, "2026-03-07", "09:00").toISOString()).toBe("2026-03-07T16:00:00.000Z"); // MST, UTC-7
    expect(atLocal(DENVER, "2026-03-08", "09:00").toISOString()).toBe("2026-03-08T15:00:00.000Z"); // MDT, UTC-6
  });

  it("maps a local time to UTC on both sides of the fall change", () => {
    expect(atLocal(DENVER, "2026-10-31", "09:00").toISOString()).toBe("2026-10-31T15:00:00.000Z");
    expect(atLocal(DENVER, "2026-11-01", "09:00").toISOString()).toBe("2026-11-01T16:00:00.000Z");
  });

  it("moves a time in the spring gap forward", () => {
    expect(atLocal(DENVER, "2026-03-08", "02:30").toISOString()).toBe("2026-03-08T09:30:00.000Z"); // 03:30 MDT
  });

  it("computes the local date around midnight", () => {
    expect(localToday(DENVER, new Date("2026-03-08T06:30:00Z"))).toBe("2026-03-07"); // 23:30 MST
    expect(localToday(DENVER, new Date("2026-03-09T06:30:00Z"))).toBe("2026-03-09"); // 00:30 MDT
    expect(localDateOf(new Date("2026-11-02T06:30:00Z"), DENVER)).toBe("2026-11-01"); // 23:30 MST
  });

  it("formats local wall-clock time", () => {
    expect(localTime(DENVER, new Date("2026-03-08T15:05:00Z"))).toBe("09:05");
    expect(localTime("America/Chicago", new Date("2026-10-07T14:00:00Z"))).toBe("09:00");
  });
});

describe("workdays", () => {
  it("parses the stored CSV form", () => {
    expect(parseWorkdays("MON, tue,XYZ,SUN")).toEqual(["MON", "TUE", "SUN"]);
  });

  it("knows weekdays", () => {
    expect(weekdayOf("2026-10-09")).toBe("FRI");
    expect(weekdayOf("2026-10-11")).toBe("SUN");
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
  });

  it("rolls over a weekend to Monday", () => {
    expect(nextWorkday({ workdays: MON_FRI }, "2026-10-09")).toBe("2026-10-12");
    expect(nextWorkday({ workdays: MON_SAT }, "2026-10-10")).toBe("2026-10-12");
    expect(nextWorkday({ workdays: MON_SAT }, "2026-10-09")).toBe("2026-10-10");
  });

  it("skips unavailable dates", () => {
    const rep = { workdays: MON_FRI, unavailableDates: ["2026-10-12", "2026-10-13"] };
    expect(isWorkday(rep, "2026-10-12")).toBe(false);
    expect(nextWorkday(rep, "2026-10-09")).toBe("2026-10-14");
  });

  it("includes the start date only for workdayOnOrAfter", () => {
    expect(workdayOnOrAfter({ workdays: MON_FRI }, "2026-10-09")).toBe("2026-10-09");
    expect(workdayOnOrAfter({ workdays: MON_FRI }, "2026-10-10")).toBe("2026-10-12");
  });

  it("gives up after 14 days", () => {
    expect(() => nextWorkday({ workdays: [] }, "2026-10-09")).toThrow(/No workday/);
  });
});
