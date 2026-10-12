// Places API (New) Text Search → PlaceCandidate[] (backend spec §9.1).
import type { PlaceCandidate } from "@/lib/domain/addressResolution";
import { googleRequest, type GoogleHttpOptions } from "./http";

export const PLACES_FIELD_MASK = "places.id,places.displayName,places.formattedAddress,places.addressComponents,places.location,places.businessStatus";

type AddressComponent = { longText?: string; shortText?: string; types?: string[] };
type Place = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: AddressComponent[];
  location?: { latitude?: number; longitude?: number };
  businessStatus?: string;
};

function component(components: AddressComponent[] | undefined, type: string, which: "longText" | "shortText" = "longText"): string | undefined {
  return components?.find((c) => c.types?.includes(type))?.[which];
}

export function parsePlace(p: Place): PlaceCandidate {
  const c = p.addressComponents;
  return {
    placeId: p.id ?? "",
    displayName: p.displayName?.text ?? "",
    streetNumber: component(c, "street_number"),
    route: component(c, "route", "shortText") ?? component(c, "route"),
    // Some US addresses carry the city only as sublocality or postal_town.
    locality: component(c, "locality") ?? component(c, "postal_town") ?? component(c, "sublocality"),
    adminArea1: component(c, "administrative_area_level_1", "shortText"),
    postalCode: component(c, "postal_code"),
    businessStatus: p.businessStatus,
    location: p.location?.latitude !== undefined && p.location.longitude !== undefined ? { lat: p.location.latitude, lng: p.location.longitude } : undefined,
  };
}

export function createPlacesSearch(apiKey: string, options?: GoogleHttpOptions) {
  return async function placesTextSearch(textQuery: string): Promise<PlaceCandidate[]> {
    const body = await googleRequest<{ places?: Place[] }>(
      "places.searchText",
      "https://places.googleapis.com/v1/places:searchText",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey, "x-goog-fieldmask": PLACES_FIELD_MASK },
        body: JSON.stringify({ textQuery, regionCode: "US", pageSize: 3 }),
      },
      options,
    );
    return (body.places ?? []).map(parsePlace);
  };
}
