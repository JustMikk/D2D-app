// Intake service (backend spec §6.2, PRD INT-1 to INT-4, INT-6): runs the domain pipeline against Prisma
// in one transaction, then enqueues address resolution and emits events (step 7).
import { audit, type Actor } from "@/lib/api/audit";
import { db, type Db } from "@/lib/db";
import { runIntake, type IntakeOutcome, type IntakeStore } from "@/lib/domain/intake";
import { doorSnapshot, emit } from "@/lib/events";
import { enqueue } from "@/lib/jobs";

const COMPANY_SELECT = { id: true, name: true, nameKey: true, website: true, domain: true, street: true, city: true, state: true, zip: true } as const;

export function prismaIntakeStore(tx: Db): IntakeStore {
  return {
    async isDoNotKnock({ companyValues, addressValue }) {
      const or = [
        ...(companyValues.length ? [{ kind: "COMPANY", value: { in: companyValues } }] : []),
        ...(addressValue ? [{ kind: "ADDRESS", value: addressValue }] : []),
      ];
      if (or.length === 0) return false;
      return (await tx.doNotKnock.count({ where: { OR: or } })) > 0;
    },
    async findDoorIdByExternalId(externalProspectId) {
      return (await tx.door.findUnique({ where: { externalProspectId }, select: { id: true } }))?.id ?? null;
    },
    async findCompanyByDomain(domain) {
      return tx.company.findFirst({ where: { domain }, select: COMPANY_SELECT, orderBy: { createdAt: "asc" } });
    },
    async findCompanyByNameKey(nameKey) {
      return tx.company.findFirst({ where: { nameKey }, select: COMPANY_SELECT, orderBy: { createdAt: "asc" } });
    },
    async createCompany(data) {
      return tx.company.create({ data, select: COMPANY_SELECT });
    },
    async updateCompany(id, patch) {
      await tx.company.update({ where: { id }, data: patch });
    },
    async findOpenDoorByStreetKey(companyId, streetKey) {
      return tx.door.findFirst({
        where: { companyId, streetKey, status: { not: "CLOSED" } },
        select: { id: true, qualificationNotes: true },
        orderBy: { createdAt: "asc" },
      });
    },
    async updateDoorNotes(doorId, qualificationNotes) {
      await tx.door.update({ where: { id: doorId }, data: { qualificationNotes } });
    },
    async createDoor(data) {
      return tx.door.create({ data: { ...data, status: "NEW" }, select: { id: true } });
    },
  };
}

/** Intake one prospect. Validation errors come back as { status: "invalid" } for the caller to map. */
export async function intakeProspect(input: unknown, actor: Actor, now = new Date()): Promise<IntakeOutcome> {
  return db().$transaction(async (tx) => {
    const outcome = await runIntake(input, prismaIntakeStore(tx));
    if (outcome.status === "accepted") {
      await enqueue(tx, "address.resolve", { doorId: outcome.doorId }, { dedupeKey: `resolve:${outcome.doorId}` });
      const snapshot = await doorSnapshot(tx, outcome.doorId);
      await emit(tx, "door.created", { door: snapshot }, now);
      await emit(tx, "door.upserted", { door: snapshot }, now);
      await audit(tx, actor, "door.created", "DOOR", outcome.doorId, { externalProspectId: snapshot.externalProspectId, companyCreated: outcome.companyCreated });
    } else if (outcome.status === "merged") {
      await emit(tx, "door.upserted", { door: await doorSnapshot(tx, outcome.doorId) }, now);
      await audit(tx, actor, "door.merged", "DOOR", outcome.doorId, { input: typeof input === "object" && input ? (input as { externalProspectId?: unknown }).externalProspectId : null });
    }
    return outcome;
  });
}
