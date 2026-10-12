// A city-level stand-in for Google, for tests and for local demos without a key
// (CANVASS_FAKE_GOOGLE=1, never in production). Street addresses in a known city geocode ROOFTOP near
// the city centre; a bare "City, ST" geocodes GEOMETRIC_CENTER; Places answers only what it is given.
import type { GeocodeResult, PlaceCandidate } from "@/lib/domain/addressResolution";
import type { LatLng } from "@/lib/domain/geo";
import { norm } from "@/lib/domain/normalize";
import { fakeGoogle } from "./fakes";
import type { GoogleClients } from "./index";

/** City centres for the sample data (tests/fixtures/sample_apify_linkedin_jobs.json) and nearby metros. */
export const CITY_CENTRES: Record<string, LatLng> = {
  "dallas tx": { lat: 32.7767, lng: -96.797 },
  "plano tx": { lat: 33.0198, lng: -96.6989 },
  "irving tx": { lat: 32.814, lng: -96.9489 },
  "fort worth tx": { lat: 32.7555, lng: -97.3308 },
  "richardson tx": { lat: 32.9483, lng: -96.7299 },
  "garland tx": { lat: 32.9126, lng: -96.6389 },
  "frisco tx": { lat: 33.1507, lng: -96.8236 },
  "arlington tx": { lat: 32.7357, lng: -97.1081 },
  "grand prairie tx": { lat: 32.746, lng: -96.9978 },
  "houston tx": { lat: 29.7604, lng: -95.3698 },
  "mckinney tx": { lat: 33.1972, lng: -96.6398 },
  "carrollton tx": { lat: 32.9537, lng: -96.8903 },
  "lewisville tx": { lat: 33.0462, lng: -96.9942 },
  "mesquite tx": { lat: 32.7668, lng: -96.5992 },
  "denton tx": { lat: 33.2148, lng: -97.1331 },
  "austin tx": { lat: 30.2672, lng: -97.7431 },
  "round rock tx": { lat: 30.5083, lng: -97.6789 },
  "lubbock tx": { lat: 33.5779, lng: -101.8552 },
  "denver co": { lat: 39.7392, lng: -104.9903 },
  "atlanta ga": { lat: 33.749, lng: -84.388 },
  "phoenix az": { lat: 33.4484, lng: -112.074 },
  "chicago il": { lat: 41.8781, lng: -87.6298 },
  "seattle wa": { lat: 47.6062, lng: -122.3321 },
  "tampa fl": { lat: 27.9506, lng: -82.4572 },
};

/** A small, stable offset per street so doors in one city do not share a point. */
function jitter(street: string): LatLng {
  let h = 0;
  for (const ch of street) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { lat: ((h % 1000) - 500) / 50_000, lng: (((h >>> 10) % 1000) - 500) / 50_000 };
}

export function cityGeocode(query: string): GeocodeResult {
  const parts = query.split(",").map((p) => p.trim());
  if (parts.length === 2) {
    const centre = CITY_CENTRES[norm(`${parts[0]} ${parts[1]}`)];
    return centre ? { status: "OK", location: centre, locationType: "GEOMETRIC_CENTER" } : { status: "ZERO_RESULTS" };
  }
  if (parts.length >= 3) {
    const [street, city, stateZip] = [parts[0]!, parts[1]!, parts[2]!];
    const state = stateZip.split(" ")[0] ?? "";
    const centre = CITY_CENTRES[norm(`${city} ${state}`)];
    if (!centre || !/^\d/.test(street)) return { status: "ZERO_RESULTS" };
    const j = jitter(street);
    return { status: "OK", location: { lat: centre.lat + j.lat, lng: centre.lng + j.lng }, locationType: "ROOFTOP", partialMatch: false };
  }
  return { status: "ZERO_RESULTS" };
}

export function cityFakeGoogle(places: Record<string, PlaceCandidate[]> = {}): GoogleClients {
  const base = fakeGoogle({ places });
  return { ...base, geocode: async (query) => cityGeocode(query) };
}
