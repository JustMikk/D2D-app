// Milestone M1 (PRD §11): the 36-row sample file posted to intake yields the expected statuses and review
// reasons. Runs the real route handler with an API key, then the worker's address.resolve jobs against a
// city-level fake of Google.
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as intakeRoute } from "@/app/api/v1/intake/prospects/route";
import { PATCH as crmIdsRoute } from "@/app/api/v1/integrations/crm-ids/route";
import { db } from "@/lib/db";
import { apifyJobToIntake } from "@/lib/domain/apify";
import { setGoogleClients } from "@/lib/integrations/google";
import { cityFakeGoogle } from "@/lib/integrations/google/cityFake";
import { createApiKey, revokeApiKey } from "@/lib/services/apiKeys";
import { closeDoor, getDoorDetail, listDoors, updateDoor } from "@/lib/services/doors";
import { getReviewQueue, resolveReview } from "@/lib/services/review";
import { HANDLERS } from "@/worker/handlers";
import { runDueJobs } from "@/worker/runner";
import { createUser } from "./helpers";

const jobs = JSON.parse(readFileSync("tests/fixtures/sample_apify_linkedin_jobs.json", "utf8")) as unknown[];
const google = cityFakeGoogle({
  "Sunbelt Medical Billing Fort Worth, TX": [
    { placeId: "pl_sunbelt", displayName: "Sunbelt Medical Billing", streetNumber: "3100", route: "Hemphill St", locality: "Fort Worth", adminArea1: "TX", postalCode: "76110", businessStatus: "OPERATIONAL" },
  ],
});

let key = "";
let managerId = "";

const post = (body: unknown, apiKey = key) =>
  intakeRoute(
    new NextRequest("http://canvass.test/api/v1/intake/prospects", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );

// M1 stops at address resolution: assignment (M2) leaves its door.assign jobs queued.
const M1_HANDLERS = { "address.resolve": HANDLERS["address.resolve"] };

async function drainJobs() {
  while ((await runDueJobs(M1_HANDLERS, "test-worker")) > 0) {
    /* keep going */
  }
}

async function doorByCompany(name: string) {
  return db().door.findFirstOrThrow({ where: { company: { name } } });
}

beforeAll(async () => {
  setGoogleClients(google);
  const admin = await createUser("ADMIN");
  managerId = (await createUser("MANAGER")).id;
  key = (await createApiKey(admin.id, { name: "prospecting", scopes: ["intake:write", "crm:write"] })).key;
});
afterAll(() => setGoogleClients(null));

describe("M1: the 36-row sample", () => {
  it("intake answers accepted, duplicate and merged with the right status codes", async () => {
    const results: { status: number; body: { status: string } }[] = [];
    for (const job of jobs) {
      const res = await post(apifyJobToIntake(job));
      results.push({ status: res.status, body: await res.json() });
    }
    const count = (s: string) => results.filter((r) => r.body.status === s).length;
    expect({ accepted: count("accepted"), duplicate: count("duplicate"), merged: count("merged") }).toEqual({ accepted: 34, duplicate: 1, merged: 1 });
    expect(results.filter((r) => r.body.status === "accepted").every((r) => r.status === 201)).toBe(true);
    expect(results.filter((r) => r.body.status !== "accepted").every((r) => r.status === 200)).toBe(true);

    expect(await db().door.count()).toBe(34);
    expect(await db().door.count({ where: { status: "NEW" } })).toBe(34);
    expect(await db().job.count({ where: { type: "address.resolve", status: "QUEUED" } })).toBe(34);
    expect(await db().outboxEvent.count({ where: { type: "door.created" } })).toBe(34);
    expect(await db().auditLog.count({ where: { action: "door.created", actorType: "API_KEY" } })).toBe(34);
  });

  it("address resolution yields the expected statuses, sources and review reasons", async () => {
    await drainJobs();
    const doors = await db().door.findMany({ include: { company: { select: { name: true } } } });
    const by = Object.fromEntries(doors.map((d) => [d.company.name, d]));

    const review = doors.filter((d) => d.status === "NEEDS_REVIEW").map((d) => [d.company.name, d.reviewReason]).sort();
    expect(review).toEqual([
      ["Copperfield Learning Center", "MISSING_ADDRESS"], // no company address at all
      ["Rangeway Security Systems", "MISSING_ADDRESS"], // no ZIP
      ["Red River Logistics", "LOCATION_MISMATCH"], // Grand Prairie office, Houston job
      ["Silverline Packaging", "MISSING_ADDRESS"], // no street
    ]);
    expect(doors.filter((d) => d.status === "GEOCODED")).toHaveLength(30);

    expect(by["Trinity Roofing & Exteriors"]).toMatchObject({ addressSource: "METRO_FALLBACK", city: "Irving" });
    expect(by["Bridgewater Staffing"]).toMatchObject({ addressSource: "METRO_FALLBACK" });
    expect(by["Sunbelt Medical Billing"]).toMatchObject({ addressSource: "PLACES_MATCH", placeId: "pl_sunbelt", street: "3100 Hemphill St", zip: "76110" });
    expect(by["Lone Star Freight Solutions"]).toMatchObject({ addressSource: "COMPANY_ADDRESS", geocodeQuality: "ROOFTOP", state: "TX", zip: "75226" });
    expect(doors.filter((d) => d.status === "GEOCODED").every((d) => d.lat !== null && d.lng !== null && d.streetKey)).toBe(true);

    // Evidence is stored for the review screen.
    const redRiver = JSON.parse(by["Red River Logistics"]!.reviewDetail!);
    expect(redRiver.distanceMiles).toBeGreaterThan(200);
    expect(redRiver.companyAddress).toMatchObject({ street: "2601 Great Southwest Pkwy", city: "Grand Prairie" });

    // Each geocoded door waits for the assignment engine (M2); nothing failed.
    expect(await db().job.count({ where: { type: "door.assign", status: "QUEUED" } })).toBe(30);
    expect(await db().job.count({ where: { status: "FAILED" } })).toBe(0);
    expect(await db().outboxEvent.count({ where: { type: "door.needs_review" } })).toBe(4);
  });

  it("re-running a resolve job for a door that moved on changes nothing", async () => {
    const door = await doorByCompany("Lone Star Freight Solutions");
    await db().job.create({ data: { type: "address.resolve", payload: JSON.stringify({ doorId: door.id }) } });
    await drainJobs();
    expect(await db().door.findUniqueOrThrow({ where: { id: door.id } })).toMatchObject({ status: "GEOCODED", updatedAt: door.updatedAt });
  });
});

describe("M1: review queue", () => {
  it("groups by reason with evidence", async () => {
    const queue = await getReviewQueue();
    expect(queue.total).toBe(4);
    expect(queue.groups.map((g) => [g.reason, g.count])).toEqual([
      ["MISSING_ADDRESS", 3],
      ["LOCATION_MISMATCH", 1],
    ]);
    expect(queue.groups[1]!.items[0]).toMatchObject({ companyName: "Red River Logistics", jobLocation: "Houston, TX" });
  });

  it("uses the company address despite a mismatch", async () => {
    const door = await doorByCompany("Red River Logistics");
    const snap = await resolveReview(managerId, door.id, { action: "USE_COMPANY_ADDRESS" }, google);
    expect(snap).toMatchObject({ status: "GEOCODED", addressSource: "COMPANY_ADDRESS", reviewReason: null });
    expect(await db().job.count({ where: { type: "door.assign", payload: { contains: door.id } } })).toBe(1);
    const log = await db().auditLog.findFirstOrThrow({ where: { action: "review.resolved", entityId: door.id } });
    expect(JSON.parse(log.data!)).toMatchObject({ reason: "LOCATION_MISMATCH", action: "USE_COMPANY_ADDRESS" });
  });

  it("edits an address, rejecting one that cannot be pinned", async () => {
    const door = await doorByCompany("Silverline Packaging");
    await expect(
      resolveReview(managerId, door.id, { action: "EDIT_ADDRESS", address: { street: "1500 Main St", city: "Nowhere", state: "TX", zip: "75150" } }, google),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: [{ path: "address" }] });
    expect((await db().door.findUniqueOrThrow({ where: { id: door.id } })).status).toBe("NEEDS_REVIEW");

    const snap = await resolveReview(
      managerId,
      door.id,
      { action: "EDIT_ADDRESS", address: { street: "1500 Gus Thomasson Road", city: "Mesquite", state: "Texas", zip: "75150-1234" } },
      google,
    );
    expect(snap).toMatchObject({ status: "GEOCODED", addressSource: "MANUAL", address: { street: "1500 Gus Thomasson Road", state: "TX", zip: "75150" } });
    expect((await db().door.findUniqueOrThrow({ where: { id: door.id } })).streetKey).toBe("1500 gus thomasson rd");
  });

  it("closes as no visit, retries resolution, and refuses a second decision", async () => {
    const copperfield = await doorByCompany("Copperfield Learning Center");
    expect(await resolveReview(managerId, copperfield.id, { action: "NO_VISIT", note: "Online-only school" }, google)).toMatchObject({ status: "CLOSED", closedReason: "NO_VISIT" });
    await expect(resolveReview(managerId, copperfield.id, { action: "RETRY" }, google)).rejects.toMatchObject({ code: "CONFLICT" });

    const rangeway = await doorByCompany("Rangeway Security Systems");
    await expect(resolveReview(managerId, rangeway.id, { action: "CLEAR_COVERAGE_GAP" }, google)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(resolveReview(managerId, rangeway.id, { action: "ACCEPT_PLACES_CANDIDATE", candidateIndex: 0 }, google)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await resolveReview(managerId, rangeway.id, { action: "RETRY" }, google)).toMatchObject({ status: "NEW" });
    await drainJobs();
    expect(await db().door.findUniqueOrThrow({ where: { id: rangeway.id } })).toMatchObject({ status: "NEEDS_REVIEW", reviewReason: "MISSING_ADDRESS" });
  });

  it("accepts a Places candidate from the evidence", async () => {
    const door = await db().door.create({
      data: {
        externalProspectId: "MANUAL-1",
        companyId: (await db().company.findFirstOrThrow()).id,
        name: "Candidate test",
        status: "NEEDS_REVIEW",
        reviewReason: "PO_BOX",
        reviewDetail: JSON.stringify({ placesCandidates: [{ name: "X", street: "2500 Barton Springs Rd", city: "Austin", state: "TX", zip: "78704", similarity: 0.7, placeId: "pl_x", rejectedBecause: "name does not match" }] }),
      },
    });
    expect(await resolveReview(managerId, door.id, { action: "ACCEPT_PLACES_CANDIDATE", candidateIndex: 0 }, google)).toMatchObject({
      status: "GEOCODED",
      addressSource: "PLACES_MATCH",
      address: { city: "Austin" },
    });
  });
});

describe("M1: intake edge cases", () => {
  it("rejects invalid prospects with field errors, bad keys with 401, and do-not-knock companies", async () => {
    const bad = await post({ companyName: "" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(["externalProspectId", "companyName"]));

    expect((await post({ externalProspectId: "X1", companyName: "Acme", jobLocation: { city: "Dallas", state: "TX" } }, "cvs_not-a-real-key")).status).toBe(401);

    await db().doNotKnock.create({ data: { kind: "COMPANY", value: "acme" } });
    const dnk = await post({ externalProspectId: "X2", companyName: "Acme LLC", jobLocation: { city: "Dallas", state: "TX" } });
    expect(await dnk.json()).toEqual({ status: "do_not_knock" });
  });

  it("stops accepting a revoked key", async () => {
    const admin = await createUser("ADMIN");
    const k = await createApiKey(admin.id, { name: "temp", scopes: ["intake:write"] });
    await revokeApiKey(admin.id, k.id);
    expect((await post({ externalProspectId: "X3", companyName: "Acme" }, k.key)).status).toBe(401);
  });

  it("stores CRM IDs from n8n per item", async () => {
    const door = await doorByCompany("Bluebonnet Dental Group");
    const res = await crmIdsRoute(
      new NextRequest("http://canvass.test/api/v1/integrations/crm-ids", {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          items: [
            { entityType: "DOOR", id: door.id, crmId: "twenty-door-1" },
            { entityType: "COMPANY", id: door.companyId, crmId: "twenty-co-1" },
            { entityType: "REP", id: "missing", crmId: "twenty-rep-1" },
          ],
        }),
      }),
      { params: Promise.resolve({}) },
    );
    expect((await res.json()).results.map((r: { status: string }) => r.status)).toEqual(["updated", "updated", "not_found"]);
    expect((await db().door.findUniqueOrThrow({ where: { id: door.id } })).crmId).toBe("twenty-door-1");
  });
});

describe("M1: doors table and detail", () => {
  it("filters and searches", async () => {
    expect((await listDoors({ status: "NEEDS_REVIEW", limit: 50 })).items.map((d) => d.companyName)).toEqual(["Rangeway Security Systems"]);
    expect((await listDoors({ q: "preston", limit: 50 })).items.map((d) => d.companyName)).toEqual(["Bluebonnet Dental Group"]);
    expect((await listDoors({ source: "IMPORT", limit: 50 })).items.length).toBe(34);
    const page1 = await listDoors({ limit: 20 });
    const page2 = await listDoors({ limit: 20, cursor: page1.nextCursor! });
    expect(page1.items).toHaveLength(20);
    expect(page2.items.length).toBeGreaterThan(0);
    expect(new Set([...page1.items, ...page2.items].map((d) => d.id)).size).toBe(page1.items.length + page2.items.length);
  });

  it("shows a timeline from the audit log", async () => {
    const door = await doorByCompany("Red River Logistics");
    const detail = await getDoorDetail(door.id);
    expect(detail.timeline.map((t) => t.action)).toEqual(["door.created", "door.needs_review", "review.resolved"]);
    expect(detail.timeline.map((t) => t.actor)).toEqual(["API key", "Canvass", "MANAGER user"]);
  });

  it("edits priority and closes a door, cancelling nothing it should not", async () => {
    const door = await doorByCompany("Harvest Table Catering");
    expect(await updateDoor(managerId, door.id, { priority: "HOT", preferredVisitWindow: "MORNING" })).toMatchObject({ priority: "HOT", preferredVisitWindow: "MORNING" });
    expect(await closeDoor(managerId, door.id, { reason: "MANUAL", note: "Duplicate of another lead" })).toMatchObject({ status: "CLOSED", closedReason: "MANUAL" });
    await expect(closeDoor(managerId, door.id, { reason: "MANUAL" })).rejects.toMatchObject({ code: "CONFLICT" });
    // Invariant 6: a closed door has a reason and a time.
    expect(await db().door.findUniqueOrThrow({ where: { id: door.id } })).toMatchObject({ closedReason: "MANUAL", closedAt: expect.any(Date) });
  });
});
