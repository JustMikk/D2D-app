import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { csvTemplate, MAX_IMPORT_ROWS, parseCsv, parseImportFile } from "@/lib/domain/importFile";
import { normalizeProspect } from "@/lib/domain/intake";

describe("parseCsv", () => {
  it("handles quotes, doubled quotes, commas and newlines inside fields, CRLF and a BOM", () => {
    const text = '﻿a,b,c\r\n1,"two, with comma","say ""hi"""\r\n"line\nbreak",,x\r\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b", "c"],
      ["1", "two, with comma", 'say "hi"'],
      ["line\nbreak", "", "x"],
    ]);
  });
  it("skips blank lines and keeps a last row with no trailing newline", () => {
    expect(parseCsv("a,b\n\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("")).toEqual([]);
  });
});

describe("CSV imports", () => {
  it("maps the template layout to intake rows, with spreadsheet row numbers", () => {
    const parsed = parseImportFile("prospects.csv", csvTemplate());
    expect(parsed).toMatchObject({ format: "CSV", problems: [] });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.row).toBe(2);
    const normalized = normalizeProspect(parsed.rows[0]!.input);
    expect(normalized.ok && normalized.value).toMatchObject({
      externalProspectId: "P-1001",
      companyName: "Bluebonnet Dental Group",
      domain: "bluebonnetdental.com",
      companyAddress: { street: "6101 Preston Rd", city: "Plano", state: "TX", zip: "75093" },
      jobCity: "Plano",
      workplaceType: "ON_SITE",
      contact: { phone: "+19725550101", email: "dana@example.com" },
      preferredVisitWindow: "MORNING",
      source: "IMPORT",
    });
  });

  it("accepts headers in any case or spacing, and common aliases, in any order", () => {
    const csv = "Company Name,ID,Address,City,State,ZIP Code\nAcme Co,A-1,1 Main St,Dallas,Texas,75201\n";
    const parsed = parseImportFile("x.csv", csv);
    const n = normalizeProspect(parsed.rows[0]!.input);
    expect(n.ok && n.value).toMatchObject({ externalProspectId: "A-1", companyName: "Acme Co", companyAddress: { street: "1 Main St", state: "TX", zip: "75201" } });
  });

  it("explains a file without the required columns", () => {
    const parsed = parseImportFile("x.csv", "name,town\nAcme,Dallas\n");
    expect(parsed.rows).toEqual([]);
    expect(parsed.problems[0]!.message).toContain("externalProspectId, companyName");
    expect(parseImportFile("x.csv", "").problems[0]!.message).toBe("The file is empty.");
  });

  it("leaves bad rows for intake to report, and keeps their row numbers", () => {
    const parsed = parseImportFile("x.csv", "externalProspectId,companyName,city\nA-1,,Dallas\nA-2,Beta Co,Plano\n");
    expect(parsed.rows.map((r) => r.row)).toEqual([2, 3]);
    expect(normalizeProspect(parsed.rows[0]!.input).ok).toBe(false);
    // A company city alone is enough to enter; address resolution then sends it to review.
    expect(normalizeProspect(parsed.rows[1]!.input).ok).toBe(true);
  });
});

describe("Apify imports", () => {
  const sample = readFileSync("tests/fixtures/sample_apify_linkedin_jobs.json", "utf8");

  it("reads the 36-row sample as a JSON array, by name or by content", () => {
    for (const name of ["jobs.json", "export.txt"]) {
      const parsed = parseImportFile(name, sample);
      expect(parsed).toMatchObject({ format: "APIFY_JSON", problems: [] });
      expect(parsed.rows).toHaveLength(36);
    }
  });

  it("also reads an object with an items array, and rejects anything else", () => {
    expect(parseImportFile("a.json", JSON.stringify({ items: [{ id: "1", companyName: "Acme", location: { abbreviatedLocalizedName: "Dallas, TX" } }] })).rows).toHaveLength(1);
    expect(parseImportFile("a.json", "{not json").problems[0]!.message).toBe("That isn't valid JSON.");
    expect(parseImportFile("a.json", '{"a":1}').problems[0]!.message).toContain("Expected a list of jobs");
    expect(parseImportFile("a.json", '[1,"x",{"id":"2"}]').problems).toEqual([{ row: 1, message: "Not a job object." }, { row: 2, message: "Not a job object." }]);
  });

  it("refuses files that are too big or have too many rows", () => {
    expect(parseImportFile("big.csv", "x".repeat(5 * 1024 * 1024 + 1)).problems[0]!.message).toBe("The file is over 5 MB.");
    const many = "externalProspectId,companyName\n" + Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `${i},Co ${i}`).join("\n");
    expect(parseImportFile("many.csv", many).problems[0]!.message).toContain(`Import at most ${MAX_IMPORT_ROWS}`);
  });
});
