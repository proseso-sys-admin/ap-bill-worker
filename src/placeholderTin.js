/**
 * Placeholder TIN allocator for vendor backfill.
 *
 * The canonical proseso-ventures contact-validation automation requires a
 * non-empty `vat` on PH vendor partners. When OCR cannot extract a TIN, we
 * mint a placeholder in the form `000-000-NNN` (matches Odoo PH localization
 * format `^\d{3}-?\d{3}-?\d{3}(-?\d{3,5})?$`).
 *
 * Allocation strategy (Option B — resilient):
 *   1. Sequential via `ir.sequence` row-locked by Postgres (race-safe across
 *      concurrent worker instances).
 *   2. On duplicate-VAT collisions (legacy data, manual entries), retry up to
 *      5 times — sequence advances each call.
 *   3. If sequential is jammed, fall back to randomized values in the same
 *      `000-000-XXX` band for up to 5 more attempts.
 *   4. On exhaustion, throw with full collision detail so the bill caller can
 *      route to manual review.
 *
 * Non-duplicate errors (canonical "fields are required", "Invalid field X")
 * bubble immediately — never swallowed.
 */

const TIN_SEQUENCE_CODE = "ap_worker.placeholder_tin";
const TIN_PREFIX = "000-000-";
const TIN_PADDING = 3;
const DEFAULT_MAX_SEQUENTIAL = 5;
const DEFAULT_MAX_RANDOM = 5;

async function ensureTinSequence(odoo) {
  const existing = await odoo.searchRead(
    "ir.sequence",
    [["code", "=", TIN_SEQUENCE_CODE]],
    ["id"],
    { limit: 1 }
  );
  if (existing && existing.length) return Number(existing[0].id);

  const partners = await odoo.searchRead(
    "res.partner",
    [["vat", "=like", `${TIN_PREFIX}%`]],
    ["vat"],
    {}
  );
  let maxN = 0;
  const re = new RegExp(`^${TIN_PREFIX.replace(/-/g, "\\-")}(\\d{${TIN_PADDING}})$`);
  for (const p of partners || []) {
    const m = re.exec(String(p.vat || ""));
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxN) maxN = n;
    }
  }

  return odoo.create("ir.sequence", {
    name: "AP Worker placeholder TIN",
    code: TIN_SEQUENCE_CODE,
    prefix: TIN_PREFIX,
    padding: TIN_PADDING,
    number_increment: 1,
    number_next: maxN + 1,
    implementation: "standard",
  });
}

async function nextSequentialTin(odoo) {
  await ensureTinSequence(odoo);
  const value = await odoo.executeKw("ir.sequence", "next_by_code", [TIN_SEQUENCE_CODE]);
  return String(value || "");
}

function randomPlaceholderTin() {
  const n = Math.floor(Math.random() * 900) + 100;
  return `${TIN_PREFIX}${String(n).padStart(TIN_PADDING, "0")}`;
}

function isDuplicateVatError(err) {
  const msg = String(err && err.message ? err.message : err || "");
  // No \b boundaries: underscores count as word chars in JS, so \bvat\b would
  // miss PG constraint names like `partner_vat_unique`. False-positive risk
  // (e.g. "private") is gated by the second clause requiring a duplicate-flavored keyword.
  return /vat/i.test(msg) && /(duplicate|already|exists|unique|conflict)/i.test(msg);
}

async function createVendorWithPlaceholderTin(odoo, baseVals, opts = {}) {
  const maxSequential = Number.isFinite(opts.maxSequential) ? opts.maxSequential : DEFAULT_MAX_SEQUENTIAL;
  const maxRandom = Number.isFinite(opts.maxRandom) ? opts.maxRandom : DEFAULT_MAX_RANDOM;
  const errors = [];

  for (let i = 0; i < maxSequential; i++) {
    const tin = await nextSequentialTin(odoo);
    try {
      const id = await odoo.create("res.partner", { ...baseVals, vat: tin });
      return { id: Number(id), vat: tin, strategy: "sequential", attempt: i + 1 };
    } catch (err) {
      if (!isDuplicateVatError(err)) throw err;
      errors.push({ tin, msg: String(err && err.message ? err.message : err) });
    }
  }

  for (let i = 0; i < maxRandom; i++) {
    const tin = randomPlaceholderTin();
    try {
      const id = await odoo.create("res.partner", { ...baseVals, vat: tin });
      return { id: Number(id), vat: tin, strategy: "random", attempt: maxSequential + i + 1 };
    } catch (err) {
      if (!isDuplicateVatError(err)) throw err;
      errors.push({ tin, msg: String(err && err.message ? err.message : err) });
    }
  }

  const detail = errors.map((e) => `${e.tin}: ${e.msg}`).join(" | ");
  throw new Error(`Exhausted placeholder TIN strategies (${errors.length} collisions): ${detail}`);
}

module.exports = {
  TIN_SEQUENCE_CODE,
  TIN_PREFIX,
  TIN_PADDING,
  ensureTinSequence,
  nextSequentialTin,
  randomPlaceholderTin,
  isDuplicateVatError,
  createVendorWithPlaceholderTin,
};
