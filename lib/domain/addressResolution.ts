// Address resolution (backend spec §6.3, PRD ADR-1 to ADR-3).
// Google calls are injected so tests can stub them; lib/integrations/google maps API responses
// into the GeocodeResult and PlaceCandidate shapes below.
import type { AddressSource, GeocodeQuality, ReviewReason, WorkplaceType } from "./enums";
import { haversineMiles, type LatLng } from "./geo";
import type { Address } from "./intake";
import { isPoBox, norm, similarity, str } from "./normalize";

export type GeocodeLocationType = "ROOFTOP" | "RANGE_INTERPOLATED" | "GEOMETRIC_CENTER" | "APPROXIMATE";

export type GeocodeResult = {
  /** Google status: "OK", "ZERO_RESULTS", … */
  status: string;
  location?: LatLng;
  locationType?: GeocodeLocationType;
  partialMatch?: boolean;
};

export type PlaceCandidate = {
  placeId: string;
  displayName: string;
  streetNumber?: string;
  route?: string;
  locality?: string;
  /** administrative_area_level_1 short text, e.g. "TX". */
  adminArea1?: string;
  postalCode?: string;
  businessStatus?: string;
  location?: LatLng;
};

export type ResolutionDeps = {
  geocode(query: string): Promise<GeocodeResult>;
  placesTextSearch(query: string): Promise<PlaceCandidate[]>;
};

export type ResolutionSettings = { nameMatchThreshold: number; metroRadiusMiles: number };

export type ResolutionInput = {
  companyName: string;
  companyAddress: Address | null;
  jobCity: string | null;
  jobState: string | null;
  workplaceType: WorkplaceType | null;
};

export type ReviewEvidence = {
  companyAddress?: Address & { lat?: number; lng?: number };
  jobCity?: { city: string; state: string; lat?: number; lng?: number };
  distanceMiles?: number;
  placesCandidates?: Array<{
    name: string;
    street: string;
    city: string;
    state: string;
    zip: string;
    similarity: number;
    placeId: string;
    rejectedBecause?: string;
  }>;
  geocode?: { query: string; quality?: string; status: string; partialMatch?: boolean };
  coverage?: { nearestRepId: string; nearestRepName: string; driveMinutes: number; maxDriveMinutes: number };
  rollovers?: number;
  /** Free-form notes, e.g. a rep's bad-address report. */
  note?: string;
  reportedAt?: { lat: number; lng: number };
};

export type ResolutionResult =
  | {
      kind: "resolved";
      address: Address;
      lat: number;
      lng: number;
      quality: GeocodeQuality;
      source: AddressSource;
      placeId?: string;
    }
  | { kind: "review"; reason: ReviewReason; evidence: ReviewEvidence };

/** Usable for a visit: numbered street, not a PO box, 5-digit ZIP, city and state. */
export function usable(addr: Address | null | undefined): addr is Address {
  if (!addr) return false;
  return /^\d/.test(str(addr.street)) && !isPoBox(addr.street) && /^\d{5}$/.test(addr.zip) && Boolean(str(addr.city)) && Boolean(str(addr.state));
}

/** True when there is no job city, or the address is in the job city (and state, when known). */
export function cityMatches(addr: Pick<Address, "city" | "state">, jobCity: string | null, jobState: string | null): boolean {
  if (!jobCity) return true;
  return norm(addr.city) === norm(jobCity) && (!jobState || addr.state === jobState);
}

export function formatAddress(a: Address): string {
  return `${a.street}, ${a.city}, ${a.state} ${a.zip}`.trim();
}

export function geocodeQuality(locationType: GeocodeLocationType | undefined): GeocodeQuality | undefined {
  switch (locationType) {
    case "ROOFTOP":
      return "ROOFTOP";
    case "RANGE_INTERPOLATED":
      return "INTERPOLATED";
    case "GEOMETRIC_CENTER":
      return "CENTER";
    case "APPROXIMATE":
      return "APPROXIMATE";
    default:
      return undefined;
  }
}

function missingReason(addr: Address | null): ReviewReason {
  return addr && isPoBox(addr.street) ? "PO_BOX" : "MISSING_ADDRESS";
}

function placeAddress(p: PlaceCandidate): Address {
  return {
    street: [str(p.streetNumber), str(p.route)].filter(Boolean).join(" "),
    city: str(p.locality),
    state: str(p.adminArea1).toUpperCase(),
    zip: str(p.postalCode).slice(0, 5),
  };
}

/** Why a Places candidate is rejected, or undefined when it qualifies. */
function rejectPlace(p: PlaceCandidate, sim: number, input: ResolutionInput, settings: ResolutionSettings): string | undefined {
  if (!str(p.streetNumber) || !str(p.route) || !str(p.postalCode)) return "incomplete address";
  if (norm(p.locality) !== norm(input.jobCity)) return "different city";
  if (input.jobState && str(p.adminArea1).toUpperCase() !== input.jobState) return "different state";
  if (p.businessStatus && p.businessStatus !== "OPERATIONAL") return `business ${p.businessStatus.toLowerCase()}`;
  if (sim < settings.nameMatchThreshold) return "name does not match";
  return undefined;
}

type Candidate = { address: Address; source: AddressSource; placeId?: string; geocoded?: GeocodeResult };

export async function resolveAddress(
  input: ResolutionInput,
  deps: ResolutionDeps,
  settings: ResolutionSettings,
): Promise<ResolutionResult> {
  const companyAddr = input.companyAddress;
  const evidence: ReviewEvidence = {};
  if (companyAddr && (companyAddr.street || companyAddr.city)) evidence.companyAddress = { ...companyAddr };
  if (input.jobCity) evidence.jobCity = { city: input.jobCity, state: input.jobState ?? "" };

  // 1. Remote jobs have nothing to visit.
  if (input.workplaceType === "REMOTE") return { kind: "review", reason: "REMOTE_JOB", evidence };

  let candidate: Candidate | undefined;

  if (usable(companyAddr) && cityMatches(companyAddr, input.jobCity, input.jobState)) {
    // 2. A usable company address in the job city.
    candidate = { address: companyAddr, source: "COMPANY_ADDRESS" };
  } else if (input.jobCity) {
    // 3. Places search for the company in the job city.
    const jobPlace = [input.jobCity, input.jobState].filter(Boolean).join(", ");
    const places = await deps.placesTextSearch(`${input.companyName} ${jobPlace}`);
    let best: { place: PlaceCandidate; sim: number } | null = null;
    const tried: NonNullable<ReviewEvidence["placesCandidates"]> = [];
    for (const place of places) {
      const sim = similarity(input.companyName, place.displayName);
      const rejectedBecause = rejectPlace(place, sim, input, settings);
      if (!rejectedBecause && (best === null || sim > best.sim)) best = { place, sim };
      tried.push({ name: place.displayName, ...placeAddress(place), similarity: Math.round(sim * 1000) / 1000, placeId: place.placeId, rejectedBecause });
    }
    evidence.placesCandidates = tried;

    if (best) {
      candidate = { address: placeAddress(best.place), source: "PLACES_MATCH", placeId: best.place.placeId };
    } else if (usable(companyAddr)) {
      // 3b. Metro fallback: the company address within the radius of the job city.
      const companyGeo = await deps.geocode(formatAddress(companyAddr));
      const cityGeo = await deps.geocode(jobPlace);
      if (companyGeo.location) evidence.companyAddress = { ...companyAddr, ...companyGeo.location };
      if (cityGeo.location && evidence.jobCity) evidence.jobCity = { ...evidence.jobCity, ...cityGeo.location };
      if (!companyGeo.location) {
        evidence.geocode = { query: formatAddress(companyAddr), status: companyGeo.status, quality: geocodeQuality(companyGeo.locationType) };
        return { kind: "review", reason: "LOW_GEOCODE_QUALITY", evidence };
      }
      if (!cityGeo.location) return { kind: "review", reason: "LOCATION_MISMATCH", evidence };
      const miles = haversineMiles(companyGeo.location, cityGeo.location);
      evidence.distanceMiles = Math.round(miles * 10) / 10;
      if (miles > settings.metroRadiusMiles) return { kind: "review", reason: "LOCATION_MISMATCH", evidence };
      candidate = { address: companyAddr, source: "METRO_FALLBACK", geocoded: companyGeo };
    } else {
      return { kind: "review", reason: missingReason(companyAddr), evidence };
    }
  } else {
    // 4. No usable address and no job city.
    return { kind: "review", reason: missingReason(companyAddr), evidence };
  }

  // 5. Geocode quality gate.
  const query = formatAddress(candidate.address);
  const geo = candidate.geocoded ?? (await deps.geocode(query));
  const quality = geocodeQuality(geo.locationType);
  const passes = geo.status === "OK" && geo.location && (quality === "ROOFTOP" || quality === "INTERPOLATED") && !geo.partialMatch;
  if (!passes || !geo.location || !quality) {
    evidence.geocode = { query, quality, status: geo.status, partialMatch: geo.partialMatch };
    return { kind: "review", reason: "LOW_GEOCODE_QUALITY", evidence };
  }
  return {
    kind: "resolved",
    address: candidate.address,
    lat: geo.location.lat,
    lng: geo.location.lng,
    quality,
    source: candidate.source,
    ...(candidate.placeId ? { placeId: candidate.placeId } : {}),
  };
}
