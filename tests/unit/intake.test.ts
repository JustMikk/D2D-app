import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { apifyJobToIntake, splitCityState } from "@/lib/domain/apify";
import { normalizeProspect, runIntake, type IntakeOutcome, type IntakeProspectInput } from "@/lib/domain/intake";
import { MemoryIntakeStore } from "./helpers/memoryIntakeStore";

const base: IntakeProspectInput = {
  externalProspectId: "P-1",
  companyName: "Bluebonnet Dental Group",
  companyWebsite: "https://www.bluebonnetdental.com/",
  companyAddress: { street: "6101 Preston Road", city: "Plano", state: "Texas", zip: "75093-1234" },
  jobLocation: { city: "Plano", state: "TX" },
  workplaceType: "on-site",
  contact: { name: "Dana Lee", phone: "(972) 555-0101", email: "Dana@Example.com" },
  priority: "hot",
  qualificationNotes: "Hiring an office manager",
  preferredVisitWindow: "morning",
};

let store: MemoryIntakeStore;
beforeEach(() => {
  store = new MemoryIntakeStore();
});

describe("normalizeProspect", () => {
  it("normalizes every field", () => {
    const r = normalizeProspect(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      companyAddress: { street: "6101 Preston Road", city: "Plano", state: "TX", zip: "75093" },
      streetKey: "6101 preston rd",
      domain: "bluebonnetdental.com",
      nameKey: "bluebonnet dental",
      jobCity: "Plano",
      jobState: "TX",
      workplaceType: "ON_SITE",
      contact: { name: "Dana Lee", phone: "+19725550101", email: "dana@example.com", linkedinUrl: null },
      priority: "HOT",
      preferredVisitWindow: "MORNING",
      source: "API",
    });
  });

  it("accepts a numeric external ID", () => {
    const r = normalizeProspect({ ...base, externalProspectId: 4002107919 });
    expect(r.ok && r.value.externalProspectId).toBe("4002107919");
  });

  it("lists validation errors by field", () => {
    const r = normalizeProspect({ companyAddress: null, jobLocation: null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const paths = r.errors.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["externalProspectId", "companyName"]));
    expect(r.errors.find((e) => e.path === "externalProspectId")?.message).toBe("Required");
  });

  it("requires a company address or a job location", () => {
    const r = normalizeProspect({ externalProspectId: "X", companyName: "Acme" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatchObject({ path: "companyAddress" });
  });

  it("rejects notes over 2000 characters", () => {
    const r = normalizeProspect({ ...base, qualificationNotes: "x".repeat(2001) });
    expect(r.ok).toBe(false);
  });
});

describe("runIntake", () => {
  it("accepts a new prospect and creates the company and door", async () => {
    const r = await runIntake(base, store);
    expect(r).toMatchObject({ status: "accepted", companyCreated: true });
    expect(store.companies).toHaveLength(1);
    expect(store.doors).toHaveLength(1);
    expect(store.doors[0]).toMatchObject({
      name: "Bluebonnet Dental Group – 6101 Preston Road",
      street: "6101 Preston Road",
      zip: "75093",
      priority: "HOT",
      status: "NEW",
    });
  });

  it("returns duplicate for a repeated external ID and changes nothing", async () => {
    const first = await runIntake(base, store);
    const second = await runIntake({ ...base, qualificationNotes: "changed" }, store);
    expect(second).toEqual({ status: "duplicate", doorId: first.status === "accepted" ? first.doorId : "" });
    expect(store.doors).toHaveLength(1);
    expect(store.doors[0]!.qualificationNotes).toBe("Hiring an office manager");
  });

  it("merges a new ID for the same company and street", async () => {
    const first = await runIntake(base, store);
    const merged = await runIntake(
      { ...base, externalProspectId: "P-2", companyAddress: { ...base.companyAddress, street: "6101 Preston Rd" }, qualificationNotes: "Hiring a hygienist" },
      store,
    );
    expect(merged.status).toBe("merged");
    expect(first.status === "accepted" && merged.status === "merged" && merged.doorId === first.doorId).toBe(true);
    expect(store.doors).toHaveLength(1);
    expect(store.doors[0]!.qualificationNotes).toBe("Hiring an office manager | Also listed: Hiring a hygienist [P-2]");
  });

  it("creates a new door for the same company at a different street", async () => {
    await runIntake(base, store);
    const r = await runIntake({ ...base, externalProspectId: "P-3", companyAddress: { ...base.companyAddress, street: "2900 Eldorado Pkwy" } }, store);
    expect(r).toMatchObject({ status: "accepted", companyCreated: false });
    expect(store.companies).toHaveLength(1);
    expect(store.doors).toHaveLength(2);
  });

  it("does not merge into a closed door", async () => {
    await runIntake(base, store);
    store.doors[0]!.status = "CLOSED";
    const r = await runIntake({ ...base, externalProspectId: "P-4" }, store);
    expect(r.status).toBe("accepted");
  });

  it("matches the company by domain even when the name differs", async () => {
    await runIntake(base, store);
    const r = await runIntake({ ...base, externalProspectId: "P-5", companyName: "Bluebonnet Smiles", companyAddress: { ...base.companyAddress, street: "1 Other St" } }, store);
    expect(r).toMatchObject({ status: "accepted", companyCreated: false });
    expect(store.companies).toHaveLength(1);
  });

  it("matches the company by name with a legal suffix", async () => {
    await runIntake({ ...base, companyWebsite: undefined }, store);
    const r = await runIntake(
      { ...base, externalProspectId: "P-6", companyName: "Bluebonnet Dental Group LLC", companyWebsite: undefined, companyAddress: { ...base.companyAddress, street: "1 Other St" } },
      store,
    );
    expect(r).toMatchObject({ status: "accepted", companyCreated: false });
  });

  it("fills blank company fields but never overwrites existing ones", async () => {
    await runIntake({ ...base, companyWebsite: undefined, companyAddress: null }, store);
    expect(store.companies[0]).toMatchObject({ website: null, street: null });
    await runIntake({ ...base, externalProspectId: "P-7", companyAddress: { ...base.companyAddress, city: "Dallas" } }, store);
    expect(store.companies[0]).toMatchObject({ website: "https://www.bluebonnetdental.com/", domain: "bluebonnetdental.com", street: "6101 Preston Road", city: "Dallas" });
    await runIntake({ ...base, externalProspectId: "P-8", companyWebsite: "https://other.example", companyAddress: { ...base.companyAddress, street: "9 New St", city: "Frisco" } }, store);
    expect(store.companies[0]).toMatchObject({ domain: "bluebonnetdental.com", city: "Dallas" });
  });

  it("rejects do-not-knock companies and addresses", async () => {
    store.doNotKnock.push({ kind: "COMPANY", value: "bluebonnetdental.com" });
    expect(await runIntake(base, store)).toEqual({ status: "do_not_knock" });
    store.doNotKnock = [{ kind: "ADDRESS", value: "6101 preston rd|75093" }];
    expect(await runIntake({ ...base, companyName: "Someone Else", companyWebsite: undefined }, store)).toEqual({ status: "do_not_knock" });
    store.doNotKnock = [{ kind: "COMPANY", value: "bluebonnet dental" }];
    expect(await runIntake({ ...base, companyWebsite: undefined }, store)).toEqual({ status: "do_not_knock" });
    expect(store.doors).toHaveLength(0);
  });

  it("returns validation errors without touching the store", async () => {
    const r = await runIntake({ companyName: "" }, store);
    expect(r.status).toBe("invalid");
    expect(store.companies).toHaveLength(0);
  });
});

describe("Apify mapping and the 36-row fixture", () => {
  const jobs = JSON.parse(readFileSync("tests/fixtures/sample_apify_linkedin_jobs.json", "utf8")) as unknown[];

  it("splits location on the last comma", () => {
    expect(splitCityState("San Diego, CA")).toEqual({ city: "San Diego", state: "CA" });
    expect(splitCityState("Winston-Salem, Forsyth, NC")).toEqual({ city: "Winston-Salem, Forsyth", state: "NC" });
  });

  it("maps a job to an intake prospect", () => {
    expect(apifyJobToIntake(jobs[0])).toMatchObject({
      externalProspectId: "4002107919",
      companyName: "Lone Star Freight Solutions",
      companyAddress: { street: "2450 Commerce St", city: "Dallas", state: "Texas", zip: "75226" },
      jobLocation: { city: "Dallas", state: "TX" },
      workplaceType: "ON_SITE",
      contact: { name: "Morgan Testerson", linkedinUrl: "https://www.linkedin.com/in/sample-recruiter-01" },
      qualificationNotes: "Hiring: Warehouse Supervisor. Posted 2026-09-17. Job: https://www.linkedin.com/jobs/view/4002107919",
      source: "IMPORT",
    });
  });

  it("imports all 36 rows: 34 accepted, 1 duplicate, 1 merged", async () => {
    const results: IntakeOutcome[] = [];
    for (const job of jobs) results.push(await runIntake(apifyJobToIntake(job), store));
    const count = (s: string) => results.filter((r) => r.status === s).length;
    expect(jobs).toHaveLength(36);
    expect({ accepted: count("accepted"), duplicate: count("duplicate"), merged: count("merged"), invalid: count("invalid") }).toEqual({
      accepted: 34,
      duplicate: 1,
      merged: 1,
      invalid: 0,
    });
    expect(store.doors).toHaveLength(34);
    const cedar = store.doors.find((d) => d.name.startsWith("Cedar Ridge"));
    expect(cedar?.qualificationNotes).toContain("[4002131677]");
  });
});
