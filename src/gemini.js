// @ts-nocheck
const { safeJsonParse, sleep } = require("./utils");
const { loadFeedbackCorrections } = require("./gcsFeedback");

const RETRYABLE_STATUS = new Set([429, 500, 503]);
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 3000;

async function geminiRequest(model, apiKey, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await resp.text();
  return { resp, text };
}

async function geminiWithRetryAndFallback(config, body, { throwOnFail = true } = {}) {
  const primary = config.gemini.model;
  const fallback = config.gemini.fallbackModel || "";
  const models = fallback && fallback !== primary ? [primary, fallback] : [primary];
  let lastError = null;

  for (const model of models) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let resp, text;
      try {
        ({ resp, text } = await geminiRequest(model, config.gemini.apiKey, body));
      } catch (fetchErr) {
        lastError = fetchErr;
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_BASE_MS * (attempt + 1));
          continue;
        }
        break;
      }
      if (resp.ok) return { text, model };
      if (!RETRYABLE_STATUS.has(resp.status) || attempt === MAX_RETRIES) {
        lastError = new Error(`Gemini request failed: HTTP ${resp.status} ${text.slice(0, 600)}`);
        if (model === models[models.length - 1]) {
          if (throwOnFail) throw lastError;
          return null;
        }
        break;
      }
      await sleep(RETRY_BASE_MS * (attempt + 1));
    }
  }
  if (throwOnFail && lastError) throw lastError;
  return null;
}

const extractionSchema = {
  type: "object",
  properties: {
    vendor: {
      type: "object",
      properties: {
        name: { type: "string" },
        confidence: { type: "number" },
        source: { type: "string", description: "header|body|atp_printer_box|unknown" }
      },
      required: ["name", "confidence", "source"]
    },
    vendor_candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          confidence: { type: "number" },
          source: { type: "string", description: "header|body|atp_printer_box|unknown" }
        },
        required: ["name", "confidence", "source"]
      }
    },
    vendor_details: {
      type: "object",
      properties: {
        tin: { type: "string" },
        branch_code: { type: "string" },
        address: {
          type: "object",
          properties: {
            street: { type: "string", description: "Street name and number, building name" },
            street2: { type: "string", description: "Apartment, suite, unit, etc." },
            city: { type: "string", description: "City or municipality" },
            state: { type: "string", description: "Province or state" },
            zip: { type: "string", description: "Postal or ZIP code" },
            country: { type: "string", description: "Country name" }
          }
        },
        entity_type: { type: "string", description: "corporation|sole_proprietor|individual|unknown" },
        trade_name: { type: "string", description: "Business/trade name (DBA). For sole proprietors this is the shop/store name that differs from the owner's personal name" },
        proprietor_name: {
          type: "object",
          description: "Owner/proprietor personal name if entity is a sole proprietor",
          properties: {
            first_name: { type: "string" },
            middle_name: { type: "string" },
            last_name: { type: "string" }
          }
        }
      },
      required: ["tin", "branch_code", "address", "entity_type", "trade_name", "proprietor_name"]
    },
    expense_account_hint: {
      type: "object",
      properties: {
        category: { type: "string", description: "office_supplies|meals|repairs|rent|fuel|professional_fees|freight|other" },
        suggested_account_name: { type: "string" },
        confidence: { type: "number" },
        evidence: { type: "string" }
      },
      required: ["category", "suggested_account_name", "confidence", "evidence"]
    },
    invoice: {
      type: "object",
      properties: {
        number: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        date_confidence: { type: "number" },
        currency: { type: "string" }
      },
      required: ["number", "date", "date_confidence", "currency"]
    },
    vat: {
      type: "object",
      properties: {
        classification: { type: "string", description: "vatable|exempt|zero_rated|unknown" },
        goods_or_services: { type: "string", description: "goods|services|unknown" },
        vatable_base: { type: "number" },
        vatable_base_confidence: { type: "number" },
        vat_amount: { type: "number" },
        vat_amount_confidence: { type: "number" },
        exempt_amount: { type: "number" },
        exempt_amount_confidence: { type: "number" },
        zero_rated_amount: { type: "number" },
        zero_rated_amount_confidence: { type: "number" },
        evidence: { type: "string" }
      },
      required: [
        "classification", "goods_or_services",
        "vatable_base", "vatable_base_confidence",
        "vat_amount", "vat_amount_confidence",
        "exempt_amount", "exempt_amount_confidence",
        "zero_rated_amount", "zero_rated_amount_confidence",
        "evidence"
      ]
    },
    totals: {
      type: "object",
      properties: {
        grand_total: { type: "number", description: "Total amount due (final amount to pay, VAT-inclusive if applicable)" },
        grand_total_confidence: { type: "number" },
        tax_total: { type: "number" },
        tax_total_confidence: { type: "number" },
        net_total: { type: "number", description: "Total BEFORE VAT (vatable base / net of tax). If invoice only shows a VAT-inclusive total, compute net_total = grand_total / 1.12 for vatable invoices" },
        net_total_confidence: { type: "number" },
        vat_exempt_amount: { type: "number" },
        vat_exempt_amount_confidence: { type: "number" },
        zero_rated_amount: { type: "number" },
        zero_rated_amount_confidence: { type: "number" },
        amounts_are_vat_inclusive: { type: "boolean", description: "true if the grand_total and line item prices already include VAT (common in PH receipts/invoices)" }
      },
      required: [
        "grand_total", "grand_total_confidence",
        "tax_total", "tax_total_confidence",
        "net_total", "net_total_confidence",
        "vat_exempt_amount", "vat_exempt_amount_confidence",
        "zero_rated_amount", "zero_rated_amount_confidence",
        "amounts_are_vat_inclusive"
      ]
    },
    amount_candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          amount: { type: "number" },
          confidence: { type: "number" },
          snippet: { type: "string" }
        },
        required: ["label", "amount", "confidence", "snippet"]
      }
    },
    line_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          quantity: { type: "number" },
          unit_price: { type: "number" },
          amount: { type: "number" },
          unit_price_includes_vat: { type: "boolean", description: "true if the unit_price shown on the invoice already includes VAT" },
          discount_percent: { type: "number", description: "Discount percentage applied to this line (0-100). 0 if no discount. E.g. 5 means 5% discount, so net = unit_price * qty * (1 - 5/100)" },
          expense_category: { type: "string", description: "office_supplies|meals|repairs|rent|fuel|professional_fees|freight|utilities|inventory|equipment|other" },
          goods_or_services: { type: "string", description: "Per-line: goods|services|unknown. 'goods' for physical items/supplies/inventory. 'services' for labor/consulting/professional fees/rent/repairs/subscriptions/SaaS." },
          is_capital_goods: { type: "boolean", description: "true if this line is a capital asset/equipment purchase (machinery, vehicles, computers, furniture, fixtures, PPE/property-plant-equipment). false for consumable supplies." },
          is_imported: { type: "boolean", description: "true if this line item is clearly imported from abroad (foreign supplier, customs duties mentioned, import documentation). false if domestic or unclear." },
          vat_code: { type: "string", description: "Per-line VAT treatment: vatable|exempt|zero_rated|no_vat. Use 'no_vat' when the line explicitly says NO VAT or is non-vatable. Use 'vatable' when VAT applies." }
        },
        required: ["description", "quantity", "unit_price", "amount", "discount_percent", "unit_price_includes_vat", "expense_category", "goods_or_services", "is_capital_goods", "is_imported", "vat_code"]
      }
    },
    warnings: { type: "array", items: { type: "string" } }
  },
  required: [
    "vendor", "vendor_candidates",
    "invoice",
    "vat",
    "totals",
    "amount_candidates",
    "line_items",
    "vendor_details",
    "expense_account_hint"
  ]
};

function buildPrompt(ocrText) {
  return `Extract a vendor bill/receipt for Accounts Payable.
Return JSON strictly matching the provided schema (no extra keys).
All confidence fields must be between 0 and 1.

CRITICAL PH RECEIPT RULES:
- The "ATP / BIR Permit / Printer's Accreditation / Printer info" box is NOT the vendor.
- Ignore names near keywords: "ATP", "BIR Permit", "Printer", "Accreditation", "Date issued", "O.R. No.", "VAT Reg. TIN" when those appear inside printer/ATP blocks.
- The vendor is the SELLER/ISSUER (usually top header near "OFFICIAL RECEIPT", "SALES INVOICE", or company address), not the printing company.

VENDOR IDENTITY — SAME BRAND, DIFFERENT LEGAL ENTITIES (CRITICAL):
- Invoices may mention multiple related names (e.g. "Proseso Consulting", "Proseso Outsourcing Services Inc.", "Proseso Consulting Pte. Ltd."). The vendor for THIS invoice is the legal entity that IS ISSUING this document and receiving payment.
- PREFER in this order: (1) The exact name in "Account Name" or "Bank Account Name" in the payment/bank details section — that is who gets paid. (2) The company name in the footer or letterhead that appears on every page as the issuer. (3) The name next to the issuer address (e.g. "Proseso Outsourcing Services Inc." above "3rd Floor, ABC Building...").
- DO NOT use: the name from the website URL (e.g. proseso-consulting.com), or from generic boilerplate like "Payments to Proseso Consulting" or "Proseso Consulting, as a service provider". Those refer to the brand, not necessarily the legal issuer.
- If the document shows "Pte. Ltd." (Singapore) in one place and "Inc." (Philippines) in another, and the bank details or footer show the Philippine entity, the vendor is the Philippine entity (Inc.), not the Singapore one (Pte. Ltd.), unless the invoice is clearly issued by the Singapore entity.
- vendor_details.address must be the address of the ISSUER (the vendor), not the client/customer. The client is who is being billed; the vendor is who sent the invoice and receives payment.

OUTPUT REQUIREMENTS:
- vendor.source must be one of: header|body|atp_printer_box|unknown
- vendor_candidates should include up to 5 plausible vendors with source + confidence.
- amount_candidates should list ALL important amounts you see with label + confidence + a short snippet where it came from.
- totals.* may be best guess, but if uncertain, lower confidence and add warnings.

AMOUNT INTEGRITY RULES (CRITICAL):
- grand_total MUST be the FINAL TOTAL / AMOUNT DUE on the invoice — the bottom-line number the buyer owes. It must NOT be a subtotal, a single line item amount, a VAT amount, or any intermediate number. If the invoice has multiple line items, the grand_total MUST be larger than any single line item.
- CROSS-CHECK: If you extracted line items, SUM them. The grand_total must be >= the sum of all line item amounts (possibly with VAT on top). If grand_total < line item sum, you likely picked the wrong number as grand_total.
- NEVER "correct" a line item amount downward to match a smaller total. If qty x unit_price gives a larger number than the OCR total, the total OCR is likely wrong, not the line item.
- Handwritten amounts are often misread. Common OCR confusions: "0" vs empty space, "5" vs "S", missing trailing zeros (e.g. "1045" should be "10450" or "10500").
- Cross-check: qty x unit_price should equal the line amount. If the math works for one reading but not another, trust the one where the math works.
- When line item math (qty x unit_price) and the printed/written total disagree, prefer the reading where the arithmetic is consistent, NOT just the larger one.
- IMPORTANT: The grand total should be PLAUSIBLE given the line items. If line items sum to ~26000, the grand total cannot be 2800 (that's one line item, not the total). A grand total that is much smaller than the line item sum is almost certainly a misread.
- When the TOTAL line is handwritten and you also have individual line item amounts, cross-check: if the total is wildly different from the sum of readable line items, the total is likely misread. Use the line item sum or the closest amount_candidate instead.
- Put ALL plausible readings of the total in amount_candidates with confidence scores so the system can audit them. Include the line item sum as a candidate if it differs from the printed total.
- NEVER silently drop trailing zeros from amounts. "10500" is NOT the same as "1050" or "1045".
- DECIMAL POINT DETECTION: Handwritten decimal points are easy to miss. If a number like "80177" appears where you would expect ~8017.7, it's likely "8017.7" with a missed decimal.
- CRITICAL: grand_total must NEVER be a VAT/tax component. "VAT Amount: 428.57" or "Tax: 428.57" means the TAX is 428.57, NOT the total. The grand_total is the FINAL amount due (typically vatable_sales + vat_amount, or "Total Amount Due"). If grand_total ≈ tax_total, you picked the WRONG number.
- If tax_total > grand_total, you definitely have the wrong grand_total (tax cannot exceed total). Re-examine the document.
- EXTRACT ALL LINE ITEMS: Do NOT skip items. If the invoice lists 10 products, extract all 10. The sum of line item amounts should approximately equal the grand_total. If you only found one line item but the invoice clearly has more, re-examine carefully — especially if there is a PDF/image attached.

HANDWRITTEN / LOW-QUALITY OCR RULES:
- Many PH receipts are handwritten. OCR of handwriting is unreliable.
- If the image is available, ALWAYS prefer reading the image directly over the OCR text for amounts, quantities, and item descriptions.
- Use the VENDOR NAME as strong context for item descriptions. E.g., a vendor named "FABRIC TRADING" is selling fabric/cloth/textile, so an unreadable item name is likely a fabric brand or type.
- Common handwriting misreads: "H" vs "N", "R" vs "N", "O" vs "0", "I" vs "1", "S" vs "5". When in doubt, pick the reading that makes semantic sense given the vendor context.

ACCOUNT SUGGESTION REQUIREMENTS:
- Populate expense_account_hint:
  - category: choose best matching category
  - suggested_account_name: a plausible expense account name (human-friendly, not an ID)
  - evidence: short snippet justifying the choice
- USE VENDOR NAME AS CONTEXT: If the vendor name contains keywords like "FABRIC", "GAS", "LUMBER", "HARDWARE", "ELECTRICAL", "FOOD", etc., use that to infer the expense category even if the line item description is unclear or handwritten.
  - "FABRIC TRADING" vendor → category: "inventory" or "supplies", suggested: "Raw Materials" or "Supplies"
  - "GAS STATION" vendor → category: "fuel"
  - "HARDWARE" vendor → category: "supplies" or "repairs"
  - "FOOD" / "CATERING" vendor → category: "meals"

VENDOR DETAIL REQUIREMENTS (PH):
- vendor_details.tin: extract TIN if present (keep formatting)
- vendor_details.branch_code: extract branch code if present
- vendor_details.address: extract issuer address if present
- vendor_details.entity_type: classify the vendor:
  - "corporation" if the name ends with Inc., Corp., Co., LLC, Corporation, etc.
  - "sole_proprietor" if there is BOTH a trade/business name AND a personal owner name (e.g. "Prop.", "Owner:", or a personal name under/near a business name)
  - "individual" if the vendor is clearly a person with no business name
  - "unknown" if you cannot determine
- vendor_details.trade_name: the business/trade name (DBA). For sole proprietors, this is the shop name (e.g. "JORJEL LAUNDRY SHOP"). For corporations, same as vendor.name. Empty if not applicable.
- vendor_details.proprietor_name: the owner/proprietor's personal name if entity is sole_proprietor. Look for keywords like "Prop.", "Owner", "Proprietor", or a personal name printed below/near the business name. Empty string if not a sole proprietor or not found.
  Examples:
  - "JORJEL LAUNDRY SHOP" with "JOCELYN E. SANTOS - Prop." → trade_name="JORJEL LAUNDRY SHOP", proprietor_name="JOCELYN E. SANTOS", entity_type="sole_proprietor"
  - "NONVAT Reg. TIN: 740-326-198-00000" → this is the TIN, not the proprietor
  - "SM PRIME HOLDINGS, INC." → entity_type="corporation", trade_name="SM PRIME HOLDINGS, INC.", proprietor_name=""

PH VAT RULES (IMPORTANT):
- Decide vat.classification (BILL LEVEL — if ANY line has VAT, classification should be "vatable"):
  - "exempt" if ALL lines are VAT Exempt.
  - "zero_rated" if ALL lines are Zero Rated.
  - "vatable" if ANY line has VAT / shows 12% VAT. Even if some lines say "NO VAT", set bill-level to "vatable" when at least one line IS vatable.
  - "unknown" if none of the above.
- Decide vat.goods_or_services:
  - "services" if wording indicates services (professional fees, rentals, repairs, consulting, labor, contractors, etc.).
  - "goods" if it's primarily goods/products (supplies, inventory, materials).
  - "unknown" if unclear.
- Populate these amounts if present:
  - vat.vat_amount
  - vat.vatable_base
  - vat.exempt_amount
  - vat.zero_rated_amount
- Put the key supporting text into vat.evidence.

PER-LINE VAT (CRITICAL — different lines may have different VAT treatment):
- For EACH line_item, set vat_code to one of: vatable | exempt | zero_rated | no_vat
- "no_vat" means the line explicitly says "NO VAT", "Non-VAT", or has no VAT applied.
- "vatable" means the line has VAT (12%).
- "exempt" means the line is VAT-exempt.
- "zero_rated" means the line is zero-rated.
- IMPORTANT: An invoice can have MIXED VAT treatment. For example, a reimbursement line with NO VAT and a service fee line WITH 12% VAT. Each line must have its own vat_code.
- Do NOT assume all lines have the same VAT treatment. Read the taxes column for each line carefully.

PER-LINE GOODS vs SERVICES (CRITICAL for correct PH tax scope):
- For EACH line_item, set goods_or_services:
  - "goods" for physical products, supplies, inventory, raw materials, fuel, food items
  - "services" for labor, consulting, professional fees, rent, repairs, maintenance, subscriptions, SaaS, software licenses, outsourced work, payroll processing
  - "unknown" if genuinely unclear
- Use the vendor type and line description as context. A consulting firm's invoice = services. A hardware store receipt = goods.

PER-LINE CAPITAL GOODS DETECTION:
- Set is_capital_goods = true ONLY for purchases of long-lived assets:
  - Machinery, vehicles, computers, laptops, servers, furniture, fixtures, buildings, land improvements
  - Equipment with useful life > 1 year and significant cost
- Set is_capital_goods = false for:
  - Consumable supplies (paper, ink, cleaning supplies)
  - Inventory for resale
  - Regular services
  - Low-value items (office supplies, small tools)

PER-LINE IMPORT DETECTION:
- Set is_imported = true when:
  - The invoice mentions customs duties, import fees, or BOC (Bureau of Customs)
  - The vendor is clearly a foreign company shipping goods INTO the Philippines
  - The item description mentions "imported" explicitly
- Set is_imported = false for:
  - Services (even from foreign vendors — those are non-resident services, not imports)
  - Locally purchased goods
  - When unclear, default to false

Also copy exempt/zero-rated amounts into:
- totals.vat_exempt_amount, totals.zero_rated_amount (if known).

VAT-INCLUSIVE PRICE DETECTION (CRITICAL):
- Most PH receipts/invoices show prices that ALREADY INCLUDE 12% VAT.
- Set totals.amounts_are_vat_inclusive = true if the line item prices and grand_total include VAT.
  - Indicators: "Total Sales (VAT Inclusive)", or the grand total equals vatable_base + vat_amount, or line prices × qty = grand total and a separate VAT amount is shown.
  - If the invoice shows a separate "Vatable Sales" (net) amount and a "VAT Amount", the unit prices are typically VAT-inclusive.
- Set line_items[].unit_price_includes_vat = true for each line where the unit price includes VAT.
- totals.net_total should ALWAYS be the VAT-exclusive amount (before tax). If only a VAT-inclusive total is shown, compute: net_total = grand_total / 1.12 for vatable invoices.
- totals.grand_total should be the final amount due (what the buyer actually pays).

OCR TEXT:
${ocrText || "(no OCR text available)"}

LINE ITEM CATEGORIZATION:
- For each line_items[] entry, set expense_category to the best matching category based on the item description AND vendor context:
  office_supplies, meals, repairs, rent, fuel, professional_fees, freight, utilities, inventory, supplies, other
- Examples: LPG/gas/diesel -> "fuel", paper/ink/toner -> "office_supplies", electricity/water -> "utilities",
  consulting/legal/audit -> "professional_fees", food/catering -> "meals", shipping/delivery -> "freight",
  fabric/cloth/textile/thread -> "inventory" or "supplies", hardware/tools -> "supplies", lumber/cement -> "inventory"
- If the item description is unreadable or a brand name (e.g. "Hiroshi #7" from a fabric vendor), use the VENDOR NAME to determine the category. A fabric vendor sells fabric → "inventory" or "supplies", NOT "other".

PERMIT / LICENSE FEE DISTINCTION (CRITICAL):
- "Taxes and Licenses" (or similar) accounts are for the ACTUAL government fee — the amount paid directly to the government for a permit, license, or tax assessment.
- If a PRIVATE COMPANY (e.g. a consulting or services firm) is invoicing for PROCESSING or HANDLING a permit/license application on your behalf, that is a SERVICE FEE → category: "professional_fees", suggested: "Professional Fees" or "Outside Services".
- Keywords that signal a SERVICE FEE (→ professional_fees): "processing", "assistance", "facilitation", "handling", "filing", "preparation", "renewal service", "registration service".
- Keywords that signal the ACTUAL GOVERNMENT LICENSE/TAX (→ taxes/licenses): "business permit fee", "mayor's permit", "LTO fee", "BIR registration", "barangay clearance fee" — when paid directly to the issuing government agency.
- Example: Proseso Consulting invoicing for "Business Permit processing" → professional_fees (they are charging for their service, not the permit itself).

DISCOUNT DETECTION (CRITICAL):
- Look for a "Disc.%", "Discount", or "Disc" column on the invoice.
- If a line shows a discount (e.g. 5%, 10%), set discount_percent to that value (e.g. 5, 10).
- Verify: amount should equal unit_price * quantity * (1 - discount_percent/100).
- If there is no discount column or the discount is 0, set discount_percent to 0.
- unit_price must be the ORIGINAL price BEFORE discount. amount is the final line total AFTER discount.
- Do NOT bake the discount into unit_price. Keep them separate.

CURRENCY DETECTION (CRITICAL):
- Look for currency SYMBOLS and CODES on the invoice:
  - "$" alone with a Singapore address/company → "SGD"
  - "$" alone with a US address → "USD"
  - "S$" → "SGD"
  - "₱" or "Php" or "PHP" or "P" (with PH context) → "PHP"
  - "€" → "EUR"
  - "£" → "GBP"
  - "¥" or "JPY" → "JPY"
  - "RM" → "MYR"
  - "HK$" → "HKD"
- If the invoice shows "$" but the vendor/client is in Singapore, assume SGD not USD.
- NEVER leave currency blank if there are currency symbols on the invoice. Use context clues (vendor country, client country) to disambiguate "$".

YEAR vs AMOUNT CONFUSION (CRITICAL):
- Text like "November 2025", "October 2025", "FY 2025" contains the YEAR, not an amount.
- NEVER EVER extract 2024, 2025, 2026, or similar year-like numbers as grand_total, net_total, or line item amounts. If you are about to output "2025" as a total or price, STOP. You are mistakenly reading a date as an amount. Find the actual monetary value (e.g., 530).
- Cross-check: if the line items sum to a number like 530 but you extracted 2025 as grand_total, the 2025 is a date string, not the total.

DATE FORMAT RULES (CRITICAL):
- invoice.date must be YYYY-MM-DD (best guess; if unknown, empty string + low confidence).
- NEVER assume date format based on vendor location or country. A Singapore vendor does NOT mean DD/MM/YYYY. A US vendor does NOT mean MM/DD/YYYY by default.
- The ONLY safe way to determine format is from the document itself:
  - If the document explicitly writes the month as text (e.g. "March 11, 2026", "11 Nov 2026", "11-Mar-26") → parse literally.
  - If the document uses numeric separators only (e.g. "03/11/2026"), treat it as MM/DD/YYYY UNLESS the first number is > 12 (in which case it must be DD/MM/YYYY).
  - When ambiguous (both values ≤ 12), default to MM/DD/YYYY — do NOT flip to DD/MM/YYYY just because the vendor is from a country that commonly uses that format.
- Add a warning if the date format is genuinely ambiguous.

Rules:
- line_items may be [] if not confident.
- NEVER default to "other" category if the vendor name gives a clear hint about what they sell.`;
}

async function extractInvoiceWithGemini(ocrText, config, attachment, userHint = "") {
  let promptText = buildPrompt(ocrText);
  if (userHint) {
    promptText += `\n\nUSER HINT (CRITICAL - prioritize this info):\n${userHint}`;
  }
  const parts = [{ text: promptText }];

  const mimetype = String(attachment?.mimetype || "").toLowerCase();
  const canInline = mimetype.startsWith("image/") || mimetype === "application/pdf";
  if (canInline && attachment?.datas) {
    parts.push({
      inlineData: { mimeType: mimetype, data: attachment.datas }
    });
  }

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: extractionSchema
    }
  };

  const result = await geminiWithRetryAndFallback(config, body, { throwOnFail: true });
  const data = safeJsonParse(result.text, {});
  const raw =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n") ||
    "{}";

  const extracted = safeJsonParse(raw, {});
  if (!extracted || typeof extracted !== "object") return {};
  return extracted;
}

const accountCandidateSchema = {
  type: "object",
  properties: {
    account_id: { type: "number", description: "Account ID from the provided list" },
    account_code: { type: "string", description: "Account code (e.g. '510100')" },
    account_name: { type: "string", description: "Account name (e.g. 'Office Supplies')" },
    confidence: { type: "number", description: "0-1 confidence" }
  },
  required: ["account_id", "account_code", "account_name", "confidence"]
};

const accountAssignmentSchema = {
  type: "object",
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line_index: { type: "number", description: "0-based index into the line_items array" },
          account_id: { type: "number", description: "The best matching account ID from the provided list" },
          account_code: { type: "string", description: "The code of the chosen account" },
          account_name: { type: "string", description: "The name of the chosen account" },
          confidence: { type: "number", description: "0-1 confidence in the match" },
          reasoning: { type: "string", description: "Brief explanation of why this account was chosen" },
          alternatives: {
            type: "array",
            description: "2nd and 3rd best account choices, ordered by preference",
            items: accountCandidateSchema
          }
        },
        required: ["line_index", "account_id", "account_code", "account_name", "confidence", "reasoning", "alternatives"]
      }
    },
    bill_level_account_id: { type: "number", description: "Best overall account_id if only one account is used for the whole bill" },
    bill_level_account_code: { type: "string" },
    bill_level_account_name: { type: "string" },
    bill_level_confidence: { type: "number" }
  },
  required: ["assignments", "bill_level_account_id", "bill_level_account_code", "bill_level_account_name", "bill_level_confidence"]
};

async function assignAccountsWithGemini(extracted, expenseAccounts, config, targetKey, industry, ocrText, vendorResearch) {
  if (!expenseAccounts?.length) return null;

  const lineItems = extracted?.line_items || [];
  const hint = extracted?.expense_account_hint || {};
  const feedbackList = await loadFeedbackCorrections(String(targetKey || "").trim(), String(industry || "").trim(), 20);
  const feedbackSection =
    feedbackList.length > 0
      ? `
LEARNED FROM PAST CORRECTIONS (prefer these when they apply):
${feedbackList
  .map(
    (r) =>
      `- Vendor "${r.vendor_name}" / item "${r.item_description}": was corrected from [${r.original_account_code}] ${r.original_account_name} → use [${r.corrected_account_code}] ${r.corrected_account_name}`
  )
  .join("\n")}
When the vendor or item matches above, prefer the corrected account.
`
      : "";

  const accountList = expenseAccounts
    .map((a) => `  ${a.id}: [${a.code}] ${a.name}`)
    .join("\n");

  const lineDesc = lineItems.length
    ? lineItems.map((li, i) =>
      `  ${i}: "${li.description || "?"}" (category: ${li.expense_category || hint.category || "other"}, amount: ${li.amount || 0})`
    ).join("\n")
    : `  0: "${hint.suggested_account_name || "Vendor Bill"}" (category: ${hint.category || "other"}, amount: ${extracted?.totals?.grand_total || 0})`;

  const industryHint = String(industry || "").trim();
  const industrySection = industryHint
    ? `
COMPANY INDUSTRY: ${industryHint}

USE THE INDUSTRY TO GUIDE YOUR ACCOUNT SELECTION. The industry tells you what this company does, which determines how EVERY purchase should be classified — not just COGS vs OpEx.

INDUSTRY-BASED ACCOUNT SELECTION RULES:
1. WHAT IS THE COMPANY'S CORE BUSINESS? The industry tells you. All purchases related to the core business should go to the most specific matching account.
2. PURCHASES THAT SERVE THE CORE BUSINESS are more likely to be Inventory, Cost of Sales, COGS, or direct operational accounts — NOT generic admin/expense.
3. PURCHASES FOR BACK-OFFICE are Operating Expense — but still pick the most specific account (e.g. "Office Supplies" not "Admin Expense").
4. THE INDUSTRY CHANGES THE DEFAULT ACCOUNT for the same item:

INDUSTRY-SPECIFIC ACCOUNT MAPPING EXAMPLES:
- Restaurant/food service/hotel/resort:
  * Food, beverages, ingredients, condiments, meat, seafood, produce → Inventory / Cost of Sales / Food Cost / COGS
  * Wine, beer, spirits, soft drinks → Inventory - Beverages / Beverage Cost / COGS
  * Kitchen supplies, packaging, takeout containers → Cost of Sales / Kitchen Supplies
  * Cleaning supplies, detergent → Operating Supplies / Janitorial (NOT COGS unless for guest rooms)
  * Linen, towels, uniforms → Operating Supplies / Housekeeping
  * Gas/LPG for cooking → Cost of Sales / Fuel (kitchen) or Utilities

- Retail/trading/distribution:
  * Merchandise for resale → Inventory / Cost of Sales / Purchases
  * Bags, packaging, wrapping → Cost of Sales / Packaging
  * Store fixtures, displays → Supplies / Store Equipment

- Manufacturing:
  * Raw materials → Inventory / Raw Materials / Cost of Sales
  * Factory supplies, machine parts → Manufacturing Overhead / Factory Supplies
  * Packaging materials → Cost of Sales / Packaging

- Laundry/cleaning services:
  * Detergent, bleach, fabric softener, chemicals → Cost of Sales / Direct Materials
  * Hangers, plastic bags → Cost of Sales / Supplies

- Construction:
  * Cement, lumber, rebar, gravel, sand → Cost of Sales / Construction Materials
  * Tools, PPE → Construction Supplies

- Professional services/consulting:
  * Subcontractor fees → Cost of Revenue / Subcontractor Expense
  * Client-related travel → Cost of Revenue / Travel
  * Office supplies → Operating Expense / Office Supplies

5. KEY PRINCIPLE: When the company's industry matches the vendor's products, those products are almost certainly for the CORE BUSINESS, not general admin. A restaurant buying from a meat vendor = inventory/COGS, not "Admin Expense". A hotel buying from a wine distributor = beverage inventory, not "Meals & Entertainment".
`
    : "";

  const ocrSection = ocrText
    ? `\nORIGINAL OCR TEXT (use for additional context about what was purchased):\n${String(ocrText).slice(0, 3000)}\n`
    : "";

  const prompt = `You are a SENIOR FILIPINO ACCOUNTANT recording a vendor bill (Purchase/AP) in Odoo for a Philippine company. You must assign each invoice line to an account from the chart of accounts below.

YOU MUST SELECT FROM THIS LIST. These are the ONLY valid accounts. Copy the account_id, account_code, and account_name EXACTLY from this list.

AVAILABLE ACCOUNTS (id: [code] name):
${accountList}

LINE ITEMS TO CLASSIFY:
${lineDesc}

Bill-level category hint: ${hint.category || "other"}
Bill-level suggested account name: ${hint.suggested_account_name || "(none)"}
Vendor name: ${extracted?.vendor?.name || "(unknown)"}
Vendor trade name: ${extracted?.vendor_details?.trade_name || "(same)"}
Vendor entity type: ${extracted?.vendor_details?.entity_type || "unknown"}
${vendorResearch ? `
VENDOR RESEARCH (from Google Search — USE THIS as your primary context for account selection):
${vendorResearch}
This research tells you what the vendor actually sells/does. Use it to pick the correct expense account.
For example, if the vendor is a software company, prefer "Software & Subscriptions" or "Computer Software" over "Supplies Expenses".
` : ""}${industrySection}${feedbackSection}${ocrSection}
RULES (MANDATORY - follow ALL):

1. YOU MUST PICK AN ACCOUNT. Returning an account_id of 0 or an ID not in the list above is NOT allowed. Always select the closest match from the available accounts.

2. THINK LIKE A PH ACCOUNTANT recording a vendor bill:
   - What did we buy? What account do we debit?
   - ALWAYS consider the COMPANY INDUSTRY (above) first. The same purchase maps to different accounts depending on what the company does.
   - A laundry shop vendor → we paid for laundry services → "Outside Services", "Janitorial & Cleaning", or similar. BUT if OUR company IS a laundry business, this could be "Cost of Sales" (subcontractor).
   - A fabric/textile vendor → "Supplies", "Raw Materials", "Cost of Sales", or "Inventory" accounts
   - A gas station → fuel → "Fuel & Oil", "Gas & Oil", "Transportation". BUT if the fuel is for cooking (restaurant), consider "Cost of Sales".
   - A hardware store → "Supplies", "Repairs & Maintenance"
   - A food/beverage vendor → If our company is in food/hospitality → "Inventory", "Cost of Sales", "COGS". If our company is NOT in food → "Meals & Entertainment".
   - Beer/wine/spirits vendor → If our company is in food/hospitality/bar → "Inventory - Beverages", "Cost of Sales". If not → "Meals & Entertainment".
   - Printing/stationery → "Office Supplies", "Printing & Stationery"
   - Electricity/water/internet → "Utilities"
   - A consulting/services firm charging for permit/license PROCESSING (e.g. "Business Permit processing", "permit renewal service") → "Professional Fees" or "Outside Services". This is a service fee, NOT "Taxes and Licenses". Only use "Taxes and Licenses" when the invoice is FROM the government agency charging the actual permit/license fee itself.

3. VENDOR NAME IS YOUR STRONGEST CLUE when the item description is unclear (bad OCR, handwritten, brand name gibberish). A "LAUNDRY SHOP" sells laundry services. A "FABRIC TRADING" sells fabric. A "MARKETING CORPORATION" selling beer is a beer distributor.

4. BANNED GENERIC ACCOUNTS - Do NOT use these if ANY specific account exists:
   - "Admin Expense", "Administrative Expense", "Miscellaneous", "General Expense", "Other Expense", "Sundry"
   - Only use generic accounts if the available list literally has NO account that relates to the purchase.
   - If you must use a generic account, confidence must be below 0.3.

5. PREFER SPECIFIC OVER GENERIC - even if the match isn't perfect:
   - "Janitorial & Cleaning" is better than "Admin Expense" for a laundry vendor
   - "Supplies" is better than "Admin Expense" for a hardware vendor  
   - "Cost of Sales" or any inventory/COGS account is better than "Admin Expense" for goods purchased for resale
   - An imperfect specific match (confidence 0.5) is ALWAYS better than a generic account

6. COST OF REVENUE vs OPERATING EXPENSE (PH context):
   - Items directly used to produce/deliver the company's product/service → Cost of Sales / COGS / Cost of Revenue
   - Back-office/admin items → Operating Expense
   - When in doubt, pick Operating Expense but NEVER Admin/General Expense if a more specific account exists

7. COPY EXACTLY from the list above:
   - account_id: the numeric ID (first number before the colon)
   - account_code: the code in brackets [like this]
   - account_name: the name after the brackets
   Do NOT invent account names or codes. Copy them character-for-character.

8. ALTERNATIVES: Always provide 2nd and 3rd best choices. These are critical fallbacks.

9. BILL-LEVEL: Pick the single best account for the whole bill (bill_level_account_id/code/name).`;


  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: accountAssignmentSchema
    }
  };

  const result = await geminiWithRetryAndFallback(config, body, { throwOnFail: false });
  if (!result) return null;

  const data = safeJsonParse(result.text, {});
  const raw =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n") ||
    "{}";
  const parsed = safeJsonParse(raw, null);
  if (!parsed) return null;
  return { ...parsed, _feedbackCount: feedbackList.length };
}

async function researchVendorWithGemini(vendorName, tradeName, config) {
  const name = String(tradeName || vendorName || "").trim();
  if (!name || name.length < 2) return null;

  const prompt = `Look up the company "${name}" using Google Search.
Return a SHORT factual summary (max 3 sentences) covering:
1. What the company does / what products or services it sells
2. The industry or sector (e.g. "SaaS / developer tools", "food & beverage distribution", "office supplies retail")
3. What expense category a purchase from this vendor would typically fall under in accounting (e.g. "Software & Subscriptions", "Meals & Entertainment", "Professional Fees", "Office Supplies", "Utilities")

If the company is not well-known or search returns no useful results, say "No information found." and nothing else.`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }]
  };

  try {
    const result = await geminiWithRetryAndFallback(config, body, { throwOnFail: false });
    if (!result) return null;
    const data = safeJsonParse(result.text, null);
    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join(" ") ||
      "";
    const trimmed = text.trim();
    if (!trimmed || trimmed.toLowerCase().startsWith("no information found")) return null;
    return trimmed.slice(0, 500);
  } catch (_) {
    return null;
  }
}

module.exports = {
  extractInvoiceWithGemini,
  assignAccountsWithGemini,
  researchVendorWithGemini,
  geminiWithRetryAndFallback
};
