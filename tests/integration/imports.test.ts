import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { addDoNotKnock, listDoNotKnock, removeDoNotKnock } from "@/lib/services/doNotKnock";
import { commitImport, discardImport, getImport, listImports, previewImport } from "@/lib/services/imports";
import { intakeProspect } from "@/lib/services/intake";
import { HANDLERS } from "@/worker/handlers";
import { runDueJobs } from "@/worker/runner";
import { createUser } from "./helpers";

const sample = readFileSync("tests/fixtures/sample_apify_linkedin_jobs.json", "utf8");
const SYSTEM = { type: "SYSTEM" } as const;

async function runImportJobs() {
  await db().job.updateMany({ where: { status: "QUEUED" }, data: { runAt: new Date(0) } });
  while ((await runDueJobs({ "import.commit": HANDLERS["import.commit"] }, "import-test")) > 0) {
    /* until quiet */
  }
}

describe("do-not-knock", () => {
  const prospect = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    externalProspectId: id,
    companyName: name,
    companyWebsite: `https://www.${name.toLowerCase().replaceAll(" ", "")}.example`,
    companyAddress: { street: "100 Elm Street", city: "Dallas", state: "TX", zip: "75201" },
    ...extra,
  });

  it("a company rule rejects new intake and closes its open doors (by name, with legal suffixes ignored)", async () => {
    const admin = await createUser("ADMIN");
    const a = await intakeProspect(prospect("DNK-1", "Acme Plumbing"), SYSTEM);
    const b = await intakeProspect(prospect("DNK-2", "Beta Plumbing", { companyAddress: { street: "9 Oak St", city: "Dallas", state: "TX", zip: "75202" } }), SYSTEM);
    expect(a.status).toBe("accepted");
    // The first door is assigned to someone: closing it must cancel that too.
    const rep = await createUser("REP");
    const repRow = await db().rep.findUniqueOrThrow({ where: { userId: rep.id } });
    const doorA = await db().door.findUniqueOrThrow({ where: { externalProspectId: "DNK-1" } });
    await db().assignment.create({ data: { doorId: doorA.id, repId: repRow.id, scheduledFor: "2026-10-09", assignedBy: "ENGINE", status: "ACTIVE" } });
    await db().door.update({ where: { id: doorA.id }, data: { status: "ASSIGNED" } });

    const result = await addDoNotKnock(admin.id, { kind: "COMPANY", company: "ACME Plumbing, LLC", note: "Asked us to stop" });
    expect(result).toMatchObject({ kind: "COMPANY", value: "acme plumbing", closedDoors: 1 });
    expect(await db().door.findUniqueOrThrow({ where: { id: doorA.id } })).toMatchObject({ status: "CLOSED", closedReason: "DO_NOT_KNOCK", closedAt: expect.any(Date) });
    expect(await db().assignment.findFirstOrThrow({ where: { doorId: doorA.id } })).toMatchObject({ status: "CANCELLED", reason: "Do not knock" });
    expect((await db().door.findFirstOrThrow({ where: { externalProspectId: "DNK-2" } })).status).not.toBe("CLOSED");
    expect(b.status).toBe("accepted");

    expect(await intakeProspect(prospect("DNK-3", "Acme Plumbing Inc"), SYSTEM)).toEqual({ status: "do_not_knock" });
    expect(await db().door.count({ where: { externalProspectId: "DNK-3" } })).toBe(0);
  });

  it("a website rule works by domain, even when the company name differs", async () => {
    const admin = await createUser("ADMIN");
    await intakeProspect(prospect("DNK-4", "Gamma Roofing"), SYSTEM);
    const r = await addDoNotKnock(admin.id, { kind: "COMPANY", company: "https://www.gammaroofing.example/contact" });
    expect(r).toMatchObject({ value: "gammaroofing.example", closedDoors: 1 });
    expect(await intakeProspect(prospect("DNK-5", "Gamma Roofing and Siding", { companyWebsite: "gammaroofing.example" }), SYSTEM)).toEqual({ status: "do_not_knock" });
  });

  it("an address rule matches the same street and ZIP, however it is spelled", async () => {
    const admin = await createUser("ADMIN");
    await intakeProspect(prospect("DNK-6", "Delta Dental", { companyAddress: { street: "500 North Main Street", city: "Plano", state: "TX", zip: "75074" } }), SYSTEM);
    const r = await addDoNotKnock(admin.id, { kind: "ADDRESS", street: "500 N Main St", zip: "75074-1234" });
    expect(r).toMatchObject({ kind: "ADDRESS", value: "500 n main st|75074", closedDoors: 1 });
    expect(await intakeProspect(prospect("DNK-7", "Someone Else", { companyWebsite: undefined, companyAddress: { street: "500 North Main St", city: "Plano", state: "TX", zip: "75074" } }), SYSTEM)).toEqual({ status: "do_not_knock" });
    // A different ZIP is a different address.
    expect((await intakeProspect(prospect("DNK-8", "Someone Else", { companyWebsite: undefined, companyAddress: { street: "500 North Main St", city: "Plano", state: "TX", zip: "75093" } }), SYSTEM)).status).toBe("accepted");
  });

  it("lists, rejects duplicates and bad input, and removing a rule lets new prospects in", async () => {
    const admin = await createUser("ADMIN");
    const added = await addDoNotKnock(admin.id, { kind: "COMPANY", company: "Epsilon Energy" });
    await expect(addDoNotKnock(admin.id, { kind: "COMPANY", company: "epsilon energy inc" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(addDoNotKnock(admin.id, { kind: "ADDRESS", street: "x", zip: "1" })).rejects.toThrow();
    await expect(addDoNotKnock(admin.id, { kind: "COMPANY", company: "The Inc" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" }); // nothing left after dropping legal words
    await expect(addDoNotKnock(admin.id, { kind: "NOPE" })).rejects.toThrow();
    expect((await listDoNotKnock()).find((e) => e.id === added.id)).toMatchObject({ kind: "COMPANY", label: "epsilon energy" });

    expect(await intakeProspect(prospect("DNK-9", "Epsilon Energy"), SYSTEM)).toEqual({ status: "do_not_knock" });
    await removeDoNotKnock(admin.id, added.id);
    await expect(removeDoNotKnock(admin.id, added.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await intakeProspect(prospect("DNK-9", "Epsilon Energy"), SYSTEM)).status).toBe("accepted");
    expect(await db().auditLog.count({ where: { action: { in: ["do_not_knock.added", "do_not_knock.removed"] } } })).toBeGreaterThanOrEqual(2);
  });
});

describe("imports", () => {
  // Start from an empty pipeline: the do-not-knock tests above leave doors behind.
  beforeAll(async () => {
    await db().door.deleteMany();
    await db().company.deleteMany();
    await db().job.deleteMany();
  });

  it("previews the 36-row sample without writing anything, then imports it through the worker", async () => {
    const admin = await createUser("ADMIN");
    const preview = await previewImport(admin.id, "jobs.json", sample);
    expect(preview).toMatchObject({ status: "PREVIEWED", format: "APIFY_JSON", counts: { received: 36, created: 34, duplicates: 1, merged: 1, invalid: 0, doNotKnock: 0 }, truncated: false });
    expect(preview.rows).toHaveLength(36);
    expect(preview.rows.find((r) => r.status === "duplicate")).toMatchObject({ company: "Bluebonnet Dental Group", detail: "Already imported" });
    expect(preview.rows.find((r) => r.status === "merged")?.detail).toContain("Same company and street");
    // A preview is only a preview.
    expect(await db().door.count()).toBe(0);
    expect(await db().company.count()).toBe(0);
    expect(await db().job.count({ where: { type: "address.resolve" } })).toBe(0);

    const committing = await commitImport(admin.id, preview.id);
    expect(committing.status).toBe("COMMITTING");
    await expect(commitImport(admin.id, preview.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(discardImport(admin.id, preview.id)).rejects.toMatchObject({ code: "CONFLICT" });

    await runImportJobs();
    const done = await getImport(preview.id);
    expect(done).toMatchObject({ status: "COMMITTED", counts: { received: 36, created: 34, duplicates: 1, merged: 1, invalid: 0 } });
    expect(done.committedAt).not.toBeNull();
    expect(await db().door.count()).toBe(34);
    expect(await db().job.count({ where: { type: "address.resolve" } })).toBe(34);
    expect((await db().door.findFirstOrThrow({})).source).toBe("IMPORT");
    // The parsed rows are not kept once the import is done.
    expect((await db().importBatch.findUniqueOrThrow({ where: { id: preview.id } })).payload).toBeNull();
    expect(await db().auditLog.count({ where: { entityType: "IMPORT", entityId: preview.id } })).toBe(3);
    expect((await listImports()).map((b) => b.id)).toContain(preview.id);
  });

  it("a second preview of the same file sees everything as already imported", async () => {
    const admin = await createUser("ADMIN");
    const again = await previewImport(admin.id, "jobs.json", sample);
    expect(again.counts).toMatchObject({ created: 0, duplicates: 35, merged: 1, invalid: 0 });
  });

  it("reports invalid rows and file problems with their row numbers, and counts do-not-knock rows", async () => {
    const admin = await createUser("ADMIN");
    await addDoNotKnock(admin.id, { kind: "COMPANY", company: "Blocked Co" });
    const csv = [
      "externalProspectId,companyName,street,city,state,zip,priority",
      "C-1,Fresh Co,1 Main St,Dallas,TX,75201,hot",
      ",No Id Co,2 Main St,Dallas,TX,75201,",
      "C-3,,3 Main St,Dallas,TX,75201,",
      "C-4,Blocked Co,4 Main St,Dallas,TX,75201,",
      "C-1,Fresh Co,1 Main St,Dallas,TX,75201,hot",
    ].join("\n");
    const p = await previewImport(admin.id, "mix.csv", csv);
    expect(p.format).toBe("CSV");
    expect(p.counts).toMatchObject({ received: 5, created: 1, invalid: 2, doNotKnock: 1, duplicates: 1 });
    expect(p.errors.map((e) => e.row)).toEqual([3, 4]);
    expect(p.errors[0]!.errors).toContain("externalProspectId");
    expect(p.rows.map((r) => [r.row, r.status])).toEqual([[2, "accepted"], [3, "invalid"], [4, "invalid"], [5, "do_not_knock"], [6, "duplicate"]]);

    await expect(previewImport(admin.id, "bad.csv", "name,town\nA,B\n")).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: [{ path: "file" }] });
    await expect(previewImport(admin.id, "empty.csv", "")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("commits what the preview showed, counting rule rejections without stopping", async () => {
    const admin = await createUser("ADMIN");
    const csv = ["externalProspectId,companyName,street,city,state,zip", "X-1,Xeno Co,1 Main St,Dallas,TX,75201", ",Bad Row,2 Main St,Dallas,TX,75201", "X-3,Blocked Co,4 Main St,Dallas,TX,75201"].join("\n");
    const p = await previewImport(admin.id, "x.csv", csv);
    await commitImport(admin.id, p.id);
    await runImportJobs();
    const done = await getImport(p.id);
    expect(done).toMatchObject({ status: "COMMITTED", counts: { created: 1, invalid: 1, doNotKnock: 1 } });
    expect(done.errors.map((e) => e.row)).toEqual([3]);
    expect(await db().door.count({ where: { externalProspectId: "X-1" } })).toBe(1);
  });

  it("discards an unconfirmed preview, and refuses unknown IDs", async () => {
    const admin = await createUser("ADMIN");
    const p = await previewImport(admin.id, "d.csv", "externalProspectId,companyName,city\nD-1,Discard Co,Dallas\n");
    await discardImport(admin.id, p.id);
    await expect(getImport(p.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(commitImport(admin.id, p.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("imports 500 rows in well under 2 minutes, excluding address resolution (PRD INT-5)", async () => {
    const admin = await createUser("ADMIN");
    const rows = Array.from({ length: 500 }, (_, i) => `P-${i},Bulk Company ${i},${100 + i} Commerce St,Dallas,TX,752${String(i % 100).padStart(2, "0")},morning`);
    const csv = ["externalProspectId,companyName,street,city,state,zip,preferredVisitWindow", ...rows].join("\n");
    const started = Date.now();
    const p = await previewImport(admin.id, "bulk.csv", csv);
    expect(p.counts).toMatchObject({ received: 500, created: 500, invalid: 0 });
    await commitImport(admin.id, p.id);
    await runImportJobs();
    const seconds = (Date.now() - started) / 1000;
    expect(await db().door.count({ where: { externalProspectId: { startsWith: "P-" } } })).toBe(500);
    expect((await getImport(p.id)).status).toBe("COMMITTED");
    console.log(`500-row import (preview + commit): ${seconds.toFixed(1)} s`);
    expect(seconds).toBeLessThan(120);
  }, 180_000);
});
