import { describe, it, expect, vi } from "vitest";
import {
  TIN_SEQUENCE_CODE,
  TIN_PREFIX,
  ensureTinSequence,
  nextSequentialTin,
  randomPlaceholderTin,
  isDuplicateVatError,
  createVendorWithPlaceholderTin,
} from "../src/placeholderTin.js";

/**
 * Builds a stub OdooClient with configurable behavior. The stub mimics
 * ir.sequence's atomic next_by_code by maintaining an internal counter.
 */
function makeMockOdoo(opts = {}) {
  const {
    existingSeq = false,
    existingPartners = [],
    createBehavior,
    seqStartAt = 1,
  } = opts;

  let nextSeqValue = seqStartAt;
  const calls = { searchRead: [], create: [], executeKw: [] };
  const partnerCreates = [];

  return {
    calls,
    partnerCreates,
    seqValue: () => nextSeqValue,
    searchRead: vi.fn(async (model, domain, _fields, _kwargs) => {
      calls.searchRead.push({ model, domain });
      if (model === "ir.sequence") return existingSeq ? [{ id: 99 }] : [];
      if (model === "res.partner") return existingPartners;
      return [];
    }),
    create: vi.fn(async (model, vals) => {
      calls.create.push({ model, vals });
      if (model === "ir.sequence") {
        nextSeqValue = vals.number_next || 1;
        return 99;
      }
      partnerCreates.push(vals);
      if (createBehavior) return createBehavior(vals, partnerCreates.length);
      return 1000 + partnerCreates.length;
    }),
    executeKw: vi.fn(async (model, method, args) => {
      calls.executeKw.push({ model, method, args });
      if (model === "ir.sequence" && method === "next_by_code") {
        const v = `${TIN_PREFIX}${String(nextSeqValue).padStart(3, "0")}`;
        nextSeqValue += 1;
        return v;
      }
      return null;
    }),
  };
}

describe("isDuplicateVatError", () => {
  it("matches PG unique constraint on vat", () => {
    expect(
      isDuplicateVatError(new Error("duplicate key value violates unique constraint partner_vat_unique"))
    ).toBe(true);
  });

  it("matches Odoo VAT-already-exists message", () => {
    expect(isDuplicateVatError(new Error("VAT already exists for partner Acme Inc"))).toBe(true);
  });

  it("matches generic 'vat conflict'", () => {
    expect(isDuplicateVatError(new Error("vat conflict on res.partner"))).toBe(true);
  });

  it("does not match unrelated 'country_id is required'", () => {
    expect(isDuplicateVatError(new Error("country_id is required"))).toBe(false);
  });

  it("does not match canonical 'The following fields are required: Tax ID'", () => {
    expect(
      isDuplicateVatError(new Error("The following fields are required: Tax ID, Street"))
    ).toBe(false);
  });

  it("does not match 'Invalid VAT format' (format error, not duplicate)", () => {
    expect(isDuplicateVatError(new Error("Invalid VAT format: must be 9 digits"))).toBe(false);
  });

  it("handles null/undefined input safely", () => {
    expect(isDuplicateVatError(null)).toBe(false);
    expect(isDuplicateVatError(undefined)).toBe(false);
    expect(isDuplicateVatError("")).toBe(false);
  });

  it("handles non-Error throwables (string)", () => {
    expect(isDuplicateVatError("vat already exists")).toBe(true);
  });
});

describe("randomPlaceholderTin", () => {
  it("returns valid 000-000-XXX format", () => {
    for (let i = 0; i < 100; i++) {
      const tin = randomPlaceholderTin();
      expect(tin).toMatch(/^000-000-\d{3}$/);
    }
  });

  it("stays in 100..999 band (avoids legacy 001..099 cluster)", () => {
    for (let i = 0; i < 100; i++) {
      const tin = randomPlaceholderTin();
      const n = parseInt(tin.split("-")[2], 10);
      expect(n).toBeGreaterThanOrEqual(100);
      expect(n).toBeLessThanOrEqual(999);
    }
  });
});

describe("ensureTinSequence", () => {
  it("returns existing sequence id without creating a new one", async () => {
    const odoo = makeMockOdoo({ existingSeq: true });
    const id = await ensureTinSequence(odoo);
    expect(id).toBe(99);
    expect(odoo.calls.create).toHaveLength(0);
  });

  it("creates sequence with number_next=1 when no legacy partners", async () => {
    const odoo = makeMockOdoo({ existingSeq: false, existingPartners: [] });
    await ensureTinSequence(odoo);
    expect(odoo.calls.create).toHaveLength(1);
    const seqVals = odoo.calls.create[0].vals;
    expect(seqVals.code).toBe(TIN_SEQUENCE_CODE);
    expect(seqVals.prefix).toBe(TIN_PREFIX);
    expect(seqVals.padding).toBe(3);
    expect(seqVals.number_next).toBe(1);
    expect(seqVals.implementation).toBe("standard");
  });

  it("seeds sequence past max existing legacy placeholder TIN", async () => {
    const odoo = makeMockOdoo({
      existingSeq: false,
      existingPartners: [
        { vat: "000-000-001" },
        { vat: "000-000-005" },
        { vat: "000-000-003" },
        { vat: "real-tin-123" },
        { vat: "" },
        { vat: null },
      ],
    });
    await ensureTinSequence(odoo);
    expect(odoo.calls.create[0].vals.number_next).toBe(6);
  });

  it("handles searchRead returning null for partners (defensive)", async () => {
    const odoo = makeMockOdoo({ existingSeq: false });
    odoo.searchRead = vi.fn(async (model) => {
      if (model === "ir.sequence") return [];
      return null;
    });
    const id = await ensureTinSequence(odoo);
    expect(id).toBe(99);
  });
});

describe("nextSequentialTin", () => {
  it("returns formatted TIN from ir.sequence.next_by_code", async () => {
    const odoo = makeMockOdoo({ existingSeq: true });
    const tin = await nextSequentialTin(odoo);
    expect(tin).toBe("000-000-001");
    expect(odoo.calls.executeKw[0]).toEqual({
      model: "ir.sequence",
      method: "next_by_code",
      args: [TIN_SEQUENCE_CODE],
    });
  });

  it("advances on each call", async () => {
    const odoo = makeMockOdoo({ existingSeq: true });
    expect(await nextSequentialTin(odoo)).toBe("000-000-001");
    expect(await nextSequentialTin(odoo)).toBe("000-000-002");
    expect(await nextSequentialTin(odoo)).toBe("000-000-003");
  });
});

describe("createVendorWithPlaceholderTin", () => {
  it("creates vendor on first sequential attempt", async () => {
    const odoo = makeMockOdoo({ existingSeq: true });
    const result = await createVendorWithPlaceholderTin(odoo, { name: "Test Vendor" });
    expect(result.strategy).toBe("sequential");
    expect(result.attempt).toBe(1);
    expect(result.vat).toBe("000-000-001");
    expect(result.id).toBeGreaterThan(0);

    expect(odoo.partnerCreates).toHaveLength(1);
    expect(odoo.partnerCreates[0].name).toBe("Test Vendor");
    expect(odoo.partnerCreates[0].vat).toBe("000-000-001");
  });

  it("retries on duplicate-VAT error and advances sequence", async () => {
    const odoo = makeMockOdoo({
      existingSeq: true,
      createBehavior: (vals) => {
        if (vals.vat === "000-000-001") {
          throw new Error("duplicate key value violates unique constraint partner_vat_unique");
        }
        return 1234;
      },
    });
    const result = await createVendorWithPlaceholderTin(odoo, { name: "Test" });
    expect(result.strategy).toBe("sequential");
    expect(result.attempt).toBe(2);
    expect(result.vat).toBe("000-000-002");
    expect(result.id).toBe(1234);
  });

  it("falls back to random after exhausting sequential attempts", async () => {
    let calls = 0;
    const odoo = makeMockOdoo({
      existingSeq: true,
      createBehavior: () => {
        calls += 1;
        if (calls <= 5) throw new Error("VAT already exists");
        return 9999;
      },
    });
    const result = await createVendorWithPlaceholderTin(odoo, { name: "Test" });
    expect(result.strategy).toBe("random");
    expect(result.attempt).toBe(6);
    expect(result.vat).toMatch(/^000-000-\d{3}$/);
    expect(result.id).toBe(9999);
  });

  it("respects custom maxSequential / maxRandom", async () => {
    let calls = 0;
    const odoo = makeMockOdoo({
      existingSeq: true,
      createBehavior: () => {
        calls += 1;
        if (calls <= 2) throw new Error("vat duplicate");
        return 7777;
      },
    });
    const result = await createVendorWithPlaceholderTin(
      odoo,
      { name: "Test" },
      { maxSequential: 2, maxRandom: 5 }
    );
    expect(result.strategy).toBe("random");
    expect(result.attempt).toBe(3);
  });

  it("throws after exhausting all retries with full collision detail", async () => {
    const odoo = makeMockOdoo({
      existingSeq: true,
      createBehavior: () => {
        throw new Error("vat already exists");
      },
    });
    await expect(createVendorWithPlaceholderTin(odoo, { name: "Test" })).rejects.toThrow(
      /Exhausted placeholder TIN strategies \(10 collisions\)/
    );
  });

  it("bubbles non-duplicate errors immediately without retrying", async () => {
    let calls = 0;
    const odoo = makeMockOdoo({
      existingSeq: true,
      createBehavior: () => {
        calls += 1;
        throw new Error("country_id is required");
      },
    });
    await expect(createVendorWithPlaceholderTin(odoo, { name: "Test" })).rejects.toThrow(
      /country_id is required/
    );
    expect(calls).toBe(1);
  });

  it("bubbles canonical UserError immediately (does not match duplicate matcher)", async () => {
    let calls = 0;
    const odoo = makeMockOdoo({
      existingSeq: true,
      createBehavior: () => {
        calls += 1;
        throw new Error("The following fields are required: Tax ID, Street, City");
      },
    });
    await expect(createVendorWithPlaceholderTin(odoo, { name: "Test" })).rejects.toThrow(
      /The following fields are required/
    );
    expect(calls).toBe(1);
  });

  it("preserves baseVals across retries (does not mutate caller's object)", async () => {
    const baseVals = { name: "Test", street: "123 Main", supplier_rank: 1 };
    const original = { ...baseVals };
    const odoo = makeMockOdoo({
      existingSeq: true,
      createBehavior: (vals) => {
        if (vals.vat === "000-000-001") throw new Error("vat duplicate");
        return 1234;
      },
    });
    await createVendorWithPlaceholderTin(odoo, baseVals);
    expect(baseVals).toEqual(original);
  });
});
