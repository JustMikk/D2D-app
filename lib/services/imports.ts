// Imports (PRD INT-5, MGR-9): upload, preview the counts, confirm. The preview applies the real intake rules
// without writing anything; the commit runs them for real, one prospect at a time, in the worker.
import { audit, userActor } from "@/lib/api/audit";
import { conflict, notFound, validationFailed } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { parseImportFile } from "@/lib/domain/importFile";
import { runIntake, type CompanyRecord, type IntakeOutcome, type IntakeProspectInput, type IntakeStore, type NewCompany, type NewDoor, type ValidationIssue } from "@/lib/domain/intake";
import { enqueue } from "@/lib/jobs";
import { intakeProspect, prismaIntakeStore } from "./intake";

export type RowOutcome = { row: number; company: string; status: IntakeOutcome["status"]; detail: string | null };
export type Counts = { received: number; created: number; duplicates: number; merged: number; invalid: number; doNotKnock: number };

const SAMPLE_LIMIT = 200;

/**
 * The intake store for a dry run: reads see the real database, writes go to memory only. A row that repeats an
 * earlier row of the same file is then a duplicate (or a merge), exactly as it would be after the real import.
 */
class DryRunStore implements IntakeStore {
  private readonly real = prismaIntakeStore(db());
  private companies: CompanyRecord[] = [];
  private doors: { id: string; externalProspectId: string; companyId: string; streetKey: string | null }[] = [];
  private seq = 0;

  isDoNotKnock(keys: Parameters<IntakeStore["isDoNotKnock"]>[0]) {
    return this.real.isDoNotKnock(keys);
  }
  async findDoorIdByExternalId(id: string) {
    return this.doors.find((d) => d.externalProspectId === id)?.id ?? (await this.real.findDoorIdByExternalId(id));
  }
  async findCompanyByDomain(domain: string) {
    return this.companies.find((c) => c.domain === domain) ?? (await this.real.findCompanyByDomain(domain));
  }
  async findCompanyByNameKey(nameKey: string) {
    return this.companies.find((c) => c.nameKey === nameKey) ?? (await this.real.findCompanyByNameKey(nameKey));
  }
  async createCompany(data: NewCompany) {
    const company = { ...data, id: `dry-company-${++this.seq}` };
    this.companies.push(company);
    return company;
  }
  async updateCompany() {
    // A blank field being filled in is not worth showing in a preview.
  }
  async findOpenDoorByStreetKey(companyId: string, streetKey: string) {
    const mine = this.doors.find((d) => d.companyId === companyId && d.streetKey === streetKey);
    return mine ? { id: mine.id, qualificationNotes: "" } : this.real.findOpenDoorByStreetKey(companyId, streetKey);
  }
  async updateDoorNotes() {
    // Not written in a preview.
  }
  async createDoor(data: NewDoor) {
    const door = { id: `dry-door-${++this.seq}`, externalProspectId: data.externalProspectId, companyId: data.companyId, streetKey: data.streetKey };
    this.doors.push(door);
    return { id: door.id };
  }
}

function describe(outcome: IntakeOutcome): string | null {
  if (outcome.status === "invalid") return outcome.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
  if (outcome.status === "do_not_knock") return "On the do-not-knock list";
  if (outcome.status === "duplicate") return "Already imported";
  if (outcome.status === "merged") return "Same company and street as an existing door";
  return null;
}

export function tally(outcomes: { status: IntakeOutcome["status"] }[]): Omit<Counts, "received"> {
  const n = (s: IntakeOutcome["status"]) => outcomes.filter((o) => o.status === s).length;
  return { created: n("accepted"), duplicates: n("duplicate"), merged: n("merged"), invalid: n("invalid"), doNotKnock: n("do_not_knock") };
}

type StoredRow = { row: number; input: IntakeProspectInput };

export async function previewImport(actorUserId: string, filename: string, text: string) {
  const parsed = parseImportFile(filename, text);
  if (parsed.rows.length === 0) {
    throw validationFailed(parsed.problems.map((p) => ({ path: p.row === 0 ? "file" : `row ${p.row}`, message: p.message })), parsed.problems[0]?.message ?? "There are no rows to import.");
  }

  const store = new DryRunStore();
  const outcomes: RowOutcome[] = [];
  for (const { row, input } of parsed.rows) {
    const outcome = await runIntake(input, store);
    outcomes.push({ row, company: String((input as { companyName?: unknown }).companyName ?? ""), status: outcome.status, detail: describe(outcome) });
  }
  const counts: Counts = { received: parsed.rows.length + parsed.problems.length, ...tally(outcomes) };
  counts.invalid += parsed.problems.length;
  const errors = [
    ...parsed.problems.map((p) => ({ row: p.row, errors: p.message })),
    ...outcomes.filter((o) => o.status === "invalid").map((o) => ({ row: o.row, errors: o.detail })),
  ].slice(0, SAMPLE_LIMIT);

  const batch = await db().importBatch.create({
    data: {
      filename: filename.slice(0, 200),
      format: parsed.format,
      status: "PREVIEWED",
      ...counts,
      errors: JSON.stringify(errors),
      payload: JSON.stringify(parsed.rows satisfies StoredRow[]),
      createdById: actorUserId,
    },
  });
  await audit(db(), userActor(actorUserId), "import.previewed", "IMPORT", batch.id, { filename, ...counts });
  return { ...batchView(batch), rows: outcomes.slice(0, SAMPLE_LIMIT), truncated: outcomes.length > SAMPLE_LIMIT };
}

function batchView(b: { id: string; filename: string; format: string; status: string; received: number; created: number; duplicates: number; merged: number; invalid: number; doNotKnock: number; errors: string | null; createdAt: Date; committedAt: Date | null; createdBy?: { name: string } }) {
  return {
    id: b.id,
    filename: b.filename,
    format: b.format,
    status: b.status,
    counts: { received: b.received, created: b.created, duplicates: b.duplicates, merged: b.merged, invalid: b.invalid, doNotKnock: b.doNotKnock } satisfies Counts,
    errors: (b.errors ? (JSON.parse(b.errors) as { row: number; errors: string | null }[]) : []) as { row: number; errors: string | null }[],
    createdAt: b.createdAt,
    committedAt: b.committedAt,
    createdBy: b.createdBy?.name ?? null,
  };
}

export async function listImports() {
  const rows = await db().importBatch.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { createdBy: { select: { name: true } } } });
  return rows.map(batchView);
}

export async function getImport(id: string) {
  const b = await db().importBatch.findUnique({ where: { id }, include: { createdBy: { select: { name: true } } } });
  if (!b) throw notFound("That import");
  return batchView(b);
}

export async function commitImport(actorUserId: string, id: string) {
  const claimed = await db().importBatch.updateMany({ where: { id, status: "PREVIEWED" }, data: { status: "COMMITTING" } });
  if (claimed.count !== 1) {
    if (!(await db().importBatch.findUnique({ where: { id }, select: { id: true } }))) throw notFound("That import");
    throw conflict("This import was already confirmed.");
  }
  await enqueue(db(), "import.commit", { batchId: id }, { dedupeKey: `import:${id}` });
  await audit(db(), userActor(actorUserId), "import.confirmed", "IMPORT", id);
  return getImport(id);
}

/** Throw away a preview that was never confirmed. */
export async function discardImport(actorUserId: string, id: string) {
  const removed = await db().importBatch.deleteMany({ where: { id, status: "PREVIEWED" } });
  if (removed.count !== 1) throw conflict("Only an import that has not been confirmed can be discarded.");
  await audit(db(), userActor(actorUserId), "import.discarded", "IMPORT", id);
  return { id };
}

const MAX_COMMIT_ATTEMPTS = 5;

/**
 * Run the real intake for each previewed row (the worker's import.commit job). Safe to run again after a crash:
 * rows already created are recognised as duplicates. Rows the rules reject are counted, not fatal; anything
 * unexpected stops the job so it retries, and after the last try the batch is marked FAILED.
 */
export async function runImportCommit(batchId: string, attempt: number, now = new Date()): Promise<Counts | null> {
  const batch = await db().importBatch.findUnique({ where: { id: batchId } });
  if (!batch || batch.status !== "COMMITTING" || !batch.payload) return null;
  const rows = JSON.parse(batch.payload) as StoredRow[];
  const actor = userActor(batch.createdById);
  const outcomes: { status: IntakeOutcome["status"] }[] = [];
  const errors: { row: number; errors: string | null }[] = [];

  try {
    for (const { row, input } of rows) {
      const outcome = await intakeProspect(input, actor, now);
      outcomes.push(outcome);
      if (outcome.status === "invalid") errors.push({ row, errors: (outcome.errors as ValidationIssue[]).map((e) => `${e.path}: ${e.message}`).join("; ") });
    }
  } catch (error) {
    if (attempt >= MAX_COMMIT_ATTEMPTS) {
      await db().importBatch.update({ where: { id: batchId }, data: { status: "FAILED", errors: JSON.stringify([{ row: 0, errors: error instanceof Error ? error.message : String(error) }]), payload: null } });
    }
    throw error;
  }

  const counts: Counts = { received: batch.received, ...tally(outcomes) };
  // Rows that never reached intake (file problems found at preview) stay counted as invalid.
  counts.invalid += batch.received - rows.length;
  const previous = batch.errors ? (JSON.parse(batch.errors) as { row: number; errors: string | null }[]).filter((e) => e.row === 0 || !rows.some((r) => r.row === e.row)) : [];
  await db().$transaction(async (tx) => {
    await tx.importBatch.update({
      where: { id: batchId },
      data: { status: "COMMITTED", ...counts, errors: JSON.stringify([...previous, ...errors].slice(0, SAMPLE_LIMIT)), payload: null, committedAt: now },
    });
    await audit(tx, actor, "import.committed", "IMPORT", batchId, counts);
  });
  return counts;
}

