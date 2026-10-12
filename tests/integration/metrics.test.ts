import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getMetrics, getPilotHealth, metricsCsv, percentile } from "@/lib/services/metrics";
import { createRep } from "./helpers";

let n = 0;
async function door() {
  n += 1;
  const company = await db().company.create({ data: { name: `M Co ${n}`, nameKey: `m co ${n}` } });
  return db().door.create({ data: { externalProspectId: `MET-${n}`, companyId: company.id, name: `M Co ${n}`, status: "GEOCODED", lat: 32.8, lng: -96.8 } });
}
async function visit(repId: string, doorId: string, outcome: string, at: string, extra: { formDurationS?: number; receivedAt?: string } = {}) {
  return db().visit.create({ data: { clientId: `c-${Math.random()}`, doorId, repId, outcome, recordedAt: new Date(at), receivedAt: new Date(extra.receivedAt ?? at), formDurationS: extra.formDurationS ?? null } });
}

describe("percentile", () => {
  it("uses the nearest-rank method", () => {
    expect(percentile([], 90)).toBeNull();
    expect(percentile([5], 90)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([10, 1, 5, 3], 50)).toBe(3);
  });
});

describe("metrics", () => {
  it("counts visits on each rep's local day, with contacts, appointments, sales and drive time", async () => {
    const dallas = await createRep("Dana Dallas", "America/Chicago", { lat: 32.8, lng: -96.8 });
    const seattle = await createRep("Sam Seattle", "America/Los_Angeles", { lat: 47.6, lng: -122.3 });
    const d = [await door(), await door(), await door(), await door(), await door()];
    // Dallas, Wednesday 10-07 local: not home, not interested, appointment, sold.
    await visit(dallas.rep.id, d[0]!.id, "NOT_HOME", "2026-10-07T15:00:00Z");
    await visit(dallas.rep.id, d[1]!.id, "NOT_INTERESTED", "2026-10-07T16:00:00Z");
    await visit(dallas.rep.id, d[2]!.id, "APPOINTMENT_SET", "2026-10-07T20:00:00Z");
    await visit(dallas.rep.id, d[3]!.id, "SOLD", "2026-10-08T03:30:00Z"); // 22:30 CDT: still the 7th in Dallas
    // The same instant is a different day elsewhere: 01:00Z on the 8th is 18:00 on the 7th in Seattle.
    await visit(seattle.rep.id, d[4]!.id, "BAD_ADDRESS", "2026-10-08T01:00:00Z");
    // Outside the range.
    await visit(dallas.rep.id, d[0]!.id, "NOT_HOME", "2026-10-09T15:00:00Z");
    // Two plans for Dallas on the 7th: the later one counts.
    await db().routePlan.create({ data: { repId: dallas.rep.id, date: "2026-10-07", provider: "LOCAL", trigger: "SCHEDULED", status: "OK", startLat: 0, startLng: 0, totalDriveMinutes: 100, createdAt: new Date("2026-10-07T11:30:00Z") } });
    await db().routePlan.create({ data: { repId: dallas.rep.id, date: "2026-10-07", provider: "LOCAL", trigger: "HOT_DOOR", status: "OK", startLat: 0, startLng: 0, totalDriveMinutes: 120, createdAt: new Date("2026-10-07T17:00:00Z") } });

    const m = await getMetrics({ from: "2026-10-07", to: "2026-10-08" });
    const dana = m.rows.find((r) => r.repName === "Dana Dallas" && r.date === "2026-10-07")!;
    expect(dana).toMatchObject({ visited: 4, contacts: 3, appointments: 1, sales: 1, contactRate: 0.75, driveMinutes: 120, driveMinutesPerVisit: 30 });
    expect(m.rows.find((r) => r.repName === "Sam Seattle" && r.date === "2026-10-07")).toMatchObject({ visited: 1, contacts: 0, contactRate: 0 });
    expect(m.rows.filter((r) => r.repName === "Dana Dallas")).toHaveLength(1); // nothing on the 8th: the visit on the 9th is out of range
    expect(m.totals).toMatchObject({ visited: 5, contacts: 3, appointments: 1, sales: 1, driveMinutes: 120 });
    expect(m.perRep.map((r) => [r.repName, r.visited, r.days])).toEqual([["Dana Dallas", 4, 1], ["Sam Seattle", 1, 1]]);

    expect((await getMetrics({ from: "2026-10-07", to: "2026-10-09", repId: dallas.rep.id })).totals.visited).toBe(5);
    expect((await getMetrics({ from: "2026-10-01", to: "2026-10-02" })).totals).toMatchObject({ visited: 0, contactRate: null, driveMinutesPerVisit: null });
  });

  it("exports a CSV with a line per rep per day and a total per rep, quoting what needs it", async () => {
    const rep = await createRep('Quinn "Q" Reed, Jr.', "America/Chicago", { lat: 32.8, lng: -96.8 });
    await visit(rep.rep.id, (await door()).id, "SOLD", "2026-11-03T16:00:00Z");
    const csv = metricsCsv(await getMetrics({ from: "2026-11-03", to: "2026-11-03", repId: rep.rep.id }));
    expect(csv.split("\n")).toEqual([
      "Date,Rep,Visited,Contacts,Appointments,Sales,Contact rate,Drive minutes,Drive minutes per visit",
      '2026-11-03,"Quinn ""Q"" Reed, Jr.",1,1,0,1,1,0,0',
      'Total 2026-11-03 to 2026-11-03,"Quinn ""Q"" Reed, Jr.",1,1,0,1,1,0,0',
      "",
    ]);
  });

  it("validates the range", async () => {
    await expect(getMetrics({ from: "2026-10-09", to: "2026-10-01" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(getMetrics({ from: "2026-01-01", to: "2026-12-31" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(getMetrics({ from: "Oct 1", to: "Oct 2" })).rejects.toThrow();
  });
});

describe("pilot health", () => {
  it("reports 'no data yet' for an empty period instead of passing or failing", async () => {
    const health = await getPilotHealth({ from: "2030-01-01", to: "2030-01-07" });
    expect(health.map((h) => h.id)).toEqual(["intake-to-assignment", "no-review", "log-time", "synced", "alert"]);
    expect(health.every((h) => h.pass === null && h.display === "No data yet" && h.sample === 0)).toBe(true);
  });

  it("computes each PRD success metric from real records and compares it with the target", async () => {
    const rep = await createRep("Health Rep", "America/Chicago", { lat: 32.8, lng: -96.8 });
    const T = new Date("2031-03-05T15:00:00Z");
    const at = (min: number) => new Date(T.getTime() + min * 60_000);
    // Ten doors created at T: eight assigned within 2 minutes, two after 20 minutes; two of them needed review.
    const doors = [];
    for (let i = 0; i < 10; i++) {
      const d = await door();
      await db().door.update({ where: { id: d.id }, data: { createdAt: T } });
      await db().assignment.create({ data: { doorId: d.id, repId: rep.rep.id, scheduledFor: "2031-03-05", assignedBy: "ENGINE", createdAt: at(i >= 8 ? 20 : 2) } });
      doors.push(d);
    }
    for (const d of doors.slice(0, 2)) await db().auditLog.create({ data: { actorType: "SYSTEM", action: "door.needs_review", entityType: "DOOR", entityId: d.id } });
    // Visits: durations 10, 20, 40 s; one arrived 5 minutes after it was saved (offline).
    await visit(rep.rep.id, doors[0]!.id, "SOLD", T.toISOString(), { formDurationS: 10 });
    await visit(rep.rep.id, doors[1]!.id, "NOT_HOME", T.toISOString(), { formDurationS: 20, receivedAt: at(5).toISOString() });
    await visit(rep.rep.id, doors[2]!.id, "SOLD", T.toISOString(), { formDurationS: 40, receivedAt: new Date(T.getTime() + 30_000).toISOString() });
    // Hot alerts: delivered in 5 s, 10 s and 90 s.
    for (const seconds of [5, 10, 90]) await db().outboxEvent.create({ data: { type: "visit.hot", payload: "{}", status: "SENT", createdAt: T, sentAt: new Date(T.getTime() + seconds * 1000) } });

    const by = Object.fromEntries((await getPilotHealth({ from: "2031-03-05", to: "2031-03-05" })).map((h) => [h.id, h]));
    expect(by["intake-to-assignment"]).toMatchObject({ value: 20, pass: false, sample: 10 }); // p90 (the 9th of 10) of eight 2-minute and two 20-minute doors
    expect(by["no-review"]).toMatchObject({ value: 0.8, display: "80%", pass: false });
    expect(by["log-time"]).toMatchObject({ value: 20, display: "20 s", pass: true, sample: 3 });
    expect(by["synced"]).toMatchObject({ pass: false, sample: 3 });
    expect(by["synced"]!.value).toBeCloseTo(2 / 3, 3);
    expect(by["alert"]).toMatchObject({ value: 90, display: "90 s", pass: false, sample: 3 });
  });
});
