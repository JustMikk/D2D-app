// Intake pipeline (backend spec §6.2, PRD INT-1 to INT-4 and INT-6).
// The decision logic runs against an IntakeStore port. services/intake.ts implements the port with
// Prisma inside one transaction; tests use an in-memory store.
import { z } from "zod";
import type { DoorSource, Priority, VisitWindow, WorkplaceType } from "./enums";
import { companyKey, domainOf, phoneE164, state2, str, streetKey, workplaceType, zip5 } from "./normalize";

// ---------------------------------------------------------------------------
// Input schema (backend spec §10.4)
// ---------------------------------------------------------------------------

const optionalText = z.string().trim().optional().nullable();

export const IntakeProspectSchema = z
  .object({
    // Numeric IDs (Apify uses strings, other sources may not) are accepted and stringified.
    externalProspectId: z.preprocess(
      (v) => (typeof v === "number" ? String(v) : v),
      z.string({ error: "Required" }).trim().min(1, "Required").max(100),
    ),
    companyName: z.string({ error: "Required" }).trim().min(1, "Required"),
    companyWebsite: optionalText,
    companyAddress: z
      .object({ street: optionalText, city: optionalText, state: optionalText, zip: z.coerce.string().optional().nullable() })
      .optional()
      .nullable(),
    jobLocation: z.object({ city: optionalText, state: optionalText }).optional().nullable(),
    workplaceType: optionalText,
    contact: z
      .object({ name: optionalText, phone: z.coerce.string().optional().nullable(), email: optionalText, linkedinUrl: optionalText })
      .optional()
      .nullable(),
    priority: z.enum(["normal", "hot", "NORMAL", "HOT"]).optional().nullable(),
    qualificationNotes: z.string().max(2000).optional().nullable(),
    preferredVisitWindow: z
      .enum(["morning", "afternoon", "evening", "MORNING", "AFTERNOON", "EVENING"])
      .optional()
      .nullable(),
    source: z.enum(["API", "IMPORT"]).optional().nullable(),
  })
  .superRefine((p, ctx) => {
    const hasCompanyAddress = Boolean(str(p.companyAddress?.street) || str(p.companyAddress?.city));
    const hasJobLocation = Boolean(str(p.jobLocation?.city));
    if (!hasCompanyAddress && !hasJobLocation) {
      ctx.addIssue({ code: "custom", path: ["companyAddress"], message: "Provide a company address or a job location" });
    }
  });

export type IntakeProspectInput = z.input<typeof IntakeProspectSchema>;

export type ValidationIssue = { path: string; message: string };

export type Address = { street: string; city: string; state: string; zip: string };

export type NormalizedProspect = {
  externalProspectId: string;
  companyName: string;
  companyWebsite: string | null;
  domain: string | null;
  nameKey: string;
  companyAddress: Address;
  streetKey: string | null;
  jobCity: string | null;
  jobState: string | null;
  workplaceType: WorkplaceType;
  contact: { name: string | null; phone: string | null; email: string | null; linkedinUrl: string | null };
  priority: Priority;
  qualificationNotes: string;
  preferredVisitWindow: VisitWindow | null;
  source: DoorSource;
};

function orNull(v: unknown): string | null {
  const s = str(v);
  return s ? s : null;
}

/** Validate and normalize one prospect. */
export function normalizeProspect(
  input: unknown,
): { ok: true; value: NormalizedProspect } | { ok: false; errors: ValidationIssue[] } {
  const parsed = IntakeProspectSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message })),
    };
  }
  const p = parsed.data;
  const street = str(p.companyAddress?.street);
  const website = orNull(p.companyWebsite);
  const email = orNull(p.contact?.email);
  return {
    ok: true,
    value: {
      externalProspectId: p.externalProspectId,
      companyName: p.companyName,
      companyWebsite: website,
      domain: domainOf(website),
      nameKey: companyKey(p.companyName),
      companyAddress: {
        street,
        city: str(p.companyAddress?.city),
        state: state2(p.companyAddress?.state),
        zip: zip5(p.companyAddress?.zip),
      },
      streetKey: street ? streetKey(street) : null,
      jobCity: orNull(p.jobLocation?.city),
      jobState: orNull(state2(p.jobLocation?.state)),
      workplaceType: workplaceType(p.workplaceType),
      contact: {
        name: orNull(p.contact?.name),
        phone: phoneE164(p.contact?.phone),
        email: email ? email.toLowerCase() : null,
        linkedinUrl: orNull(p.contact?.linkedinUrl),
      },
      priority: p.priority?.toUpperCase() === "HOT" ? "HOT" : "NORMAL",
      qualificationNotes: str(p.qualificationNotes),
      preferredVisitWindow: (p.preferredVisitWindow?.toUpperCase() as VisitWindow | undefined) ?? null,
      source: p.source ?? "API",
    },
  };
}

// ---------------------------------------------------------------------------
// Store port
// ---------------------------------------------------------------------------

export type CompanyRecord = {
  id: string;
  name: string;
  nameKey: string;
  website: string | null;
  domain: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
};

export type NewCompany = Omit<CompanyRecord, "id">;

export type NewDoor = {
  externalProspectId: string;
  source: DoorSource;
  companyId: string;
  name: string;
  priority: Priority;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  streetKey: string | null;
  jobCity: string | null;
  jobState: string | null;
  workplaceType: WorkplaceType;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  contactLinkedinUrl: string | null;
  qualificationNotes: string;
  preferredVisitWindow: VisitWindow | null;
};

export interface IntakeStore {
  /** True when any value matches a DoNotKnock row of that kind. */
  isDoNotKnock(keys: { companyValues: string[]; addressValue: string | null }): Promise<boolean>;
  findDoorIdByExternalId(externalProspectId: string): Promise<string | null>;
  findCompanyByDomain(domain: string): Promise<CompanyRecord | null>;
  findCompanyByNameKey(nameKey: string): Promise<CompanyRecord | null>;
  createCompany(data: NewCompany): Promise<CompanyRecord>;
  updateCompany(id: string, patch: Partial<NewCompany>): Promise<void>;
  /** An open (not CLOSED) door of this company at this street key. */
  findOpenDoorByStreetKey(companyId: string, streetKey: string): Promise<{ id: string; qualificationNotes: string } | null>;
  updateDoorNotes(doorId: string, qualificationNotes: string): Promise<void>;
  createDoor(data: NewDoor): Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export type IntakeOutcome =
  | { status: "accepted"; doorId: string; companyId: string; companyCreated: boolean }
  | { status: "duplicate"; doorId: string }
  | { status: "merged"; doorId: string }
  | { status: "do_not_knock" }
  | { status: "invalid"; errors: ValidationIssue[] };

/** The DoNotKnock value for an address: "streetKey|zip". */
export function addressDoNotKnockValue(streetKeyValue: string | null, zip: string): string | null {
  return streetKeyValue && zip ? `${streetKeyValue}|${zip}` : null;
}

/** The note appended to an existing door when a new posting merges into it. */
export function mergedNote(existing: string, p: Pick<NormalizedProspect, "qualificationNotes" | "externalProspectId">): string {
  return `${existing} | Also listed: ${p.qualificationNotes} [${p.externalProspectId}]`;
}

/** "Company – street" display name; falls back to the job city, then the company alone. */
export function doorDisplayName(p: Pick<NormalizedProspect, "companyName" | "companyAddress" | "jobCity">): string {
  const where = p.companyAddress.street || p.jobCity;
  return where ? `${p.companyName} – ${where}` : p.companyName;
}

function blankFill(company: CompanyRecord, p: NormalizedProspect): Partial<NewCompany> {
  const patch: Partial<NewCompany> = {};
  const fill = <K extends keyof NewCompany>(key: K, value: NewCompany[K]) => {
    if ((company[key] === null || company[key] === "") && value !== null && value !== "") patch[key] = value;
  };
  fill("website", p.companyWebsite);
  fill("domain", p.domain);
  fill("street", p.companyAddress.street || null);
  fill("city", p.companyAddress.city || null);
  fill("state", p.companyAddress.state || null);
  fill("zip", p.companyAddress.zip || null);
  return patch;
}

/**
 * Steps 1–6 of the intake pipeline. The caller runs it in a transaction and, on "accepted",
 * enqueues address.resolve and emits door.created and door.upserted (step 7).
 */
export async function runIntake(input: unknown, store: IntakeStore): Promise<IntakeOutcome> {
  const normalized = normalizeProspect(input);
  if (!normalized.ok) return { status: "invalid", errors: normalized.errors };
  const p = normalized.value;

  // 2. Do-not-knock: company key or domain; street key plus ZIP.
  const companyValues = [p.nameKey, p.domain].filter((v): v is string => Boolean(v));
  const addressValue = addressDoNotKnockValue(p.streetKey, p.companyAddress.zip);
  if (await store.isDoNotKnock({ companyValues, addressValue })) return { status: "do_not_knock" };

  // 3. Same external ID: nothing changes.
  const existingDoorId = await store.findDoorIdByExternalId(p.externalProspectId);
  if (existingDoorId) return { status: "duplicate", doorId: existingDoorId };

  // 4. Company: by domain, then by normalized name; otherwise create. Only blank fields are filled.
  let company = (p.domain ? await store.findCompanyByDomain(p.domain) : null) ?? (await store.findCompanyByNameKey(p.nameKey));
  let companyCreated = false;
  if (company) {
    const patch = blankFill(company, p);
    if (Object.keys(patch).length > 0) await store.updateCompany(company.id, patch);
  } else {
    company = await store.createCompany({
      name: p.companyName,
      nameKey: p.nameKey,
      website: p.companyWebsite,
      domain: p.domain,
      street: p.companyAddress.street || null,
      city: p.companyAddress.city || null,
      state: p.companyAddress.state || null,
      zip: p.companyAddress.zip || null,
    });
    companyCreated = true;
  }

  // 5. Same company at the same street: merge into the open door.
  if (p.streetKey) {
    const open = await store.findOpenDoorByStreetKey(company.id, p.streetKey);
    if (open) {
      await store.updateDoorNotes(open.id, mergedNote(open.qualificationNotes, p));
      return { status: "merged", doorId: open.id };
    }
  }

  // 6. Create the door. The company address is copied in; address resolution may replace it.
  const door = await store.createDoor({
    externalProspectId: p.externalProspectId,
    source: p.source,
    companyId: company.id,
    name: doorDisplayName(p),
    priority: p.priority,
    street: p.companyAddress.street || null,
    city: p.companyAddress.city || null,
    state: p.companyAddress.state || null,
    zip: p.companyAddress.zip || null,
    streetKey: p.streetKey,
    jobCity: p.jobCity,
    jobState: p.jobState,
    workplaceType: p.workplaceType,
    contactName: p.contact.name,
    contactPhone: p.contact.phone,
    contactEmail: p.contact.email,
    contactLinkedinUrl: p.contact.linkedinUrl,
    qualificationNotes: p.qualificationNotes,
    preferredVisitWindow: p.preferredVisitWindow,
  });
  return { status: "accepted", doorId: door.id, companyId: company.id, companyCreated };
}
