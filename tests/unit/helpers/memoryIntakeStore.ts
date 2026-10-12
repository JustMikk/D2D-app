// In-memory IntakeStore for unit tests. Mirrors what services/intake.ts does with Prisma.
import type { CompanyRecord, IntakeStore, NewCompany, NewDoor } from "@/lib/domain/intake";

export type MemoryDoor = NewDoor & { id: string; status: string };

export class MemoryIntakeStore implements IntakeStore {
  companies: CompanyRecord[] = [];
  doors: MemoryDoor[] = [];
  doNotKnock: { kind: "COMPANY" | "ADDRESS"; value: string }[] = [];
  private seq = 0;

  private id(prefix: string) {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  async isDoNotKnock(keys: { companyValues: string[]; addressValue: string | null }) {
    return this.doNotKnock.some(
      (d) =>
        (d.kind === "COMPANY" && keys.companyValues.includes(d.value)) ||
        (d.kind === "ADDRESS" && keys.addressValue !== null && d.value === keys.addressValue),
    );
  }

  async findDoorIdByExternalId(externalProspectId: string) {
    return this.doors.find((d) => d.externalProspectId === externalProspectId)?.id ?? null;
  }

  async findCompanyByDomain(domain: string) {
    return this.companies.find((c) => c.domain === domain) ?? null;
  }

  async findCompanyByNameKey(nameKey: string) {
    return this.companies.find((c) => c.nameKey === nameKey) ?? null;
  }

  async createCompany(data: NewCompany) {
    const company = { ...data, id: this.id("co") };
    this.companies.push(company);
    return company;
  }

  async updateCompany(id: string, patch: Partial<NewCompany>) {
    const company = this.companies.find((c) => c.id === id);
    if (company) Object.assign(company, patch);
  }

  async findOpenDoorByStreetKey(companyId: string, streetKey: string) {
    const door = this.doors.find((d) => d.companyId === companyId && d.streetKey === streetKey && d.status !== "CLOSED");
    return door ? { id: door.id, qualificationNotes: door.qualificationNotes } : null;
  }

  async updateDoorNotes(doorId: string, qualificationNotes: string) {
    const door = this.doors.find((d) => d.id === doorId);
    if (door) door.qualificationNotes = qualificationNotes;
  }

  async createDoor(data: NewDoor) {
    const door = { ...data, id: this.id("door"), status: "NEW" };
    this.doors.push(door);
    return { id: door.id };
  }
}
