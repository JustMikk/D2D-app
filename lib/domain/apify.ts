// Apify LinkedIn job → intake prospect (backend spec §10.5). Used by console imports (INT-5).
import type { IntakeProspectInput } from "./intake";
import { str } from "./normalize";

type ApifyJob = {
  id?: unknown;
  title?: unknown;
  link?: unknown;
  postedAt?: unknown;
  companyName?: unknown;
  companyWebsite?: unknown;
  companyAddress?: {
    streetAddress?: unknown;
    addressLocality?: unknown;
    addressRegion?: unknown;
    postalCode?: unknown;
  } | null;
  location?: { abbreviatedLocalizedName?: unknown } | null;
  jobWorkplaceTypes?: Array<{ workplaceTypeEnum?: unknown }> | null;
  recruiter?: { name?: unknown; profileUrl?: unknown } | null;
};

/** Split "San Diego, CA" on the last comma. */
export function splitCityState(location: unknown): { city: string; state: string } {
  const s = str(location);
  const i = s.lastIndexOf(",");
  if (i < 0) return { city: s, state: "" };
  return { city: s.slice(0, i).trim(), state: s.slice(i + 1).trim() };
}

export function apifyJobToIntake(raw: unknown): IntakeProspectInput {
  const job = (raw ?? {}) as ApifyJob;
  const addr = job.companyAddress;
  const posted = str(job.postedAt).slice(0, 10);
  const recruiterName = str(job.recruiter?.name);
  const recruiterUrl = str(job.recruiter?.profileUrl);
  return {
    externalProspectId: str(job.id),
    companyName: str(job.companyName),
    companyWebsite: str(job.companyWebsite) || undefined,
    companyAddress: addr
      ? {
          street: str(addr.streetAddress),
          city: str(addr.addressLocality),
          state: str(addr.addressRegion),
          zip: str(addr.postalCode),
        }
      : null,
    jobLocation: job.location?.abbreviatedLocalizedName ? splitCityState(job.location.abbreviatedLocalizedName) : null,
    workplaceType: str(job.jobWorkplaceTypes?.[0]?.workplaceTypeEnum) || undefined,
    contact:
      recruiterName || recruiterUrl
        ? { name: recruiterName || undefined, linkedinUrl: recruiterUrl || undefined }
        : undefined,
    qualificationNotes: `Hiring: ${str(job.title)}. Posted ${posted}. Job: ${str(job.link)}`,
    source: "IMPORT",
  };
}
