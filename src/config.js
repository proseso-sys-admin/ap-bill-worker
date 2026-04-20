const path = require("path");
const dotenv = require("dotenv");

// Load from project root (parent of src/), override any system env
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env"), override: true });

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toFloat(value, fallback) {
  const n = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

function toArrayCsv(value, fallback = []) {
  if (!value) return fallback;
  return String(value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

const config = {
  server: {
    port: toInt(process.env.PORT, 8080),
    logLevel: process.env.LOG_LEVEL || "info",
    sharedSecret: (process.env.WORKER_SHARED_SECRET || "").trim(),
    runOneMaxConcurrency: Math.max(1, toInt(process.env.RUN_ONE_MAX_CONCURRENCY, 5)),
    runWorkerTargetsParallel: Math.max(1, toInt(process.env.RUN_WORKER_TARGETS_PARALLEL, 1))
  },
  budget: {
    runBudgetMs: toInt(process.env.RUN_BUDGET_MS, 25 * 60 * 1000),
    reserveMs: toInt(process.env.TIME_RESERVE_MS, 25_000)
  },
  routing: {
    source: process.env.ROUTING_SOURCE || "sheets",
    odooTasksLimit: Math.max(1, toInt(process.env.ROUTING_ODOO_TASKS_LIMIT, 500)),
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID || "",
    routingSheetName: process.env.ROUTING_SHEET_NAME || "ProjectRouting",
    vendorRulesSheetName: process.env.VENDOR_RULES_SHEET_NAME || "VendorRules",
    accountMappingSheetName: process.env.ACCOUNT_MAPPING_SHEET_NAME || "AccountMapping"
  },
  scan: {
    docsBatchLimit: toInt(process.env.DOCS_BATCH_LIMIT, 50),
    pass1UnrenamedLimit: toInt(process.env.PASS1_UNRENAMED_LIMIT, 50),
    pass2MarkedLimit: toInt(process.env.PASS2_MARKED_LIMIT, 50),
    renamePrefix: process.env.SCAN_UNRENAMED_PREFIX || "BILL",
    processedMarkerPrefix: process.env.PROCESSED_MARKER_PREFIX || "BILL_OCR_PROCESSED|V1|",
    ocrJobMarkerPrefix: process.env.OCR_JOB_MARKER_PREFIX || "BILL_OCR_JOB|V1|",
    pdfOcrMaxPages: toInt(process.env.PDF_OCR_MAX_PAGES, 80),
    ocrMinTextLen: toInt(process.env.OCR_MIN_TEXT_LEN, 40),
    visionLangHints: toArrayCsv(process.env.VISION_LANG_HINTS, ["en", "fil"])
  },
  thresholds: {
    critical: toFloat(process.env.THRESHOLD_CRITICAL, 0.8),
    vendorAutopick: toFloat(process.env.THRESHOLD_VENDOR_AUTOPICK, 0.9)
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || "",
    model: process.env.GEMINI_MODEL || "gemini-3-pro-preview",
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-pro",
    visionFirst: process.env.GEMINI_VISION_FIRST !== "false",
    skipVision: process.env.SKIP_VISION_OCR === "true"
  },
  odooDefaults: {
    sourceBaseUrl: process.env.SOURCE_BASE_URL || "",
    sourceDb: process.env.SOURCE_DB || "",
    sourceLogin: process.env.SOURCE_LOGIN || "",
    sourcePassword: process.env.SOURCE_PASSWORD || "",
    defaultExpenseAccountId: toInt(process.env.DEFAULT_EXPENSE_ACCOUNT_ID, 0),
    sourceGeneralTaskDbField: process.env.SOURCE_GENERAL_TASK_DB_FIELD || "x_studio_accounting_database",
    sourceGeneralTaskIndustryField: process.env.SOURCE_GENERAL_TASK_INDUSTRY_FIELD || "x_studio_industry",
    sourceGeneralTaskStageName: process.env.SOURCE_GENERAL_TASK_STAGE_NAME || "General",
    sourceGeneralTaskEnabledField: process.env.SOURCE_GENERAL_TASK_ENABLED_FIELD || "x_studio_enabled",
    sourceGeneralTaskBillWorkerField: process.env.SOURCE_GENERAL_TASK_BILL_WORKER_FIELD || "x_studio_odoo_bill_worker",
    sourceGeneralTaskMultiCompanyField: process.env.SOURCE_GENERAL_TASK_MULTI_COMPANY_FIELD || "x_studio_multi_company",
    sourceGeneralTaskCompanyIdField: process.env.SOURCE_GENERAL_TASK_COMPANY_ID_FIELD || "x_studio_company_id_if_multi_company",
    sourceGeneralTaskEmailField: process.env.SOURCE_GENERAL_TASK_EMAIL_FIELD || "x_studio_email",
    sourceGeneralTaskPasswordField: process.env.SOURCE_GENERAL_TASK_PASSWORD_FIELD || "x_studio_api_key",
    sourceGeneralTaskApFolderField: process.env.SOURCE_GENERAL_TASK_AP_FOLDER_FIELD || "x_studio_ap_folder_id",
    sourceGeneralTaskPurchaseJournalField: process.env.SOURCE_GENERAL_TASK_PURCHASE_JOURNAL_FIELD || "x_studio_purchase_journal_id",
    sourceGeneralTaskCountryField: process.env.SOURCE_GENERAL_TASK_COUNTRY_FIELD || "x_studio_country",
    sourceGeneralTaskTwaField: process.env.SOURCE_GENERAL_TASK_TWA_FIELD || "x_studio_top_withholding_agent_twa",
    // VAT purchase tax IDs are auto-resolved from the target database at runtime (pickVatTaxesForCompany).
    routingStageName: process.env.ROUTING_STAGE_NAME || "Master",
    taxTaskNameFilter: process.env.TAX_TASK_NAME_FILTER || "Tax PH"
  },
  accountingConfigCacheTtlMinutes: toInt(process.env.ACCOUNTING_CONFIG_CACHE_TTL_MINUTES, 15),
  gcs: {
    bucket: process.env.GCS_BUCKET || "",
    inputPrefix: process.env.GCS_INPUT_PREFIX || "ap-ocr/input",
    outputPrefix: process.env.GCS_OUTPUT_PREFIX || "ap-ocr/output",
    stateBucket: process.env.STATE_BUCKET || "",
    statePrefix: process.env.STATE_PREFIX || "AP_BILL_STATE_V1",
    feedbackPrefix: process.env.GCS_FEEDBACK_PREFIX || "AP_FEEDBACK_V1",
    vendorMemoryPrefix: process.env.GCS_VENDOR_MEMORY_PREFIX || "AP_VENDOR_MEMORY_V1",
    accountingConfigPrefix: process.env.GCS_ACCOUNTING_CONFIG_PREFIX || "AP_ACCOUNTING_CONFIG",
    docBillMappingPrefix: process.env.GCS_DOC_BILL_MAPPING_PREFIX || "AP_DOC_BILL_MAPPING_V1"
  },
  feedback: {
    lookbackDays: toInt(process.env.FEEDBACK_LOOKBACK_DAYS, 14)
  },
  bankStatement: {
    reconcileThreshold: toFloat(process.env.BS_RECONCILE_THRESHOLD, 0.9),
    processedMarkerPrefix: process.env.BS_PROCESSED_MARKER_PREFIX || "BANK_OCR_PROCESSED|V1|",
    bsFolderField: process.env.SOURCE_GENERAL_TASK_BS_FOLDER_FIELD || "x_studio_bank_statement_folder_id",
    bsWorkerField: process.env.SOURCE_GENERAL_TASK_BS_WORKER_FIELD || "x_studio_odoo_bank_statement_worker",
    bsFolderMappingField: process.env.SOURCE_GENERAL_TASK_BS_FOLDER_MAPPING_FIELD || "x_studio_bank_folder_mapping",
    docStatementMappingPrefix: process.env.GCS_DOC_STATEMENT_MAPPING_PREFIX || "BS_DOC_STATEMENT_MAPPING_V1",
    bsStatePrefix: process.env.BS_STATE_PREFIX || "BS_STATE_V1",
    mathTolerancePercent: toFloat(process.env.BS_MATH_TOLERANCE_PERCENT, 0.5)
  }
};

function validateConfig() {
  const missing = [];
  if (!config.gemini.apiKey) missing.push("GEMINI_API_KEY");
  if (!config.gcs.bucket) missing.push("GCS_BUCKET");
  if (config.routing.source === "sheets" && !config.routing.spreadsheetId) {
    missing.push("SHEETS_SPREADSHEET_ID");
  }
  if (config.routing.source === "odoo") {
    if (!config.odooDefaults.sourceBaseUrl) missing.push("SOURCE_BASE_URL");
    if (!config.odooDefaults.sourceDb) missing.push("SOURCE_DB");
    if (!config.odooDefaults.sourceLogin) missing.push("SOURCE_LOGIN");
    if (!config.odooDefaults.sourcePassword) missing.push("SOURCE_PASSWORD");
  }
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}

module.exports = {
  config,
  validateConfig
};
