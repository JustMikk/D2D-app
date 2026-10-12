import { describe, expect, it } from "vitest";
import {
  companyKey,
  domainOf,
  isPoBox,
  norm,
  phoneE164,
  similarity,
  state2,
  str,
  streetKey,
  workplaceType,
  zip5,
} from "@/lib/domain/normalize";

describe("str", () => {
  it("trims and stringifies nullish values", () => {
    expect(str("  a ")).toBe("a");
    expect(str(null)).toBe("");
    expect(str(undefined)).toBe("");
    expect(str(75093)).toBe("75093");
  });
});

describe("state2", () => {
  it("maps full state names to codes", () => {
    expect(state2("Texas")).toBe("TX");
    expect(state2("new york")).toBe("NY");
    expect(state2("District of Columbia")).toBe("DC");
    expect(state2(" North  Carolina ")).toBe("NC");
  });
  it("upper-cases two-letter codes", () => {
    expect(state2("tx")).toBe("TX");
    expect(state2("CA")).toBe("CA");
  });
  it("returns empty for unknown values", () => {
    expect(state2("Texass")).toBe("");
    expect(state2(null)).toBe("");
  });
});

describe("zip5", () => {
  it("keeps the first five digits of ZIP+4", () => {
    expect(zip5("75093-1234")).toBe("75093");
    expect(zip5("750931234")).toBe("75093");
    expect(zip5(75093)).toBe("75093");
    expect(zip5("")).toBe("");
  });
});

describe("phoneE164", () => {
  it("formats 10- and 11-digit US numbers", () => {
    expect(phoneE164("(214) 555-0101")).toBe("+12145550101");
    expect(phoneE164("1-214-555-0101")).toBe("+12145550101");
    expect(phoneE164("+1 214.555.0101")).toBe("+12145550101");
  });
  it("drops anything else", () => {
    expect(phoneE164("555-0101")).toBeNull();
    expect(phoneE164("2-214-555-0101")).toBeNull();
    expect(phoneE164("")).toBeNull();
  });
});

describe("norm", () => {
  it("lower-cases, replaces punctuation with spaces and collapses", () => {
    expect(norm("  Trinity Roofing & Exteriors, LLC. ")).toBe("trinity roofing exteriors llc");
  });
});

describe("streetKey", () => {
  it("treats Road and Rd as equal", () => {
    expect(streetKey("6101 Preston Road")).toBe(streetKey("6101 Preston Rd"));
    expect(streetKey("6101 Preston Road")).toBe("6101 preston rd");
  });
  it("abbreviates every listed word", () => {
    expect(streetKey("100 North Main Street Suite 200")).toBe("100 n main st ste 200");
    expect(streetKey("4100 West John Carpenter Freeway")).toBe("4100 w john carpenter fwy");
    expect(streetKey("8200 Gaylord Parkway")).toBe("8200 gaylord pkwy");
  });
});

describe("companyKey", () => {
  it("ignores legal suffixes", () => {
    expect(companyKey("Sunbelt Medical Billing LLC")).toBe(companyKey("Sunbelt Medical Billing"));
    expect(companyKey("The Saguaro Landscaping Co.")).toBe("saguaro landscaping");
    expect(companyKey("Bluebonnet Dental Group, Inc.")).toBe("bluebonnet dental");
  });
});

describe("domainOf", () => {
  it("extracts a lower-case hostname without www", () => {
    expect(domainOf("https://www.Sample-Bluebonnet-Dental-Group.example/")).toBe("sample-bluebonnet-dental-group.example");
    expect(domainOf("bluebonnetdental.com/about")).toBe("bluebonnetdental.com");
  });
  it("returns null for invalid input", () => {
    expect(domainOf("")).toBeNull();
    expect(domainOf("not a url")).toBeNull();
    expect(domainOf(null)).toBeNull();
  });
});

describe("workplaceType", () => {
  it("normalizes the common spellings", () => {
    expect(workplaceType("on-site")).toBe("ON_SITE");
    expect(workplaceType("On-site")).toBe("ON_SITE");
    expect(workplaceType("ON_SITE")).toBe("ON_SITE");
    expect(workplaceType("hybrid")).toBe("HYBRID");
    expect(workplaceType("Remote")).toBe("REMOTE");
    expect(workplaceType("flexible")).toBe("UNKNOWN");
    expect(workplaceType(undefined)).toBe("UNKNOWN");
  });
});

describe("similarity", () => {
  it("is 1 for names equal after companyKey", () => {
    expect(similarity("Sunbelt Medical Billing LLC", "Sunbelt Medical Billing")).toBe(1);
    expect(similarity("", "")).toBe(1);
  });
  it("drops with edit distance", () => {
    expect(similarity("Sunbelt Medical Billing", "Sunbelt Medical Biling")).toBeGreaterThan(0.9);
    expect(similarity("Sunbelt Medical Billing", "Sunshine Dental")).toBeLessThan(0.8);
  });
});

describe("isPoBox", () => {
  it("recognizes PO box spellings", () => {
    for (const s of ["PO Box 4471", "P.O. Box 4471", "POBox 12", "Post Office Box 9"]) expect(isPoBox(s)).toBe(true);
    expect(isPoBox("4500 Camp Bowie Blvd")).toBe(false);
    expect(isPoBox("100 Pobox Lane")).toBe(false);
  });
});
