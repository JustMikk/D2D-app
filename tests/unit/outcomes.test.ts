import { describe, expect, it } from "vitest";
import { applyOutcome, visitFieldErrors, type OutcomeVisit } from "@/lib/domain/outcomes";

const NOW = new Date("2026-10-07T16:00:00Z");
const NEXT = new Date("2026-10-09T15:00:00Z");
const SETTINGS = { maxNotHomeAttempts: 3 };

const visit = (over: Partial<OutcomeVisit>): OutcomeVisit => ({
  outcome: "NOT_HOME",
  repId: "rep_1",
  notes: "",
  nextStepAt: null,
  location: { lat: 33, lng: -96.8 },
  ...over,
});

const events = (r: ReturnType<typeof applyOutcome>) =>
  r.effects.filter((e) => e.type === "emit").map((e) => (e.type === "emit" ? e.event : ""));

describe("applyOutcome", () => {
  it("NOT_HOME under the limit returns the door to GEOCODED and re-assigns it", () => {
    const r = applyOutcome({ attempts: 0 }, visit({}), SETTINGS, NOW);
    expect(r.patch).toMatchObject({ status: "GEOCODED", attempts: 1, lastOutcome: "NOT_HOME" });
    expect(r.effects).toContainEqual({ type: "enqueue", job: "door.assign", reason: "NOT_HOME" });
  });

  it("the third NOT_HOME closes the door", () => {
    const r = applyOutcome({ attempts: 2 }, visit({}), SETTINGS, NOW);
    expect(r.patch).toMatchObject({ status: "CLOSED", attempts: 3, closedReason: "MAX_ATTEMPTS", closedAt: NOW });
    expect(r.effects.some((e) => e.type === "enqueue")).toBe(false);
  });

  it("NOT_INTERESTED closes the door", () => {
    const r = applyOutcome({ attempts: 0 }, visit({ outcome: "NOT_INTERESTED" }), SETTINGS, NOW);
    expect(r.patch).toMatchObject({ status: "CLOSED", closedReason: "NOT_INTERESTED", closedAt: NOW });
    expect(r.patch.attempts).toBeUndefined();
  });

  it("FOLLOW_UP marks the door visited with the next step and the rep", () => {
    const r = applyOutcome({ attempts: 1 }, visit({ outcome: "FOLLOW_UP", nextStepAt: NEXT }), SETTINGS, NOW);
    expect(r.patch).toMatchObject({ status: "VISITED", nextStepAt: NEXT, preferredRepId: "rep_1" });
    expect(events(r)).not.toContain("visit.hot");
  });

  it("APPOINTMENT_SET is visited and emits a hot event", () => {
    const r = applyOutcome({ attempts: 0 }, visit({ outcome: "APPOINTMENT_SET", nextStepAt: NEXT }), SETTINGS, NOW);
    expect(r.patch).toMatchObject({ status: "VISITED", nextStepAt: NEXT, preferredRepId: "rep_1" });
    expect(events(r)).toContain("visit.hot");
  });

  it("SOLD closes the door and emits a hot event", () => {
    const r = applyOutcome({ attempts: 0 }, visit({ outcome: "SOLD" }), SETTINGS, NOW);
    expect(r.patch).toMatchObject({ status: "CLOSED", closedReason: "SOLD" });
    expect(events(r)).toContain("visit.hot");
  });

  it("BAD_ADDRESS sends the door to review with the rep's evidence", () => {
    const r = applyOutcome({ attempts: 0 }, visit({ outcome: "BAD_ADDRESS", notes: "Empty lot" }), SETTINGS, NOW);
    expect(r.patch).toEqual({
      lastOutcome: "BAD_ADDRESS",
      status: "NEEDS_REVIEW",
      reviewReason: "BAD_ADDRESS",
      reviewDetail: { note: "Empty lot", reportedAt: { lat: 33, lng: -96.8 } },
    });
    expect(events(r)).toContain("door.needs_review");
  });

  it("every outcome completes the assignment and emits visit.recorded and door.upserted", () => {
    for (const outcome of ["NOT_HOME", "NOT_INTERESTED", "FOLLOW_UP", "APPOINTMENT_SET", "SOLD", "BAD_ADDRESS"] as const) {
      const r = applyOutcome({ attempts: 0 }, visit({ outcome, nextStepAt: NEXT }), SETTINGS, NOW);
      expect(r.effects[0]).toEqual({ type: "completeAssignment" });
      expect(events(r)).toEqual(expect.arrayContaining(["visit.recorded", "door.upserted"]));
      expect(r.patch.lastOutcome).toBe(outcome);
    }
  });
});

describe("visitFieldErrors", () => {
  it("requires a future next step for follow-ups and appointments", () => {
    expect(visitFieldErrors({ outcome: "FOLLOW_UP" }, NOW)).toEqual([{ path: "nextStepAt", message: "Pick a date and time for the next step" }]);
    expect(visitFieldErrors({ outcome: "APPOINTMENT_SET", nextStepAt: new Date("2026-10-07T15:00:00Z") }, NOW)[0]?.path).toBe("nextStepAt");
    expect(visitFieldErrors({ outcome: "APPOINTMENT_SET", nextStepAt: NEXT }, NOW)).toEqual([]);
  });

  it("requires a signature for a sale and caps photos at 3", () => {
    expect(visitFieldErrors({ outcome: "SOLD" }, NOW)[0]?.path).toBe("signatureMediaId");
    expect(visitFieldErrors({ outcome: "SOLD", signatureMediaId: "m1" }, NOW)).toEqual([]);
    expect(visitFieldErrors({ outcome: "NOT_HOME", photoMediaIds: ["1", "2", "3", "4"] }, NOW)[0]?.path).toBe("photoMediaIds");
  });
});
