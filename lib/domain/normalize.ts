// Normalization helpers (backend spec §6.1). Ported from the n8n WF1/WF2 code nodes; behavior must match.
import type { WorkplaceType } from "./enums";

export function str(v: unknown): string {
  return String(v ?? "").trim();
}

const STATE_CODES: Record<string, string> = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA", COLORADO: "CO",
  CONNECTICUT: "CT", DELAWARE: "DE", "DISTRICT OF COLUMBIA": "DC", FLORIDA: "FL", GEORGIA: "GA",
  HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA", KANSAS: "KS", KENTUCKY: "KY",
  LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD", MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN",
  MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV", "NEW HAMPSHIRE": "NH",
  "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND",
  OHIO: "OH", OKLAHOMA: "OK", OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI",
  "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT",
  VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV", WISCONSIN: "WI", WYOMING: "WY",
};

/** Two-letter state code. Two letters pass through; full names (50 states and DC) map; anything else is "". */
export function state2(v: unknown): string {
  const s = str(v).toUpperCase().replace(/\s+/g, " ");
  if (/^[A-Z]{2}$/.test(s)) return s;
  return STATE_CODES[s] ?? "";
}

/** Digits only, first five. "75093-1234" becomes "75093". */
export function zip5(v: unknown): string {
  return str(v).replace(/\D/g, "").slice(0, 5);
}

/** US numbers to E.164. 10 digits get +1; 11 digits starting with 1 get +; anything else is dropped (null). */
export function phoneE164(v: unknown): string | null {
  const d = str(v).replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

/** Lower-case; every character outside [a-z0-9 ] becomes a space; spaces collapse. */
export function norm(s: unknown): string {
  return str(s)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STREET_WORDS: Record<string, string> = {
  street: "st", road: "rd", avenue: "ave", boulevard: "blvd", drive: "dr", highway: "hwy", freeway: "fwy",
  parkway: "pkwy", lane: "ln", north: "n", south: "s", east: "e", west: "w", suite: "ste",
};

/** Normalized street for same-address dedupe ("6101 Preston Road" equals "6101 Preston Rd"). */
export function streetKey(s: unknown): string {
  return norm(s)
    .split(" ")
    .filter(Boolean)
    .map((w) => STREET_WORDS[w] ?? w)
    .join(" ");
}

const LEGAL_WORDS = new Set(["inc", "llc", "co", "corp", "corporation", "company", "ltd", "group", "the"]);

/** Normalized company name without legal suffixes ("Sunbelt Medical Billing LLC" equals "Sunbelt Medical Billing"). */
export function companyKey(s: unknown): string {
  return norm(s)
    .split(" ")
    .filter((w) => w && !LEGAL_WORDS.has(w))
    .join(" ");
}

/** Hostname, lower-case, without a leading "www."; null for invalid input. */
export function domainOf(url: unknown): string | null {
  const raw = str(url);
  if (!raw) return null;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

/** "on-site", "On-site", "ON_SITE" all become ON_SITE; unknown values become UNKNOWN. */
export function workplaceType(v: unknown): WorkplaceType {
  const s = str(v).toUpperCase().replace(/[-\s]+/g, "_");
  return s === "ON_SITE" || s === "HYBRID" || s === "REMOTE" ? s : "UNKNOWN";
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = curr;
  }
  return prev[b.length]!;
}

/** Name similarity in 0..1 on companyKey values; 1 when both are empty. */
export function similarity(a: unknown, b: unknown): number {
  const x = companyKey(a);
  const y = companyKey(b);
  const max = Math.max(x.length, y.length);
  if (max === 0) return 1;
  return 1 - levenshtein(x, y) / max;
}

/** PO boxes in any common spelling: "PO Box", "P.O. Box", "POBox", "Post Office Box". */
export function isPoBox(street: unknown): boolean {
  return /^(?:po box|p o box|pobox|post office box)\b/.test(norm(street));
}
