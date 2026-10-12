// Reading an uploaded import file (PRD INT-5, backend spec §10.5): Apify LinkedIn job JSON, or a CSV in the
// layout of the downloadable template. Pure: the result is a list of intake rows plus per-row problems.
// The same intake rules then apply as for the API.
import { apifyJobToIntake } from "./apify";
import type { IntakeProspectInput } from "./intake";
import { str } from "./normalize";

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 2000;

export type ImportFormat = "APIFY_JSON" | "CSV";
export type ParseProblem = { row: number; message: string };
export type ParsedImport = { format: ImportFormat; rows: { row: number; input: IntakeProspectInput }[]; problems: ParseProblem[] };

/** RFC 4180: commas, quoted fields, doubled quotes inside quotes, newlines inside quotes. A BOM is ignored. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

/** The template's columns, in order. Header matching ignores case, spaces and underscores. */
export const CSV_COLUMNS = [
  "externalProspectId",
  "companyName",
  "companyWebsite",
  "street",
  "city",
  "state",
  "zip",
  "jobCity",
  "jobState",
  "workplaceType",
  "contactName",
  "contactPhone",
  "contactEmail",
  "contactLinkedinUrl",
  "priority",
  "qualificationNotes",
  "preferredVisitWindow",
] as const;
type Column = (typeof CSV_COLUMNS)[number];

const squash = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
const COLUMN_BY_NAME = new Map<string, Column>(CSV_COLUMNS.map((c) => [squash(c), c]));
const ALIASES: Record<string, Column> = { id: "externalProspectId", prospectid: "externalProspectId", company: "companyName", website: "companyWebsite", address: "street", streetaddress: "street", postalcode: "zip", zipcode: "zip", notes: "qualificationNotes", phone: "contactPhone", email: "contactEmail" };

export function csvTemplate(): string {
  const example = ["P-1001", "Bluebonnet Dental Group", "https://bluebonnetdental.com", "6101 Preston Rd", "Plano", "TX", "75093", "Plano", "TX", "on-site", "Dana Lee", "(972) 555-0101", "dana@example.com", "", "normal", "Hiring an office manager", "morning"];
  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  return `${CSV_COLUMNS.join(",")}\n${example.map(quote).join(",")}\n`;
}

function csvRowToIntake(get: (c: Column) => string): IntakeProspectInput {
  const opt = (c: Column) => str(get(c)) || undefined;
  const street = opt("street");
  const city = opt("city");
  const state = opt("state");
  const zip = opt("zip");
  const jobCity = opt("jobCity");
  return {
    externalProspectId: str(get("externalProspectId")),
    companyName: str(get("companyName")),
    companyWebsite: opt("companyWebsite"),
    companyAddress: street || city || state || zip ? { street, city, state, zip } : null,
    jobLocation: jobCity ? { city: jobCity, state: opt("jobState") } : null,
    workplaceType: opt("workplaceType"),
    contact: { name: opt("contactName"), phone: opt("contactPhone"), email: opt("contactEmail"), linkedinUrl: opt("contactLinkedinUrl") },
    priority: (opt("priority") as IntakeProspectInput["priority"]) ?? undefined,
    qualificationNotes: opt("qualificationNotes"),
    preferredVisitWindow: (opt("preferredVisitWindow")?.toLowerCase() as IntakeProspectInput["preferredVisitWindow"]) ?? undefined,
    source: "IMPORT",
  };
}

function parseCsvImport(text: string): ParsedImport {
  const table = parseCsv(text);
  const header = table[0];
  if (!header) return { format: "CSV", rows: [], problems: [{ row: 0, message: "The file is empty." }] };
  const index = new Map<Column, number>();
  header.forEach((h, i) => {
    const key = squash(h);
    const col = COLUMN_BY_NAME.get(key) ?? ALIASES[key];
    if (col && !index.has(col)) index.set(col, i);
  });
  const missing = (["externalProspectId", "companyName"] as Column[]).filter((c) => !index.has(c));
  if (missing.length) {
    return { format: "CSV", rows: [], problems: [{ row: 0, message: `The first row must name these columns: ${missing.join(", ")}. Download the template for the layout.` }] };
  }
  const rows: ParsedImport["rows"] = [];
  table.slice(1).forEach((cells, i) => {
    rows.push({ row: i + 2, input: csvRowToIntake((c) => cells[index.get(c) ?? -1] ?? "") }); // row numbers match the spreadsheet
  });
  return { format: "CSV", rows, problems: [] };
}

function parseApifyImport(text: string): ParsedImport {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { format: "APIFY_JSON", rows: [], problems: [{ row: 0, message: "That isn't valid JSON." }] };
  }
  const list = Array.isArray(data) ? data : Array.isArray((data as { items?: unknown })?.items) ? (data as { items: unknown[] }).items : null;
  if (!list) return { format: "APIFY_JSON", rows: [], problems: [{ row: 0, message: "Expected a list of jobs (an array, or an object with an items array)." }] };
  const problems: ParseProblem[] = [];
  const rows: ParsedImport["rows"] = [];
  list.forEach((job, i) => {
    if (typeof job !== "object" || job === null) return void problems.push({ row: i + 1, message: "Not a job object." });
    rows.push({ row: i + 1, input: apifyJobToIntake(job) });
  });
  return { format: "APIFY_JSON", rows, problems };
}

/** Detect the format (by extension, then by content) and map every row to intake input. */
export function parseImportFile(filename: string, text: string): ParsedImport {
  if (text.length > MAX_IMPORT_BYTES) return { format: "CSV", rows: [], problems: [{ row: 0, message: "The file is over 5 MB." }] };
  const looksJson = /\.json$/i.test(filename) || /^\s*[[{]/.test(text);
  const parsed = looksJson ? parseApifyImport(text) : parseCsvImport(text);
  if (parsed.rows.length > MAX_IMPORT_ROWS) {
    return { ...parsed, rows: [], problems: [{ row: 0, message: `That file has ${parsed.rows.length} rows. Import at most ${MAX_IMPORT_ROWS} at a time.` }] };
  }
  return parsed;
}
