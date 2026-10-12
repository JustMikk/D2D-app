import { describe, expect, it, vi } from "vitest";
import {
  cityMatches,
  resolveAddress,
  usable,
  type GeocodeResult,
  type PlaceCandidate,
  type ResolutionDeps,
  type ResolutionInput,
} from "@/lib/domain/addressResolution";

const SETTINGS = { nameMatchThreshold: 0.8, metroRadiusMiles: 30 };

const rooftop = (lat: number, lng: number): GeocodeResult => ({ status: "OK", location: { lat, lng }, locationType: "ROOFTOP" });
const center = (lat: number, lng: number): GeocodeResult => ({ status: "OK", location: { lat, lng }, locationType: "GEOMETRIC_CENTER" });

/** Fake deps: geocode answers from a table (unknown queries are ZERO_RESULTS), Places returns a fixed list. */
function deps(geo: Record<string, GeocodeResult>, places: PlaceCandidate[] = []): ResolutionDeps & {
  geocode: ReturnType<typeof vi.fn>;
  placesTextSearch: ReturnType<typeof vi.fn>;
} {
  return {
    geocode: vi.fn(async (q: string) => geo[q] ?? { status: "ZERO_RESULTS" }),
    placesTextSearch: vi.fn(async () => places),
  };
}

const input = (over: Partial<ResolutionInput>): ResolutionInput => ({
  companyName: "Bluebonnet Dental Group",
  companyAddress: { street: "6101 Preston Rd", city: "Plano", state: "TX", zip: "75093" },
  jobCity: "Plano",
  jobState: "TX",
  workplaceType: "ON_SITE",
  ...over,
});

describe("helpers", () => {
  it("usable needs a numbered street, no PO box, a 5-digit ZIP, city and state", () => {
    expect(usable({ street: "6101 Preston Rd", city: "Plano", state: "TX", zip: "75093" })).toBe(true);
    expect(usable({ street: "Preston Rd", city: "Plano", state: "TX", zip: "75093" })).toBe(false);
    expect(usable({ street: "PO Box 4471", city: "Fort Worth", state: "TX", zip: "76164" })).toBe(false);
    expect(usable({ street: "1000 S Stemmons Fwy", city: "Lewisville", state: "TX", zip: "" })).toBe(false);
    expect(usable(null)).toBe(false);
  });

  it("cityMatches compares normalized city and state", () => {
    expect(cityMatches({ city: "Fort  Worth", state: "TX" }, "fort worth", "TX")).toBe(true);
    expect(cityMatches({ city: "Irving", state: "TX" }, "Fort Worth", "TX")).toBe(false);
    expect(cityMatches({ city: "Plano", state: "OK" }, "Plano", "TX")).toBe(false);
    expect(cityMatches({ city: "Plano", state: "TX" }, null, null)).toBe(true);
  });
});

describe("resolveAddress", () => {
  it("uses a company address in the job city", async () => {
    const d = deps({ "6101 Preston Rd, Plano, TX 75093": rooftop(33.06, -96.8) });
    const r = await resolveAddress(input({}), d, SETTINGS);
    expect(r).toEqual({
      kind: "resolved",
      address: { street: "6101 Preston Rd", city: "Plano", state: "TX", zip: "75093" },
      lat: 33.06,
      lng: -96.8,
      quality: "ROOFTOP",
      source: "COMPANY_ADDRESS",
    });
    expect(d.placesTextSearch).not.toHaveBeenCalled();
  });

  it("resolves a PO box through Places", async () => {
    const d = deps({ "3100 Hemphill St, Fort Worth, TX 76110": rooftop(32.71, -97.33) }, [
      { placeId: "pl_1", displayName: "Sunbelt Medical Billing LLC", streetNumber: "3100", route: "Hemphill St", locality: "Fort Worth", adminArea1: "TX", postalCode: "76110", businessStatus: "OPERATIONAL" },
    ]);
    const r = await resolveAddress(
      input({ companyName: "Sunbelt Medical Billing", companyAddress: { street: "PO Box 4471", city: "Fort Worth", state: "TX", zip: "76164" }, jobCity: "Fort Worth" }),
      d,
      SETTINGS,
    );
    expect(r).toMatchObject({ kind: "resolved", source: "PLACES_MATCH", placeId: "pl_1", address: { street: "3100 Hemphill St", city: "Fort Worth" } });
    expect(d.placesTextSearch).toHaveBeenCalledWith("Sunbelt Medical Billing Fort Worth, TX");
  });

  it("rejects a Places result whose name is below the threshold", async () => {
    const d = deps({}, [
      { placeId: "pl_2", displayName: "Sunshine Dental Care", streetNumber: "1", route: "Main St", locality: "Fort Worth", adminArea1: "TX", postalCode: "76102" },
    ]);
    const r = await resolveAddress(
      input({ companyName: "Sunbelt Medical Billing", companyAddress: { street: "PO Box 4471", city: "Fort Worth", state: "TX", zip: "76164" }, jobCity: "Fort Worth" }),
      d,
      SETTINGS,
    );
    expect(r).toMatchObject({ kind: "review", reason: "PO_BOX" });
    if (r.kind !== "review") return;
    expect(r.evidence.placesCandidates?.[0]).toMatchObject({ placeId: "pl_2", rejectedBecause: "name does not match" });
  });

  it("rejects a Places result in a different city, then a closed business", async () => {
    const d = deps({}, [
      { placeId: "pl_3", displayName: "Silverline Packaging", streetNumber: "10", route: "Elm St", locality: "Dallas", adminArea1: "TX", postalCode: "75201" },
      { placeId: "pl_4", displayName: "Silverline Packaging", streetNumber: "20", route: "Oak St", locality: "Mesquite", adminArea1: "TX", postalCode: "75149", businessStatus: "CLOSED_PERMANENTLY" },
    ]);
    const r = await resolveAddress(
      input({ companyName: "Silverline Packaging", companyAddress: { street: "", city: "Mesquite", state: "TX", zip: "75149" }, jobCity: "Mesquite" }),
      d,
      SETTINGS,
    );
    expect(r).toMatchObject({ kind: "review", reason: "MISSING_ADDRESS" });
    if (r.kind !== "review") return;
    expect(r.evidence.placesCandidates?.map((c) => c.rejectedBecause)).toEqual(["different city", "business closed_permanently"]);
  });

  it("picks the most similar qualifying Places result", async () => {
    const d = deps({ "20 Oak St, Mesquite, TX 75149": rooftop(32.77, -96.6) }, [
      { placeId: "pl_5", displayName: "Silverline Packaging Supply", streetNumber: "10", route: "Elm St", locality: "Mesquite", adminArea1: "TX", postalCode: "75149" },
      { placeId: "pl_6", displayName: "Silverline Packaging", streetNumber: "20", route: "Oak St", locality: "Mesquite", adminArea1: "TX", postalCode: "75149" },
    ]);
    const r = await resolveAddress(input({ companyName: "Silverline Packaging", companyAddress: null, jobCity: "Mesquite" }), d, { ...SETTINGS, nameMatchThreshold: 0.7 });
    expect(r).toMatchObject({ kind: "resolved", placeId: "pl_6" });
  });

  it("falls back to a company address within the metro radius (about 23 miles)", async () => {
    // Trinity Roofing: Irving office, Fort Worth job.
    const d = deps({
      "4100 W John Carpenter Fwy, Irving, TX 75063": rooftop(32.9, -97.02),
      "Fort Worth, TX": center(32.7555, -97.3308),
    });
    const r = await resolveAddress(
      input({ companyName: "Trinity Roofing & Exteriors", companyAddress: { street: "4100 W John Carpenter Fwy", city: "Irving", state: "TX", zip: "75063" }, jobCity: "Fort Worth" }),
      d,
      SETTINGS,
    );
    expect(r).toMatchObject({ kind: "resolved", source: "METRO_FALLBACK", lat: 32.9, lng: -97.02 });
    // The company address geocode is reused for the quality gate, not repeated.
    expect(d.geocode).toHaveBeenCalledTimes(2);
  });

  it("sends a company address far from the job city to review (about 228 miles)", async () => {
    // Red River Logistics: Grand Prairie office, Houston job.
    const d = deps({
      "2601 Great Southwest Pkwy, Grand Prairie, TX 75050": rooftop(32.7787, -97.0353),
      "Houston, TX": center(29.7604, -95.3698),
    });
    const r = await resolveAddress(
      input({ companyName: "Red River Logistics", companyAddress: { street: "2601 Great Southwest Pkwy", city: "Grand Prairie", state: "TX", zip: "75050" }, jobCity: "Houston" }),
      d,
      SETTINGS,
    );
    expect(r).toMatchObject({ kind: "review", reason: "LOCATION_MISMATCH" });
    if (r.kind !== "review") return;
    expect(r.evidence.distanceMiles).toBeGreaterThan(200);
    expect(r.evidence.distanceMiles).toBeLessThan(250);
    expect(r.evidence.companyAddress).toMatchObject({ lat: 32.7787 });
    expect(r.evidence.jobCity).toMatchObject({ city: "Houston", lat: 29.7604 });
  });

  it("sends remote jobs to review", async () => {
    const d = deps({});
    expect(await resolveAddress(input({ workplaceType: "REMOTE" }), d, SETTINGS)).toMatchObject({ kind: "review", reason: "REMOTE_JOB" });
    expect(d.geocode).not.toHaveBeenCalled();
  });

  it("reviews a door with no address and no job city", async () => {
    const d = deps({});
    expect(await resolveAddress(input({ companyAddress: null, jobCity: null, jobState: null }), d, SETTINGS)).toMatchObject({ reason: "MISSING_ADDRESS" });
    expect(
      await resolveAddress(input({ companyAddress: { street: "PO Box 1", city: "Plano", state: "TX", zip: "75093" }, jobCity: null, jobState: null }), d, SETTINGS),
    ).toMatchObject({ reason: "PO_BOX" });
  });

  it("reviews a low-quality geocode", async () => {
    const d = deps({ "6101 Preston Rd, Plano, TX 75093": center(33.02, -96.7) });
    const r = await resolveAddress(input({}), d, SETTINGS);
    expect(r).toMatchObject({ kind: "review", reason: "LOW_GEOCODE_QUALITY", evidence: { geocode: { quality: "CENTER", status: "OK" } } });
  });

  it("reviews a partial geocode match", async () => {
    const d = deps({ "6101 Preston Rd, Plano, TX 75093": { ...rooftop(33.06, -96.8), partialMatch: true } });
    const r = await resolveAddress(input({}), d, SETTINGS);
    expect(r).toMatchObject({ kind: "review", reason: "LOW_GEOCODE_QUALITY", evidence: { geocode: { partialMatch: true } } });
  });

  it("accepts an interpolated geocode", async () => {
    const d = deps({ "6101 Preston Rd, Plano, TX 75093": { status: "OK", location: { lat: 1, lng: 2 }, locationType: "RANGE_INTERPOLATED" } });
    expect(await resolveAddress(input({}), d, SETTINGS)).toMatchObject({ kind: "resolved", quality: "INTERPOLATED" });
  });
});
