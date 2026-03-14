# Cost estimate: 30 databases × 50 files/month (concurrent)

**Scenario:** AP Bill OCR worker running across **30 databases**, **50 files/month per database** = **1,500 files/month** total, with runs happening **concurrently** (e.g. 30 targets polled in parallel or 30 scheduler jobs at once).

---

## 1. Volume summary

| Item | Value |
|------|--------|
| Databases (targets) | 30 |
| Files per database per month | 50 |
| **Total files per month** | **1,500** |
| Concurrency | 30 DBs processed in parallel (e.g. one run per target) |

---

## 2. Cost drivers per file

Each file goes through:

1.  **Vision API** – OCR (image: 1–2 calls; PDF: 1 async job, billed per page).
2.  **Gemini – extraction** – 1 call (`extractInvoiceWithGemini`: prompt + OCR text + optional inline image).
3.  **Gemini – account assignment** – 1 call (`assignAccountsWithGemini`: text only, when expense accounts exist).
4.  **Gemini - vendor research** - 1 call (`researchVendorWithGemini`: text only, researches vendor name using Google Search).

Current config uses **`gemini-3-pro-preview`** with fallback **`gemini-2.5-pro`**. Pricing below uses **Gemini 3 Pro** standard (non-batch) and **Vision DOCUMENT_TEXT_DETECTION** tier 1.

---

## 3. Vision API

- **Pricing:** First 1,000 units/month free; then **$1.50 per 1,000 units** (up to 5M).
- **Units:** 1 image = 1 unit; PDF = **1 unit per page**. Some images trigger a second call (TEXT_DETECTION fallback) = +1 unit.

**Assumptions:**

- ~60% single-page (images or 1-page PDFs): 900 × 1 = 900 units.
- ~40% multi-page PDFs, average 4 pages: 600 × 4 = 2,400 units.
- ~15% of images use fallback: 225 extra units.

**Total Vision units/month:** 900 + 2,400 + 225 ≈ **3,525**.

**Cost:** (3,525 − 1,000) × ($1.50 / 1,000) ≈ **$3.79/month**.

*(If most files are single-page: ~2,250 units → **$1.88/month**.)*

---

## 4. Gemini API (gemini-3-pro-preview)

**Pricing (standard, prompts ≤200k tokens):**

- Input: **$2.00 per 1M tokens**
- Output: **$12.00 per 1M tokens**

**Token assumptions per file:**

| Call | Input (tokens) | Output (tokens) |
|------|-----------------|-----------------|
| Extraction (prompt + OCR + optional image) | ~6,000 | ~800 |
| Account assignment (prompt + accounts + lines) | ~3,000 | ~500 |
| Vendor Research (prompt + vendor name) | ~500 | ~200 |

**Monthly totals (1,500 files):**

- Extraction: 1,500 × (6,000 in + 800 out) = 9M in, 1.2M out.
- Account assignment: 1,500 × (3,000 in + 500 out) = 4.5M in, 0.75M out.
- Vendor Research: 1,500 x (500 in + 200 out) = 0.75M in, 0.3M out.

**Combined:** 14.25M input, 2.25M output.

**Cost:**

- Input: 14.25 × $2.00 = **$28.50**
- Output: 2.25 × $12.00 = **$27.00**
- **Gemini total ≈ $55.50/month.**

*(Retries/fallback to gemini-2.5-pro add a small buffer; 2.5 Pro is slightly cheaper, so round to **~$55–60/month** for Gemini.)*

---

## 5. Cloud Run

- **RUN_BUDGET_MS:** 1,500,000 ms (25 min) per run in your config.
- **Concurrency:** 30 databases → up to 30 concurrent containers if each target has its own trigger.
- **Per-file time:** Roughly 30–90 s (Vision OCR + 2 Gemini calls + Odoo/Sheets). So ~50 files per run ≈ 25–75 min total; your 25 min budget can cover on the order of ~20–40 docs per run per target.

**Rough CPU/memory:** Assume 1 vCPU, 512 MiB, 30 concurrent runs, 2 runs per target per month (e.g. 2 scheduler runs), 15 min average per run:

- 30 × 2 × 15 min = 900 min = 54,000 vCPU-seconds, 27,000 GiB-seconds.
- At list rates (~$0.00002400/vCPU-s, ~$0.00000250/GiB-s): **~$1.30 + $0.07 ≈ $1.40/month** (order of magnitude).

So **Cloud Run is small** compared to Gemini/Vision unless you run very frequently or with large CPU/memory.

---

## 6. Other (GCS, Sheets, Odoo)

- **GCS:** PDF staging (upload + OCR output), optional state objects. For 1,500 files and modest object sizes, **< $1/month**.
- **Sheets API:** Routing/account reads; well within free tier.
- **Odoo:** Your infrastructure; no direct GCP cost.

---

## 7. Total estimated cost (monthly)

| Component | Low | Mid | High |
|-----------|-----|-----|------|
| Vision API | $1.88 | $3.79 | $5.50 |
| Gemini (3 Pro) | $53 | $57 | $63 |
| Cloud Run | $1 | $2 | $5 |
| GCS / other | $0.50 | $1 | $2 |
| **Total** | **~$56** | **~$64** | **~$75** |

**Summary:** **About $60–65/month** for 1,500 files across 30 databases running concurrently, with Vision and Gemini (gemini-3-pro-preview) as the main cost.

---

## 8. Cost reduction options

1.  **Gemini:** Use **gemini-2.5-pro** as primary (input $1.25/1M, output $10/1M) → saves ~20–25% on Gemini (~**$12–15/month**).
2.  **Gemini Batch API:** 50% discount for non-real-time; if you can queue extraction/account calls and process in batch, Gemini cost could drop by ~50% (workflow change required).
3.  **Vision:** Reduce PDF page cap (`PDF_OCR_MAX_PAGES`) or skip very long PDFs to lower units.
4.  **Concurrency:** Fewer concurrent runs (e.g. sequential or batched targets) don’t change Vision/Gemini volume; they only affect Cloud Run scaling and burst.

---

## 9. Scaling (order of magnitude)

| Files/month | Vision (mid) | Gemini (mid) | Total (approx) |
|-------------|--------------|--------------|----------------|
| 1,500 | ~$4 | ~$57 | **~$64** |
| 3,000 | ~$8 | ~$114 | **~$125** |
| 5,000 | ~$14 | ~$190 | **~$210** |

Cost scales roughly linearly with file count; concurrency (30 DBs) mainly affects latency and Cloud Run instance count, not API volume.

---

*Pricing references: [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing), [Cloud Vision pricing](https://cloud.google.com/vision/pricing). Config: `GEMINI_MODEL=gemini-3-pro-preview`, `DOCS_BATCH_LIMIT=50`, `PDF_OCR_MAX_PAGES=80`.*
