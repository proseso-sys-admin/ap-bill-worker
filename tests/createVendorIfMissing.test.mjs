import { describe, it, expect, vi } from "vitest";
import { createVendorIfMissing } from "../src/worker.js";

const PH_COUNTRY_ID = 174;
const US_COUNTRY_ID = 235;

/**
 * Mock OdooClient covering the methods createVendorIfMissing touches:
 * - searchRead on res.partner (vendor name match), res.country (lookup),
 *   ir.sequence (placeholder TIN), res.partner with vat=like (legacy scan).
 * - create on res.partner (vendor) and ir.sequence (lazy init).
 * - executeKw for ir.sequence.next_by_code.
 *
 * Configurable knobs:
 *  - countries:     map of { name, code, id } the country lookup will resolve
 *  - existingVendor: array returned when searchRead finds a vendor by name
 *  - createBehavior: function(vals, callIndex) -> id | throw, applied to res.partner creates
 *  - existingSeq:   if true, returns id 99 for ir.sequence lookup
 */
function makeMockOdoo(opts = {}) {
  const {
    countries = [{ id: PH_COUNTRY_ID, name: "Philippines", code: "PH" }],
    existingVendor = [],
    createBehavior,
    existingSeq = true,
  } = opts;

  let nextSeqValue = 1;
  const partnerCreates = [];
  const messages = [];

  return {
    partnerCreates,
    messages,
    searchRead: vi.fn(async (model, domain, _fields, _kwargs) => {
      if (model === "res.partner") {
        if (domain.some((d) => Array.isArray(d) && d[0] === "vat" && d[1] === "=like")) {
          return [];
        }
        return existingVendor;
      }
      if (model === "res.country") {
        for (const d of domain) {
          if (Array.isArray(d) && d[0] === "name" && d[1] === "ilike") {
            const needle = String(d[2]).toLowerCase();
            const found = countries.find((c) => c.name.toLowerCase().includes(needle));
            return found ? [found] : [];
          }
          if (Array.isArray(d) && d[0] === "code" && d[1] === "=") {
            const found = countries.find((c) => c.code === d[2]);
            return found ? [found] : [];
          }
        }
        return [];
      }
      if (model === "ir.sequence") return existingSeq ? [{ id: 99 }] : [];
      return [];
    }),
    create: vi.fn(async (model, vals) => {
      if (model === "ir.sequence") {
        nextSeqValue = vals.number_next || 1;
        return 99;
      }
      if (model === "res.partner") {
        partnerCreates.push(vals);
        if (createBehavior) return createBehavior(vals, partnerCreates.length);
        return 1000 + partnerCreates.length;
      }
      return 1;
    }),
    executeKw: vi.fn(async (model, method, args) => {
      if (model === "ir.sequence" && method === "next_by_code") {
        const v = `000-000-${String(nextSeqValue).padStart(3, "0")}`;
        nextSeqValue += 1;
        return v;
      }
      return null;
    }),
  };
}

function ph_company_extracted(overrides = {}) {
  return {
    vendor: { name: "Acme Corp", confidence: 0.95, source: "letterhead" },
    vendor_details: {
      entity_type: "corporation",
      tin: "123-456-789",
      address: { street: "123 Ayala Ave", city: "Makati", country: "Philippines" },
      ...overrides,
    },
  };
}

function ph_soleprop_extracted(overrides = {}) {
  return {
    vendor: { name: "Maria Santos", confidence: 0.95, source: "letterhead" },
    vendor_details: {
      entity_type: "sole_proprietor",
      proprietor_name: { first_name: "Maria", last_name: "Santos" },
      tin: "987-654-321",
      address: { street: "456 EDSA", city: "Quezon City", country: "Philippines" },
      ...overrides,
    },
  };
}

describe("createVendorIfMissing — happy path", () => {
  it("creates PH company vendor with no backfill when all fields present", async () => {
    const odoo = makeMockOdoo();
    const result = await createVendorIfMissing(odoo, 1, ph_company_extracted(), "ocr text", "Philippines");

    expect(result.status).toBe("created");
    expect(result.partnerId).toBeGreaterThan(0);
    expect(result.created).toBe(true);
    expect(result.backfilled).toBeNull();

    expect(odoo.partnerCreates).toHaveLength(1);
    const vals = odoo.partnerCreates[0];
    expect(vals.name).toBe("Acme Corp");
    expect(vals.street).toBe("123 Ayala Ave");
    expect(vals.city).toBe("Makati");
    expect(vals.country_id).toBe(PH_COUNTRY_ID);
    expect(vals.vat).toBe("123456789");
    expect(vals.is_company).toBe(true);
  });

  it("creates PH sole prop with first/last name and TIN", async () => {
    const odoo = makeMockOdoo();
    const result = await createVendorIfMissing(odoo, 1, ph_soleprop_extracted(), "ocr text", "Philippines");

    expect(result.status).toBe("created");
    expect(result.backfilled).toBeNull();

    const vals = odoo.partnerCreates[0];
    expect(vals.first_name).toBe("Maria");
    expect(vals.last_name).toBe("Santos");
    expect(vals.is_company).toBe(false);
    expect(vals.company_type).toBe("person");
  });
});

describe("createVendorIfMissing — early returns", () => {
  it("returns missing when vendor name is empty", async () => {
    const odoo = makeMockOdoo();
    const result = await createVendorIfMissing(
      odoo,
      1,
      { vendor: { name: "", confidence: 0.95, source: "x" }, vendor_details: {} },
      "",
      ""
    );
    expect(result.status).toBe("missing");
    expect(result.partnerId).toBe(0);
    expect(odoo.partnerCreates).toHaveLength(0);
  });

  it("returns needs_confirmation when confidence < 0.9", async () => {
    const odoo = makeMockOdoo();
    const result = await createVendorIfMissing(
      odoo,
      1,
      { vendor: { name: "Low Conf Vendor", confidence: 0.5, source: "x" }, vendor_details: {} },
      "",
      ""
    );
    expect(result.status).toBe("needs_confirmation");
    expect(result.partnerId).toBe(0);
    expect(odoo.partnerCreates).toHaveLength(0);
  });

  it("returns matched when existing vendor found by name", async () => {
    const odoo = makeMockOdoo({ existingVendor: [{ id: 42, name: "Acme Corp" }] });
    const result = await createVendorIfMissing(odoo, 1, ph_company_extracted(), "", "");
    expect(result.status).toBe("matched");
    expect(result.partnerId).toBe(42);
    expect(odoo.partnerCreates).toHaveLength(0);
  });
});

describe("createVendorIfMissing — backfill", () => {
  it("backfills street to N/A when address has no street", async () => {
    const extracted = ph_company_extracted({
      address: { city: "Makati", country: "Philippines" },
    });
    const odoo = makeMockOdoo();
    const result = await createVendorIfMissing(odoo, 1, extracted, "", "");

    expect(result.status).toBe("created");
    expect(result.backfilled.fields).toContain("street");
    expect(odoo.partnerCreates[0].street).toBe("N/A");
  });

  it("backfills city to N/A when address has no city", async () => {
    const extracted = ph_company_extracted({
      address: { street: "123 Main St", country: "Philippines" },
    });
    const odoo = makeMockOdoo();
    const result = await createVendorIfMissing(odoo, 1, extracted, "", "");

    expect(result.backfilled.fields).toContain("city");
    expect(odoo.partnerCreates[0].city).toBe("N/A");
  });

  it("backfills country_id to PH when no country could be resolved", async () => {
    const extracted = ph_company_extracted({
      address: { street: "123 Main", city: "Makati" },
    });
    const odoo = makeMockOdoo();
    const result = await createVendorIfMissing(odoo, 1, extracted, "", "");

    expect(result.backfilled.fields).toContain("country_id");
    expect(odoo.partnerCreates[0].country_id).toBe(PH_COUNTRY_ID);
  });

  it("backfills first_name and last_name for PH sole prop without proprietor name", async () => {
    const extracted = ph_soleprop_extracted({
      proprietor_name: null,
      address: { street: "456 EDSA", city: "Quezon City", country: "Philippines" },
    });
    const odoo = makeMockOdoo();
    const result = await createVendorIfMissing(odoo, 1, extracted, "", "");

    expect(result.backfilled.fields).toContain("first_name");
    expect(result.backfilled.fields).toContain("last_name");
    expect(odoo.partnerCreates[0].first_name).toBe("Pending");
    expect(odoo.partnerCreates[0].last_name).toBe("Review");
  });

  it("does NOT backfill first_name/last_name for non-PH sole prop", async () => {
    const usCountries = [
      { id: US_COUNTRY_ID, name: "United States", code: "US" },
      { id: PH_COUNTRY_ID, name: "Philippines", code: "PH" },
    ];
    const extracted = {
      vendor: { name: "John Doe", confidence: 0.95, source: "letterhead" },
      vendor_details: {
        entity_type: "sole_proprietor",
        proprietor_name: null,
        address: { street: "1 Wall St", city: "New York", country: "United States" },
      },
    };
    const odoo = makeMockOdoo({ countries: usCountries });
    const result = await createVendorIfMissing(odoo, 1, extracted, "", "");

    expect(result.status).toBe("created");
    expect(result.backfilled?.fields || []).not.toContain("first_name");
    expect(result.backfilled?.fields || []).not.toContain("last_name");
    expect(odoo.partnerCreates[0].first_name).toBeUndefined();
  });

  it("does NOT backfill first_name/last_name for PH company (is_company=true)", async () => {
    const extracted = ph_company_extracted({
      address: { street: "123 Ayala", city: "Makati", country: "Philippines" },
    });
    const odoo = makeMockOdoo();
    const result = await createVendorIfMissing(odoo, 1, extracted, "", "");

    expect(result.backfilled).toBeNull();
    expect(odoo.partnerCreates[0].first_name).toBeUndefined();
    expect(odoo.partnerCreates[0].last_name).toBeUndefined();
  });
});

describe("createVendorIfMissing — placeholder TIN", () => {
  it("allocates placeholder TIN when PH vendor has no TIN", async () => {
    const extracted = ph_company_extracted({
      tin: "",
      address: { street: "123 Ayala", city: "Makati", country: "Philippines" },
    });
    const odoo = makeMockOdoo();
    const result = await createVendorIfMissing(odoo, 1, extracted, "", "");

    expect(result.status).toBe("created");
    expect(result.backfilled.fields).toContain("vat");
    expect(result.backfilled.placeholderTin).toBe("000-000-001");
    expect(odoo.partnerCreates[0].vat).toBe("000-000-001");
  });

  it("does NOT allocate placeholder TIN for non-PH vendor", async () => {
    const extracted = {
      vendor: { name: "US Vendor LLC", confidence: 0.95, source: "letterhead" },
      vendor_details: {
        entity_type: "corporation",
        address: { street: "1 Wall St", city: "New York", country: "United States" },
      },
    };
    const odoo = makeMockOdoo({
      countries: [
        { id: US_COUNTRY_ID, name: "United States", code: "US" },
        { id: PH_COUNTRY_ID, name: "Philippines", code: "PH" },
      ],
    });
    const result = await createVendorIfMissing(odoo, 1, extracted, "", "");

    expect(result.status).toBe("created");
    expect(result.backfilled?.placeholderTin).toBeFalsy();
    expect(odoo.partnerCreates[0].vat).toBeUndefined();
  });

  it("uses placeholder TIN when country defaults to PH (unresolved country)", async () => {
    const extracted = {
      vendor: { name: "Unknown Vendor", confidence: 0.95, source: "x" },
      vendor_details: {
        entity_type: "corporation",
        address: { street: "Somewhere", city: "Sometown" },
      },
    };
    const odoo = makeMockOdoo();
    const result = await createVendorIfMissing(odoo, 1, extracted, "", "");

    expect(result.backfilled.fields).toContain("country_id");
    expect(result.backfilled.fields).toContain("vat");
    expect(result.backfilled.placeholderTin).toMatch(/^000-000-\d{3}$/);
  });
});

describe("createVendorIfMissing — canonical UserError handling (option 4)", () => {
  it("routes to needs_confirmation when create throws canonical 'fields are required' error", async () => {
    const odoo = makeMockOdoo({
      createBehavior: (vals) => {
        throw new Error(
          "Odoo RPC error: The following fields are required: Industry, Reference"
        );
      },
    });
    const result = await createVendorIfMissing(odoo, 1, ph_company_extracted(), "", "");

    expect(result.status).toBe("needs_confirmation");
    expect(result.partnerId).toBe(0);
    expect(result.reason).toBe("canonical_validation_failed");
    expect(result.missing).toContain("Industry");
    expect(result.missing).toContain("Reference");
  });
});

describe("createVendorIfMissing — strip-on-error retry (option 3)", () => {
  it("strips first_name on 'Invalid field' error and retries", async () => {
    let callCount = 0;
    const odoo = makeMockOdoo({
      createBehavior: (vals, idx) => {
        callCount = idx;
        if (idx === 1) {
          throw new Error("Invalid field 'first_name' on model res.partner");
        }
        return 5555;
      },
    });
    const result = await createVendorIfMissing(odoo, 1, ph_soleprop_extracted(), "", "");

    expect(result.status).toBe("created");
    expect(result.partnerId).toBe(5555);
    expect(callCount).toBe(2);
    expect(odoo.partnerCreates[1].first_name).toBeUndefined();
    expect(odoo.partnerCreates[1].last_name).toBeUndefined();
  });

  it("does NOT strip first_name when canonical 'fields are required' error mentions it", async () => {
    const odoo = makeMockOdoo({
      createBehavior: () => {
        throw new Error("The following fields are required: First Name, Last Name");
      },
    });
    const result = await createVendorIfMissing(odoo, 1, ph_soleprop_extracted(), "", "");

    expect(result.status).toBe("needs_confirmation");
    expect(result.reason).toBe("canonical_validation_failed");
    expect(odoo.partnerCreates).toHaveLength(1);
  });

  it("strips branch_code on 'Invalid field' error", async () => {
    const odoo = makeMockOdoo({
      createBehavior: (vals, idx) => {
        if (idx === 1) {
          throw new Error("Invalid field 'branch_code' on model res.partner");
        }
        return 7777;
      },
    });
    const result = await createVendorIfMissing(odoo, 1, ph_company_extracted(), "", "");

    expect(result.status).toBe("created");
    expect(odoo.partnerCreates[1].branch_code).toBeUndefined();
  });

  it("bubbles unknown errors that don't match strip patterns", async () => {
    const odoo = makeMockOdoo({
      createBehavior: () => {
        throw new Error("Database connection lost");
      },
    });
    await expect(
      createVendorIfMissing(odoo, 1, ph_company_extracted(), "", "")
    ).rejects.toThrow(/Database connection lost/);
  });

  it("retries strip twice on cascading unknown-field errors", async () => {
    let calls = 0;
    const odoo = makeMockOdoo({
      createBehavior: (vals) => {
        calls += 1;
        if (calls === 1) throw new Error("Invalid field 'first_name' on model res.partner");
        if (calls === 2) throw new Error("Invalid field 'branch_code' on model res.partner");
        return 8888;
      },
    });
    const result = await createVendorIfMissing(odoo, 1, ph_soleprop_extracted(), "", "");

    expect(result.status).toBe("created");
    expect(result.partnerId).toBe(8888);
    expect(calls).toBe(3);
  });
});
