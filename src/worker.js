// @ts-nocheck
const { config } = require("./config");
const { OdooClient, kwWithCompany } = require("./odoo");
const {
  loadRoutingSheetData,
  saveRoutingSheetData,
  toRoutingRowStrict,
  loadAccountMapping
} = require("./sheets");
const { ocrTextForAttachment } = require("./vision");
const { extractInvoiceWithGemini, assignAccountsWithGemini, researchVendorWithGemini } = require("./gemini");
const { m2oId, normalizeOdooBaseUrl, deriveDbFromBaseUrl, isFalsyOdooValue, sleep } = require("./utils");
const {
  loadState,
  saveState,
  persistDocBillMapping,
  getDocBillEntry,
  removeDocBillEntry,
  loadAccountingConfigCache,
  saveAccountingConfigCache,
  loadOdooFieldNamesFromGcs
} = require("./state");
const { appendFeedbackCorrections, loadVendorAccountMemory, updateVendorMemoryFromFeedback } = require("./gcsFeedback");
const {
  makeProcessedMarker,
  isProcessed,
  getProcessedBillId,
  makeOcrJobMarker,
  appendMarker,
  parseOcrJobMarker
} = require("./markers");

function outOfTime(startMs) {
  return Date.now() - startMs > config.budget.runBudgetMs - config.budget.reserveMs;
}

function parseAcctDb(raw) {
  if (isFalsyOdooValue(raw)) return { target_base_url: "", target_db: "" };
  const s = String(raw).trim();
  if (!s) return { target_base_url: "", target_db: "" };
  if (s.startsWith("{") && s.endsWith("}")) {
    try {
      const o = JSON.parse(s);
      const bu = normalizeOdooBaseUrl(o.baseUrl || o.target_base_url || "");
      const db = bu ? deriveDbFromBaseUrl(bu) : String(o.db || o.target_db || "").trim();
      const bu2 = bu || normalizeOdooBaseUrl(db);
      return { target_base_url: bu2, target_db: deriveDbFromBaseUrl(bu2) || db };
    } catch (_) {
      return { target_base_url: "", target_db: "" };
    }
  }
  if (/^https?:\/\//i.test(s)) {
    const bu = normalizeOdooBaseUrl(s);
    return { target_base_url: bu, target_db: deriveDbFromBaseUrl(bu) };
  }
  const bu = normalizeOdooBaseUrl(s);
  return { target_base_url: bu, target_db: deriveDbFromBaseUrl(bu) };
}

async function getSourceOdooTargetMap(logger, rows = []) {
  const src = config.odooDefaults;
  if (!src.sourceBaseUrl || !src.sourceDb || !src.sourceLogin || !src.sourcePassword) {
    return null;
  }
  const projectIds = [
    ...new Set(
      rows
        .map((r) => Number(r.source_project_id || 0))
        .filter((n) => Number.isFinite(n) && n > 0)
    )
  ];
  if (!projectIds.length) return new Map();
  try {
    const odoo = new OdooClient({
      baseUrl: src.sourceBaseUrl,
      db: src.sourceDb,
      login: src.sourceLogin,
      password: src.sourcePassword
    });
    const generalStageName = src.sourceGeneralTaskStageName || "General";
    const industryField = config.odooDefaults.sourceGeneralTaskIndustryField || "x_studio_industry";
    const generalTaskDomain = [
      ["project_id", "in", projectIds],
      ["name", "=", "General"],
      ["stage_id.name", "=", generalStageName]
    ];
    let generalTasks = [];
    try {
      generalTasks =
        (await odoo.searchRead(
          "project.task",
          generalTaskDomain,
          ["id", "project_id", config.odooDefaults.sourceGeneralTaskDbField, industryField],
          { limit: projectIds.length * 5 }
        )) || [];
    } catch (fieldErr) {
      if (String(fieldErr?.message || fieldErr).includes("Invalid field")) {
        generalTasks =
          (await odoo.searchRead(
            "project.task",
            generalTaskDomain,
            ["id", "project_id", config.odooDefaults.sourceGeneralTaskDbField],
            { limit: projectIds.length * 5 }
          )) || [];
      } else throw fieldErr;
    }
    const rawDbByProject = new Map();
    const rawIndustryByProject = new Map();
    for (const t of generalTasks) {
      const pid = Array.isArray(t.project_id) ? Number(t.project_id[0]) : null;
      if (!pid) continue;
      if (!rawDbByProject.has(pid)) {
        rawDbByProject.set(pid, t[config.odooDefaults.sourceGeneralTaskDbField]);
      }
      if (industryField in t) {
        const iv = t[industryField];
        const industry = iv ? (Array.isArray(iv) ? String(iv[1] || iv[0] || "").trim() : String(iv || "").trim()) : "";
        if (industry && !rawIndustryByProject.has(pid)) rawIndustryByProject.set(pid, industry);
      }
    }
    const map = new Map();
    for (const pid of projectIds) {
      const parsed = parseAcctDb(rawDbByProject.get(pid));
      const industry = rawIndustryByProject.get(pid) || "";
      if (parsed.target_base_url || industry) {
        map.set(pid, { ...parsed, industry });
      }
    }
    logger.info("Refreshed target_base_url/target_db/industry from SOURCE General task.", { projects: map.size, projectIds });
    return map;
  } catch (err) {
    logger.warn("Source Odoo refresh failed (continuing with sheet values).", { error: err?.message || String(err) });
    return null;
  }
}

function isEnabledRow(row) {
  const x = String(row.enabled || "").trim().toLowerCase();
  return x === "true" || x === "1" || x === "yes" || x === "y";
}

function ensureAutoColumns(headers, rows) {
  const wanted = [
    "purchase_journal_id",
    "ap_folder_id",
    "industry"
  ];
  let changed = false;
  for (const c of wanted) {
    if (!headers.includes(c)) {
      headers.push(c);
      changed = true;
    }
  }
  if (changed) {
    for (const r of rows) {
      for (const c of wanted) {
        if (r[c] == null) r[c] = "";
      }
    }
  }
  return changed;
}

function groupRowsByTarget(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!isEnabledRow(row)) continue;
    const baseUrl = normalizeOdooBaseUrl(row.target_base_url);
    const db = String(row.target_db || "").trim() || deriveDbFromBaseUrl(baseUrl);
    const login = String(row.target_login || "").trim();
    const password = String(row.target_password || "").trim();
    const companyId = Number(String(row.target_company_id || "").trim() || 0);
    if (!baseUrl || !db || !login || !password || !companyId) continue;
    const key = [baseUrl, db, login.toLowerCase(), String(companyId)].join("|");
    if (!groups.has(key)) {
      groups.set(key, {
        cfg: { baseUrl, db, login, password },
        companyId,
        rows: []
      });
    }
    groups.get(key).rows.push(row);
  }
  return groups;
}

function pickTopTaxByScore(arr, scorer) {
  let best = null;
  let bestScore = -1e9;
  for (const t of arr) {
    const s = scorer(t);
    if (s > bestScore) {
      best = t;
      bestScore = s;
    }
  }
  return best;
}

async function pickVatTaxesForCompany(odoo, companyId) {
  const taxes =
    (await odoo.searchRead(
      "account.tax",
      [
        ["company_id", "=", companyId],
        ["active", "=", true],
        ["type_tax_use", "in", ["purchase", "none"]]
      ],
      ["id", "name", "amount", "amount_type", "type_tax_use", "price_include", "description", "tax_group_id", "tax_scope"],
      kwWithCompany(companyId, { limit: 2000, order: "name asc" })
    )) || [];

  const norm = (s) => String(s || "").toLowerCase();
  const text = (t) => `${norm(t.name)} ${norm(t.description)} ${Array.isArray(t.tax_group_id) ? norm(t.tax_group_id[1]) : ""}`;
  const has = (t, re) => re.test(text(t));
  const scope = (t) => norm(t.tax_scope || "");

  const isWithholding = (t) => has(t, /fwvat|ewvat|withhold|withholding|wht|designated|ds\b/);
  const isCapital = (t) => has(t, /capital\s*goods|capital\s*asset|\bcapital\b.*\bgoods\b|\b12%\s*c\b|\b12%c\b/);
  const isImport = (t) => has(t, /\bimport\b|\bimportation\b|\b12%\s*i\b/);
  const isNcr = (t) => has(t, /\bncr\b|non[-\s]?credit|not directly attribut/);
  const isNonResident = (t) => has(t, /non[-\s]?resident|\bnr\b|\bs\s*nr\b/);
  const isExempt = (t) => has(t, /exempt/);
  const isZeroRated = (t) => has(t, /zero[-\s]?rat/);
  const serviceLike = (t) => (scope(t) === "service" || has(t, /service|consult|professional|repair|rent|labor|contract|freight/)) && !isCapital(t) && !isNonResident(t);
  const goodsLike = (t) => (scope(t) === "consu" || scope(t) === "goods" || has(t, /goods|supply|material|inventory|product|merch/)) && !isCapital(t) && !isImport(t);

  const pct12 = taxes.filter((t) => t.amount_type === "percent" && Math.abs(Number(t.amount || 0) - 12) < 0.01 && !isWithholding(t));
  const pct0 = taxes.filter((t) => t.amount_type === "percent" && Math.abs(Number(t.amount || 0)) < 0.01 && !isWithholding(t));

  const pick = (arr, scorer) => pickTopTaxByScore(arr, scorer);

  const goods = pick(pct12.filter((t) => !isCapital(t) && !isImport(t) && !isNcr(t) && !isNonResident(t)), (t) => {
    let s = 0;
    if (goodsLike(t)) s += 10;
    if (!serviceLike(t) && !isExempt(t)) s += 3;
    if (!t.price_include) s += 1;
    return s;
  });
  const services = pick(pct12.filter((t) => !isCapital(t) && !isImport(t) && !isNcr(t) && !isNonResident(t)), (t) => {
    let s = 0;
    if (serviceLike(t)) s += 10;
    if (!goodsLike(t) && !isExempt(t)) s += 3;
    if (!t.price_include) s += 1;
    return s;
  });
  const capital = pick(pct12.filter((t) => isCapital(t)), (t) => {
    let s = 5;
    if (!t.price_include) s += 1;
    return s;
  });
  const imports = pick(pct12.filter((t) => isImport(t) && !isExempt(t)), (t) => {
    let s = 5;
    if (!t.price_include) s += 1;
    return s;
  });
  const nonResident = pick(pct12.filter((t) => isNonResident(t)), (t) => {
    let s = 5;
    if (!t.price_include) s += 1;
    return s;
  });
  const ncr = pick(pct12.filter((t) => isNcr(t)), (t) => {
    let s = 5;
    if (!t.price_include) s += 1;
    return s;
  });
  const exempt = pick(pct0.filter((t) => isExempt(t) && !isImport(t)), (t) => {
    let s = 5;
    if (norm(t.type_tax_use) === "purchase") s += 2;
    return s;
  });
  const exemptImports = pick(pct0.filter((t) => isExempt(t) && isImport(t)), (t) => {
    let s = 5;
    return s;
  });
  const zeroRated = pick(pct0.filter((t) => isZeroRated(t) && !isExempt(t)), (t) => {
    let s = 5;
    if (norm(t.type_tax_use) === "purchase") s += 2;
    return s;
  });
  const generic = goods || services || pick(pct12.filter((t) => !isWithholding(t) && !isNcr(t)), (t) => {
    let s = 0;
    if (norm(t.type_tax_use) === "purchase") s += 5;
    if (!t.price_include) s += 2;
    return s;
  });

  const id = (t) => (t ? Number(t.id) : 0);

  // --- Withholding / EWT tax picking ---
  // BIR ATC: WI = individual/sole proprietor, WC = corporate/non-individual
  const whtTaxes = taxes.filter((t) => isWithholding(t) && t.amount_type === "percent" && Number(t.amount || 0) < 0);
  const isWI = (t) => has(t, /\bwi\d|\bindiv|\bperson/);
  const isWC = (t) => has(t, /\bwc\d|\bcorp|\bnon[-\s]?indiv|\bjurid/);
  const pickWhtByRate = (targetRate, preferWI) => {
    const tolerance = 0.5;
    let best = null;
    let bestScore = -Infinity;
    for (const t of whtTaxes) {
      const dist = Math.abs(Number(t.amount) - targetRate);
      if (dist > tolerance) continue;
      let s = 100 - dist * 10;
      // Prefer WI/WC match if specified
      if (preferWI === true && isWI(t)) s += 20;
      else if (preferWI === false && isWC(t)) s += 20;
      // Prefer purchase-type taxes
      if (norm(t.type_tax_use) === "purchase") s += 5;
      if (s > bestScore) { best = t; bestScore = s; }
    }
    return best;
  };
  // Pick EWT taxes for both WI (individual) and WC (corporate) variants
  // null = no preference, true = prefer WI, false = prefer WC
  const ewtWI1 = pickWhtByRate(-1, true);
  const ewtWC1 = pickWhtByRate(-1, false);
  const ewtWI2 = pickWhtByRate(-2, true);
  const ewtWC2 = pickWhtByRate(-2, false);
  const ewtWI5 = pickWhtByRate(-5, true);
  const ewtWC5 = pickWhtByRate(-5, false);
  const ewtWI10 = pickWhtByRate(-10, true);
  const ewtWC10 = pickWhtByRate(-10, false);
  const ewtWI15 = pickWhtByRate(-15, true);
  const ewtWC15 = pickWhtByRate(-15, false);

  return {
    goodsId: id(goods) || id(generic),
    servicesId: id(services) || id(generic),
    capitalId: id(capital),
    importsId: id(imports),
    nonResidentId: id(nonResident),
    ncrId: id(ncr),
    exemptId: id(exempt),
    exemptImportsId: id(exemptImports),
    zeroRatedId: id(zeroRated),
    genericId: id(generic),
    // EWT taxes keyed by WI (individual) / WC (corporate) and rate
    ewt: {
      wi1: id(ewtWI1), wc1: id(ewtWC1),
      wi2: id(ewtWI2), wc2: id(ewtWC2),
      wi5: id(ewtWI5), wc5: id(ewtWC5),
      wi10: id(ewtWI10), wc10: id(ewtWC10),
      wi15: id(ewtWI15), wc15: id(ewtWC15),
    },
    _meta: {
      priceInclude: !!(generic || goods || services)?.price_include,
      amount: Number((generic || goods || services)?.amount || 12)
    }
  };
}

async function resolvePurchaseJournalId(odoo, companyId) {
  const journals = await odoo.searchRead(
    "account.journal",
    [["type", "=", "purchase"], ["company_id", "=", companyId]],
    ["id", "name", "code"],
    kwWithCompany(companyId, { limit: 20, order: "id asc" })
  );
  if (!journals.length) return 0;

  const billJournal = journals.find((j) => {
    const name = String(j.name || "").toLowerCase();
    const code = String(j.code || "").toLowerCase();
    return (
      name.includes("vendor bill") ||
      name.includes("vendor invoice") ||
      name.includes("bills") ||
      code === "bill" ||
      code === "vb"
    );
  });
  if (billJournal) return Number(billJournal.id);

  const notReceipt = journals.find((j) => {
    const name = String(j.name || "").toLowerCase();
    return !name.includes("receipt");
  });
  return Number((notReceipt || journals[0]).id);
}

async function refreshRoutingAutoFields(headers, rows, logger, sourceMap = null) {
  ensureAutoColumns(headers, rows);
  const groups = groupRowsByTarget(rows);
  let updated = 0;
  for (const [key, g] of groups.entries()) {
    try {
      const odoo = new OdooClient(g.cfg);

      let journalId = 0;
      try { journalId = await resolvePurchaseJournalId(odoo, g.companyId); } catch (_) {}

      let apFolderId = 0;
      try {
        const parentName = String(g.rows[0]?.ap_folder_parent ?? "").trim() || undefined;
        const r = await resolveApFolderId(odoo, g.companyId, { parentFolderName: parentName });
        apFolderId = r?.apFolderId ?? 0;
      } catch (_) {}

      for (const row of g.rows) {
        const pid = Number(row.source_project_id || 0);
        const industryVal = sourceMap?.get(pid)?.industry ?? "";
        if (industryVal) {
          logger.info("Industry from General task (source only).", { projectId: pid, industry: industryVal });
        }
        const before = [
          String(row.purchase_journal_id || "").trim(),
          String(row.ap_folder_id || "").trim(),
          String(row.industry || "").trim()
        ].join("|");

        if (journalId) row.purchase_journal_id = String(journalId);
        if (apFolderId) row.ap_folder_id = String(apFolderId);
        if (industryVal) row.industry = industryVal;

        const after = [
          String(row.purchase_journal_id || "").trim(),
          String(row.ap_folder_id || "").trim(),
          String(row.industry || "").trim()
        ].join("|");
        if (after !== before) updated += 1;
      }
    } catch (err) {
      logger.warn("Auto-field refresh failed for routing group.", { key, error: err?.message || String(err) });
    }
  }
  return { updated, groupCount: groups.size };
}

async function getRoutingRows(logger) {
  if (config.routing.source === "odoo") return [];
  const { headers, rows } = await loadRoutingSheetData(config);
    const sourceMap = await getSourceOdooTargetMap(logger, rows);
  if (sourceMap && sourceMap.size > 0) {
    for (const row of rows) {
      const pid = Number(row.source_project_id || 0);
      if (pid && sourceMap.has(pid)) {
        const r = sourceMap.get(pid);
        if (!normalizeOdooBaseUrl(row.target_base_url)) row.target_base_url = r.target_base_url || row.target_base_url;
        if (!String(row.target_db || "").trim()) row.target_db = r.target_db || row.target_db;
        if (r.industry && !String(row.industry || "").trim()) row.industry = r.industry;
      }
    }
  }

  const refreshRes = await refreshRoutingAutoFields(headers, rows, logger, sourceMap);
  await saveRoutingSheetData(config, headers, rows);
  logger.info("Refreshed auto-fields into ProjectRouting.", refreshRes);

  return rows.map(toRoutingRowStrict).filter(Boolean);
}

function buildTargetKey(row) {
  return [
    normalizeOdooBaseUrl(row.target_base_url),
    row.target_db,
    String(row.target_login).toLowerCase(),
    String(row.target_company_id),
    String(row.source_project_id ?? "")
  ].join("|");
}

function buildTargetKeyFromOdooTask(task, baseUrl, db, login, companyId) {
  return [normalizeOdooBaseUrl(baseUrl), db, String(login).toLowerCase(), String(companyId), String(task.project_id?.[0] ?? task.id)].join("|");
}

/** When config.routing.source === "odoo", load targets from source Odoo project.task (General tasks). */
async function getTargetsFromOdoo(logger) {
  const src = config.odooDefaults;
  const baseUrl = normalizeOdooBaseUrl(src.sourceBaseUrl);
  const db = String(src.sourceDb || "").trim();
  const login = String(src.sourceLogin || "").trim();
  const password = String(src.sourcePassword || "").trim();
  if (!baseUrl || !db || !login || !password) {
    throw new Error("Odoo routing requires SOURCE_BASE_URL, SOURCE_DB, SOURCE_LOGIN, SOURCE_PASSWORD");
  }
  const odoo = new OdooClient({ baseUrl, db, login, password });
  // Core task field names: from config (.env) only — these are the Odoo field names we read from the General task
  const dbField = src.sourceGeneralTaskDbField;
  const industryField = src.sourceGeneralTaskIndustryField;
  const enabledField = src.sourceGeneralTaskEnabledField;
  const billWorkerField = src.sourceGeneralTaskBillWorkerField;
  const multiCompanyField = src.sourceGeneralTaskMultiCompanyField;
  const companyIdField = src.sourceGeneralTaskCompanyIdField;
  const emailField = src.sourceGeneralTaskEmailField;
  const passwordField = src.sourceGeneralTaskPasswordField;
  const stageName = src.sourceGeneralTaskStageName || "General";
  // Accounting/extra field names: from GCS if present, else config
  const gcsFields = await loadOdooFieldNamesFromGcs(config);
  const g = (key) => (gcsFields[key] != null && String(gcsFields[key]).trim() !== "" ? String(gcsFields[key]).trim() : src[key]);
  const apFolderField = g("sourceGeneralTaskApFolderField");
  const purchaseJournalField = g("sourceGeneralTaskPurchaseJournalField");
  const countryField = g("sourceGeneralTaskCountryField");
  const twaField = g("sourceGeneralTaskTwaField");
  const fields = ["id", "project_id", dbField, industryField];
  if (enabledField) fields.push(enabledField);
  if (billWorkerField) fields.push(billWorkerField);
  if (multiCompanyField) fields.push(multiCompanyField);
  if (companyIdField) fields.push(companyIdField);
  if (emailField) fields.push(emailField);
  if (passwordField) fields.push(passwordField);
  const accountingFields = [apFolderField, purchaseJournalField, countryField, twaField].filter(Boolean);
  accountingFields.forEach((f) => {
    if (!fields.includes(f)) fields.push(f);
  });

  const domain = [["stage_id.name", "=", stageName]];
  const tasksLimit = Math.max(1, config.routing?.odooTasksLimit ?? 500);
  let tasks = [];
  try {
    tasks = await odoo.searchRead("project.task", domain, fields, { limit: tasksLimit });
  } catch (err) {
    if (accountingFields.length && String(err?.message || "").toLowerCase().includes("invalid field")) {
      const baseFields = fields.filter((f) => !accountingFields.includes(f));
      try {
        tasks = await odoo.searchRead("project.task", domain, baseFields, { limit: tasksLimit });
      } catch (err2) {
        logger.warn("getTargetsFromOdoo: search_read failed.", { error: err2?.message || String(err2) });
        return [];
      }
      accountingFields.length = 0;
    } else {
      logger.warn("getTargetsFromOdoo: search_read failed.", { error: err?.message || String(err) });
      return [];
    }
  }
  const toBool = (v) => v === true || v === 1 || String(v || "").toLowerCase() === "true" || String(v || "").trim() === "1";
  const m2oId = (v) => (v == null || v === false ? 0 : Array.isArray(v) ? Number(v[0]) : Number(v));
  const targets = [];
  const useCache = (config.accountingConfigCacheTtlMinutes || 0) > 0;
  for (const task of tasks) {
    if (enabledField && !toBool(task[enabledField])) continue;
    if (billWorkerField && !toBool(task[billWorkerField])) continue;
    const rawDb = (task[dbField] != null && task[dbField] !== false) ? (Array.isArray(task[dbField]) ? task[dbField][1] || task[dbField][0] : task[dbField]) : "";
    const targetDbRaw = String(rawDb || "").trim();
    if (!targetDbRaw) continue;
    // If General task stores full URL (e.g. https://proseso-accounting-test.odoo.com), derive baseUrl and db name
    let targetBaseUrl = baseUrl;
    let targetDb = targetDbRaw;
    if (/^https?:\/\//i.test(targetDbRaw)) {
      targetBaseUrl = normalizeOdooBaseUrl(targetDbRaw);
      targetDb = deriveDbFromBaseUrl(targetBaseUrl) || targetDbRaw;
    }
    if (!targetDb) continue;
    const multiCompany = multiCompanyField ? toBool(task[multiCompanyField]) : false;
    const companyId = multiCompany && companyIdField && (task[companyIdField] != null)
      ? (Array.isArray(task[companyIdField]) ? Number(task[companyIdField][0]) : Number(task[companyIdField]))
      : 1;
    const industry = industryField && task[industryField]
      ? (Array.isArray(task[industryField]) ? String(task[industryField][1] || task[industryField][0] || "").trim() : String(task[industryField] || "").trim())
      : "";
    const taskEmail = (emailField && task[emailField] != null) ? String(task[emailField] || "").trim() : "";
    const taskApiKey = (passwordField && task[passwordField] != null) ? String(task[passwordField] || "").trim() : "";
    if (!taskEmail) {
      logger.warn("getTargetsFromOdoo: skipping task without target email.", { taskId: task.id, field: emailField });
      continue;
    }
    if (!taskApiKey) {
      logger.warn("getTargetsFromOdoo: skipping task without target API key.", { taskId: task.id, field: passwordField });
      continue;
    }
    const targetLogin = taskEmail;
    const targetPassword = taskApiKey;
    const targetKey = buildTargetKeyFromOdooTask(task, targetBaseUrl, targetDb, targetLogin, companyId);

    const fromTask = {
      apFolderId: m2oId(apFolderField ? task[apFolderField] : null),
      apFolderParent: "",
      purchaseJournalId: m2oId(purchaseJournalField ? task[purchaseJournalField] : null)
    };
    let accounting = fromTask;
    if (useCache) {
      try {
        const cached = await loadAccountingConfigCache(config, targetKey);
        if (cached) accounting = cached;
        else await saveAccountingConfigCache(config, targetKey, fromTask);
      } catch (_) {
        accounting = fromTask;
      }
    }

    targets.push({
      targetKey,
      sourceProjectId: Array.isArray(task.project_id) ? Number(task.project_id[0]) : Number(task.project_id),
      targetCfg: { baseUrl: targetBaseUrl, db: targetDb, login: targetLogin, password: targetPassword },
      companyId,
      apFolderId: accounting.apFolderId,
      apFolderParent: accounting.apFolderParent || "",
      purchaseJournalId: accounting.purchaseJournalId,
      industry,
      country: countryField && task[countryField] != null
        ? (Array.isArray(task[countryField]) ? String(task[countryField][1] || task[countryField][0] || "").trim() : String(task[countryField] || "").trim())
        : "",
      isTopWithholdingAgent: twaField ? toBool(task[twaField]) : false
    });
  }
  logger.info("getTargetsFromOdoo: loaded targets from General tasks.", { count: targets.length });
  return targets;
}

/** Returns targets from Odoo (if routing.source===odoo) or from Sheets. */
async function getTargets(logger) {
  if (config.routing.source === "odoo") {
    return getTargetsFromOdoo(logger);
  }
  const rows = await getRoutingRows(logger);
  return groupRoutingRows(rows);
}

function groupRoutingRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = buildTargetKey(row);
    if (!groups.has(key)) {
      groups.set(key, {
        targetKey: key,
        sourceProjectId: Number(row.source_project_id || 0) || undefined,
        targetCfg: {
          baseUrl: row.target_base_url,
          db: row.target_db,
          login: row.target_login,
          password: row.target_password
        },
        companyId: row.target_company_id,
        apFolderId: row.ap_folder_id || 0,
        apFolderParent: row.ap_folder_parent || "",
        purchaseJournalId: row.purchase_journal_id || 0,
        industry: String(row.industry || "").trim(),
        country: String(row.country || "").trim(),
        isTopWithholdingAgent: false
      });
    }
  }
  return [...groups.values()];
}

async function resolveApFolderId(odoo, companyId, opts = {}) {
  const parentFolderName = String(opts.parentFolderName || "").trim();
  const names = ["Accounts Payable", "Account Payables", "AP", "Vendor Bills"];

  let isFolderDomain = ["is_folder", "=", true];
  try {
    const hasType = await documentsDocumentHasField(odoo, "type");
    if (hasType) isFolderDomain = ["type", "=", "folder"];
  } catch (_) {}

  // If parent specified (e.g. "Accounting"), resolve root folder with that name first
  let parentId = null;
  if (parentFolderName) {
    try {
      const parents = await odoo.searchRead(
        "documents.document",
        [isFolderDomain, ["name", "=", parentFolderName], ["folder_id", "=", false]],
        ["id"],
        kwWithCompany(companyId, { limit: 1 })
      );
      if (parents?.[0]?.id) parentId = Number(parents[0].id);
    } catch (_) {}
    if (parentId === null) {
      try {
        const parents = await odoo.searchRead(
          "documents.document",
          [["name", "=", parentFolderName], ["folder_id", "=", false]],
          ["id"],
          kwWithCompany(companyId, { limit: 1 })
        );
        if (parents?.[0]?.id) parentId = Number(parents[0].id);
      } catch (_) {}
    }
    if (parentId === null) throw new Error(`Could not resolve parent folder "${parentFolderName}" (root).`);
  }

  const folderIdDomain = parentId != null ? [["folder_id", "=", parentId]] : [];

  // Odoo 19 / Odoo 18
  try {
    for (const name of names) {
      const folders = await odoo.searchRead(
        "documents.document",
        [isFolderDomain, ["name", "=", name], ...folderIdDomain],
        ["id", "name", "company_id"],
        kwWithCompany(companyId, { limit: 1 })
      );
      if (folders?.[0]?.id) return { apFolderId: Number(folders[0].id), useIsFolder: true };
    }
  } catch (err) {
    const msg = String(err?.message || err);
    if (!msg.includes("Invalid field") && !msg.includes("Unknown field") && !msg.includes("is_folder")) throw err;
  }

  // Fallback: documents.folder (if present on this instance; parent not applied for this model)
  try {
    for (const name of names) {
      const docs = await odoo.searchRead(
        "documents.folder",
        [["name", "=", name]],
        ["id", "name", "company_id"],
        kwWithCompany(companyId, { limit: 1 })
      );
      if (docs?.[0]?.id) return { apFolderId: Number(docs[0].id), useIsFolder: false };
    }
  } catch (_err) {}

  // Fallback: documents.document by name only (no is_folder), optionally under parent
  try {
    for (const name of names) {
      const docs = await odoo.searchRead(
        "documents.document",
        [["name", "=", name], ...folderIdDomain],
        ["id", "name", "company_id"],
        kwWithCompany(companyId, { limit: 1 })
      );
      if (docs?.[0]?.id) return { apFolderId: Number(docs[0].id), useIsFolder: false };
    }
  } catch (_err) {}

  throw new Error("Could not resolve AP folder id from default candidates.");
}

async function resolveSubfolderIds(odoo, companyId, rootFolderId, useIsFolder) {
  const ids = [rootFolderId];
  if (!useIsFolder) return ids;
  try {
    let isFolderDomain = ["is_folder", "=", true];
    const hasType = await documentsDocumentHasField(odoo, "type");
    if (hasType) isFolderDomain = ["type", "=", "folder"];

    let frontier = [rootFolderId];
    for (let depth = 0; depth < 5 && frontier.length; depth++) {
      const children = await odoo.searchRead(
        "documents.document",
        [isFolderDomain, ["folder_id", "in", frontier]],
        ["id"],
        kwWithCompany(companyId, { limit: 200 })
      );
      frontier = [];
      for (const c of children || []) {
        const cid = Number(c.id);
        if (!ids.includes(cid)) {
          ids.push(cid);
          frontier.push(cid);
        }
      }
    }
  } catch (_) {}
  return ids;
}

async function listCandidateDocuments(odoo, companyId, apFolderId, useIsFolder = false) {
  const folderIds = await resolveSubfolderIds(odoo, companyId, apFolderId, useIsFolder);
  const folderCond = folderIds.length === 1
    ? [["folder_id", "=", folderIds[0]]]
    : [["folder_id", "in", folderIds]];
  const baseFields = ["id", "name", "attachment_id", "folder_id", "company_id", "create_date", "res_model", "res_id"];
  
  let isNotFolderDomain = ["is_folder", "=", false];
  try {
    const hasType = await documentsDocumentHasField(odoo, "type");
    if (hasType) isNotFolderDomain = ["type", "!=", "folder"];
  } catch (_) {}
  const isFolderCond = useIsFolder ? [isNotFolderDomain] : [];

  const pass1Domain = [
    ...folderCond,
    ...isFolderCond,
    ["attachment_id", "!=", false],
    ["name", "not ilike", `${config.scan.renamePrefix}%`]
  ];
  const pass1 = await odoo.searchRead(
    "documents.document",
    pass1Domain,
    baseFields,
    kwWithCompany(companyId, {
      limit: config.scan.pass1UnrenamedLimit || config.scan.docsBatchLimit,
      order: "id asc"
    })
  );

  const pass2Domain = [
    ...folderCond,
    ...isFolderCond,
    ["attachment_id", "!=", false],
    ["name", "ilike", `${config.scan.renamePrefix}%`]
  ];
  const pass2 = await odoo.searchRead(
    "documents.document",
    pass2Domain,
    baseFields,
    kwWithCompany(companyId, {
      limit: config.scan.pass2MarkedLimit,
      order: "id desc"
    })
  );

  const seen = new Set();
  const merged = [];
  for (const d of [...pass1, ...pass2]) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    merged.push(d);
  }
  return merged;
}

async function loadAttachment(odoo, companyId, attachmentId) {
  const rows = await odoo.searchRead(
    "ir.attachment",
    [["id", "=", attachmentId]],
    ["id", "name", "datas", "mimetype", "description", "res_model", "res_id"],
    kwWithCompany(companyId, { limit: 1 })
  );
  return rows?.[0] || null;
}

function looksLikeAtpPrinterVendor(name, ocrText) {
  const n = String(name || "").toLowerCase();
  if (!n) return false;
  const badTokens = [
    "printer",
    "printing",
    "press",
    "graphic",
    "publishing",
    "accreditation",
    "permit",
    "atp",
    "bir",
    "authority"
  ];
  if (badTokens.some((t) => n.includes(t))) return true;
  const text = String(ocrText || "").toLowerCase();
  const anchor = n.slice(0, Math.min(12, n.length));
  const idx = text.indexOf(anchor);
  if (idx >= 0) {
    const win = text.slice(Math.max(0, idx - 180), Math.min(text.length, idx + 180));
    const hints = ["atp", "bir permit", "printer", "accreditation", "date issued", "permit no"];
    if (hints.some((k) => win.includes(k))) return true;
  }
  return false;
}

function chooseBestNonAtpVendor(vendorCandidates, ocrText) {
  const arr = Array.isArray(vendorCandidates) ? vendorCandidates : [];
  const filtered = arr
    .filter((v) => v && v.name)
    .filter((v) => String(v.source || "") !== "atp_printer_box")
    .filter((v) => !looksLikeAtpPrinterVendor(v.name, ocrText))
    .sort((a, b) => (Number(b.confidence || 0) - Number(a.confidence || 0)));
  return filtered[0] || null;
}

function pickVendorFromExtraction(extracted, ocrText) {
  const v = extracted?.vendor || {};
  const primaryName = String(v.name || "").trim();
  const primaryBad = String(v.source || "") === "atp_printer_box" || looksLikeAtpPrinterVendor(primaryName, ocrText);
  if (primaryName && !primaryBad) return { name: primaryName, confidence: Number(v.confidence || 0), source: v.source || "unknown" };
  const alt = chooseBestNonAtpVendor(extracted?.vendor_candidates, ocrText);
  if (alt) return { name: String(alt.name || "").trim(), confidence: Number(alt.confidence || 0), source: alt.source || "unknown" };
  return { name: "", confidence: 0, source: "unknown" };
}

async function safeMessagePost(odoo, companyId, model, resId, body) {
  try {
    const kwargs = kwWithCompany(companyId, {
      body: String(body || ""),
      message_type: "comment",
      subtype_xmlid: "mail.mt_note",
      body_is_html: true
    });

    await odoo.executeKw(model, "message_post", [[Number(resId)]], kwargs);
  } catch (_err) {
    const errMsg = String(_err?.message || _err);
    if (errMsg.includes("'NoneType' object has no attribute 'xpath'")) {
      // In some older or customized Odoo versions, message_post can fail when parsing the body XML 
      // if it expects standard text but gets HTML. Let's retry without body_is_html, or simplify.
      try {
        const fallbackKwargs = kwWithCompany(companyId, {
          body: String(body || ""),
          message_type: "comment"
        });
        await odoo.executeKw(model, "message_post", [[Number(resId)]], fallbackKwargs);
        return; // Success on fallback
      } catch (fallbackErr) {
        console.warn("[safeMessagePost] fallback also failed", { model, resId, error: fallbackErr?.message || String(fallbackErr) });
      }
    } else {
      console.warn("[safeMessagePost] failed", { model, resId, error: errMsg });
    }
  }
}

async function findVendor(odoo, companyId, extracted, ocrText) {
  const picked = pickVendorFromExtraction(extracted, ocrText);
  const vendorName = String(picked.name || "").trim();
  if (!vendorName) return { id: 0, name: "", confidence: 0, source: picked.source };

  const details = extracted?.vendor_details || {};
  const tradeName = String(details.trade_name || "").trim();
  const proprietorObj = typeof details.proprietor_name === "object" && details.proprietor_name !== null ? details.proprietor_name : {};
  let proprietorName = "";
  if (proprietorObj.first_name || proprietorObj.middle_name || proprietorObj.last_name) {
     proprietorName = [proprietorObj.first_name, proprietorObj.middle_name, proprietorObj.last_name].filter(Boolean).join(" ");
  } else {
     proprietorName = String(details.proprietor_name || "").trim();
  }

  const searchNames = [vendorName];
  if (tradeName && tradeName.toLowerCase() !== vendorName.toLowerCase()) searchNames.push(tradeName);
  if (proprietorName && proprietorName.toLowerCase() !== vendorName.toLowerCase()) searchNames.push(proprietorName);

  for (const name of searchNames) {
    const vendors = await odoo.searchRead(
      "res.partner",
      [["name", "ilike", name], ["supplier_rank", ">", 0]],
      ["id", "name"],
      kwWithCompany(companyId, { limit: 5, order: "supplier_rank desc,id asc" })
    );
    if (vendors?.length) {
      return {
        id: Number(vendors[0].id),
        name: String(vendors[0].name),
        confidence: Number(picked.confidence || 0),
        source: picked.source,
        entityType: String(details.entity_type || "unknown"),
        tradeName,
        proprietorName
      };
    }
  }

  return {
    id: 0, name: vendorName, confidence: Number(picked.confidence || 0),
    source: picked.source, entityType: String(details.entity_type || "unknown"),
    tradeName, proprietorName
  };
}

async function createVendorIfMissing(odoo, companyId, extracted, ocrText) {
  const picked = pickVendorFromExtraction(extracted, ocrText);
  const rawName = String(picked.name || "").trim();
  const conf = Number(picked.confidence || 0);
  if (!rawName) return { status: "missing", partnerId: 0, created: false };
  if (looksLikeAtpPrinterVendor(rawName, ocrText) || String(picked.source || "") === "atp_printer_box") {
    return { status: "blocked_printer", partnerId: 0, created: false };
  }
  const AUTOCREATE_VENDOR_MIN = 0.9;
  if (conf < AUTOCREATE_VENDOR_MIN) {
    return { status: "needs_confirmation", partnerId: 0, created: false, confidence: conf, name: rawName };
  }

  const details = extracted?.vendor_details || {};
  const entityType = String(details.entity_type || "unknown").toLowerCase();
  const isSoleProp = entityType === "sole_proprietor" || entityType === "individual";
  const tradeName = String(details.trade_name || "").trim();
  
  let proprietorName = "";
  if (typeof details.proprietor_name === "object" && details.proprietor_name !== null) {
    proprietorName = [details.proprietor_name.first_name, details.proprietor_name.middle_name, details.proprietor_name.last_name].filter(Boolean).join(" ");
  } else {
    proprietorName = String(details.proprietor_name || "").trim();
  }

  const name = isSoleProp && proprietorName ? proprietorName : rawName;

  const searchNames = [name];
  if (rawName.toLowerCase() !== name.toLowerCase()) searchNames.push(rawName);
  if (tradeName && tradeName.toLowerCase() !== name.toLowerCase()) searchNames.push(tradeName);

  for (const sn of searchNames) {
    const existing = await odoo.searchRead(
      "res.partner",
      [["name", "ilike", sn], ["supplier_rank", ">", 0]],
      ["id", "name"],
      kwWithCompany(companyId, { limit: 1 })
    );
    if (existing?.length) {
      return { status: "matched", partnerId: Number(existing[0].id), created: false, name: existing[0].name };
    }
  }

  const vals = {
    name,
    supplier_rank: 1
  };

  if (typeof details.address === "object" && details.address !== null) {
    if (details.address.street) vals.street = String(details.address.street).trim().slice(0, 255);
    if (details.address.street2) vals.street2 = String(details.address.street2).trim().slice(0, 255);
    if (details.address.city) vals.city = String(details.address.city).trim().slice(0, 255);
    if (details.address.zip) vals.zip = String(details.address.zip).trim().slice(0, 255);
  } else if (String(details.address || "").trim()) {
    vals.street = String(details.address).trim().slice(0, 255);
  }

  if (String(details.tin || "").trim()) {
    const rawTin = String(details.tin).trim();
    const cleanTin = rawTin.replace(/\D/g, "");
    if (cleanTin.length >= 9) {
      vals.vat = cleanTin.slice(0, 9);
      if (cleanTin.length >= 12) {
        vals.branch_code = cleanTin.slice(-3);
      } else {
        vals.branch_code = "000";
      }
    } else {
      vals.vat = rawTin;
    }
  }

  const notes = [];
  if (isSoleProp) {
    vals.company_type = "person";
    vals.is_company = false;
    if (tradeName) {
      vals.company_name = tradeName;
      notes.push(`Trade name: ${tradeName}`);
    }
    if (typeof details.proprietor_name === "object" && details.proprietor_name !== null) {
      if (details.proprietor_name.first_name) vals.first_name = details.proprietor_name.first_name;
      if (details.proprietor_name.middle_name) vals.middle_name = details.proprietor_name.middle_name;
      if (details.proprietor_name.last_name) vals.last_name = details.proprietor_name.last_name;
    }
  } else {
    vals.company_type = "company";
    vals.is_company = true;
    if (tradeName && tradeName.toLowerCase() !== name.toLowerCase()) {
      vals.name = tradeName; // For companies, if trade name is different, often it's better to use Trade Name as the primary name, but we keep `name` as is and put trade name in comment, or if they want it in a field:
      // Actually, if it's a company, standard Odoo doesn't have a Trade Name field. We put it in comment.
      notes.push(`DBA: ${tradeName}`);
    }
  }
  if (notes.length) vals.comment = notes.join("\n");
  let newId;

  const createWithFallback = async (payload) => {
    let currentPayload = { ...payload };
    try {
      return await odoo.create("res.partner", currentPayload);
    } catch (e) {
      const errMsg = String(e?.message || "");
      if (errMsg.includes("company_type") || errMsg.includes("is_company")) {
        delete currentPayload.company_type;
        currentPayload.is_company = !isSoleProp;
        try {
          return await odoo.create("res.partner", currentPayload);
        } catch (e2) {
          delete currentPayload.is_company;
          return await odoo.create("res.partner", currentPayload);
        }
      }
      throw e;
    }
  };

  try {
    vals.company_type = isSoleProp ? "person" : "company";
    newId = await createWithFallback(vals);
  } catch (e) {
    const errMsg = String(e?.message || "");
    let retry = false;

    if (errMsg.includes("first_name") || errMsg.includes("middle_name") || errMsg.includes("last_name")) {
      delete vals.first_name;
      delete vals.middle_name;
      delete vals.last_name;
      retry = true;
    }
    if (errMsg.includes("company_name")) {
      delete vals.company_name;
      retry = true;
    }
    if (errMsg.includes("branch_code")) {
      delete vals.branch_code;
      retry = true;
    }

    if (retry) {
      try {
        newId = await createWithFallback(vals);
      } catch (e2) {
        const errMsg2 = String(e2?.message || "");
        let retry2 = false;
        if (errMsg2.includes("branch_code")) {
          delete vals.branch_code;
          retry2 = true;
        }
        if (errMsg2.includes("first_name") || errMsg2.includes("middle_name") || errMsg2.includes("last_name")) {
          delete vals.first_name;
          delete vals.middle_name;
          delete vals.last_name;
          retry2 = true;
        }
        if (retry2) {
          newId = await createWithFallback(vals);
        } else {
          throw e2;
        }
      }
    } else {
      throw e;
    }
  }

  return {
    status: "created", partnerId: Number(newId), created: true, name,
    entityType, tradeName, proprietorName
  };
}

function pickBillLevelTaxIds(taxMap, extracted, vendorCountry) {
  const classification = String(extracted?.vat?.classification || "").toLowerCase();
  const lineItems = extracted?.line_items || [];
  const anyLineVatable = lineItems.some((li) => String(li.vat_code || "").toLowerCase() === "vatable");

  // Foreign vendors: their local tax (GST/VAT) is not PH input VAT — fully expense
  // If we have an object with a country, check it. Otherwise, fallback to checking the string.
  let isPH = true;
  if (typeof extracted?.vendor_details?.address === "object" && extracted?.vendor_details?.address !== null) {
    const country = String(extracted.vendor_details.address.country || "").toLowerCase().trim();
    if (country && !/philipp|^ph$/i.test(country)) {
      isPH = false;
    }
  } else {
    const foreignAddr = String(vendorCountry || "").toLowerCase();
    isPH = !foreignAddr || /philipp|^ph$|makati|manila|quezon|pasig|taguig|cebu|davao/i.test(foreignAddr);
  }

  if (!isPH) return [];

  if (!anyLineVatable && (classification === "exempt" || classification === "zero_rated" || classification === "unknown")) {
    if (classification === "exempt" && taxMap.exemptId) return [taxMap.exemptId];
    if (classification === "zero_rated" && taxMap.zeroRatedId) return [taxMap.zeroRatedId];
    return [];
  }
  const gs = String(extracted?.vat?.goods_or_services || "").toLowerCase();
  if (gs === "services" && taxMap.servicesId) return [taxMap.servicesId];
  if (gs === "goods" && taxMap.goodsId) return [taxMap.goodsId];
  return taxMap.genericId ? [taxMap.genericId] : [];
}

function pickLineTaxIds(taxMap, lineItem, billGoodsOrServices, vendorCountry, extracted) {
  const vatCode = String(lineItem.vat_code || "").toLowerCase();
  const gs = String(lineItem.goods_or_services || billGoodsOrServices || "").toLowerCase();
  const isCapital = !!(lineItem.is_capital_goods);
  const isImported = !!(lineItem.is_imported);
  const cat = String(lineItem.expense_category || "").toLowerCase();

  let isPH = true;
  if (typeof extracted?.vendor_details?.address === "object" && extracted?.vendor_details?.address !== null) {
    const country = String(extracted.vendor_details.address.country || "").toLowerCase().trim();
    if (country && !/philipp|^ph$/i.test(country)) {
      isPH = false;
    }
  } else {
    const foreignAddr = String(vendorCountry || "").toLowerCase();
    isPH = !foreignAddr || /philipp|^ph$|makati|manila|quezon|pasig|taguig|cebu|davao/i.test(foreignAddr);
  }

  if (!isPH && !isImported) return [];

  if (vatCode === "exempt") {
    if (isImported && taxMap.exemptImportsId) return [taxMap.exemptImportsId];
    return taxMap.exemptId ? [taxMap.exemptId] : [];
  }
  if (vatCode === "zero_rated") return taxMap.zeroRatedId ? [taxMap.zeroRatedId] : [];
  if (vatCode === "no_vat") return [];
  if (vatCode !== "vatable") return [];

  if (isCapital && taxMap.capitalId) return [taxMap.capitalId];

  const capitalCats = /equipment|machinery|vehicle|furniture|fixture|ppe|capital|computer\b|laptop|server/i;
  if (capitalCats.test(cat) && taxMap.capitalId) return [taxMap.capitalId];

  if (isImported && taxMap.importsId) return [taxMap.importsId];

  // Foreign vendors: their local tax (GST/VAT) is not PH input VAT — fully expense
  if (!isPH) return [];

  if (gs === "services" && taxMap.servicesId) return [taxMap.servicesId];
  if (gs === "goods" && taxMap.goodsId) return [taxMap.goodsId];
  if (cat && /professional_fees|outsourced_services|rent|repairs|freight|utilities|commission|contractor/.test(cat) && taxMap.servicesId) return [taxMap.servicesId];
  if (cat && /office_supplies|inventory|fuel|meals/.test(cat) && taxMap.goodsId) return [taxMap.goodsId];

  return taxMap.genericId ? [taxMap.genericId] : [];
}

/**
 * Picks the EWT tax ID from taxMap.ewt by rate and vendor type (individual vs corporate).
 * vendorIsIndividual: true = WI codes, false = WC codes.
 */
function ewtIdByRate(taxMap, rate, vendorIsIndividual) {
  const ewt = taxMap.ewt || {};
  const r = Math.round(Number(rate) || 0);
  const wi = vendorIsIndividual !== false; // default to WI if unknown
  if (r === 1) return (wi ? ewt.wi1 : ewt.wc1) || ewt.wi1 || ewt.wc1 || 0;
  if (r === 2) return (wi ? ewt.wi2 : ewt.wc2) || ewt.wi2 || ewt.wc2 || 0;
  if (r === 5) return (wi ? ewt.wi5 : ewt.wc5) || ewt.wi5 || ewt.wc5 || 0;
  if (r === 10) return (wi ? ewt.wi10 : ewt.wc10) || ewt.wi10 || ewt.wc10 || 0;
  if (r === 15) return (wi ? ewt.wi15 : ewt.wc15) || ewt.wi15 || ewt.wc15 || 0;
  return 0;
}

/**
 * Determines whether the vendor is an individual (WI) or non-individual/corporate (WC)
 * based on extracted entity_type.
 * Returns true for individual/sole_proprietor, false for corporation, undefined for unknown.
 */
function isVendorIndividual(extracted) {
  const et = String(extracted?.vendor_details?.entity_type || "").toLowerCase();
  if (et === "individual" || et === "sole_proprietor") return true;
  if (et === "corporation" || et === "general_professional_partnership"
    || et === "non_profit_organization" || et === "cooperative"
    || et === "government_entity") return false;
  return undefined; // unknown — caller decides default
}

/**
 * Certain entity types are exempt from Expanded Withholding Tax (EWT):
 * - General Professional Partnerships (GPPs): pass-through entities exempt from income tax
 * - Non-profit organizations: exempt under NIRC Sec. 30
 * - Cooperatives: exempt from income tax under the Cooperative Code
 * - Government entities: exempt from EWT
 */
function isVendorEwtExempt(extracted) {
  const et = String(extracted?.vendor_details?.entity_type || "").toLowerCase();
  return et === "general_professional_partnership"
      || et === "non_profit_organization"
      || et === "cooperative"
      || et === "government_entity";
}

/**
 * Determines which EWT (Expanded Withholding Tax) ID applies to a bill line.
 * Returns 0 if no EWT applies.
 *
 * Uses BIR ATC codes:
 *   WI = individual/sole proprietor, WC = corporate/juridical
 *
 * Priority:
 *  1. If the invoice itself shows an EWT rate (extracted.withholding_tax), use that
 *  2. Otherwise, determine from TWA status + expense category per BIR RR 11-2018:
 *     - TWA: 1% goods (WI158/WC158), 2% services (WI160/WC160)
 *     - professional_fees: 5-15% (WI010/WC010)
 *     - outsourced_services: 2% (WI120/WC120)
 *     - rent: 5% (WI100/WC100)
 *     - contractor/repairs: 2% (WI140/WC140)
 *     - commission: 10% (WI150/WC150)
 *     - freight: 2%
 */
function pickEwtTaxId(taxMap, expenseCategory, goodsOrServices, entityFlags, extracted, resolvedAccountName = "", resolvedAccountCode = "") {
  const { country, isTopWithholdingAgent } = entityFlags || {};

  // Only PH entities get EWT
  if (country && !/philipp|^ph$/i.test(country)) return 0;

  // Foreign vendors are not subject to PH EWT (only domestic/resident payees)
  if (typeof extracted?.vendor_details?.address === "object" && extracted?.vendor_details?.address !== null) {
    const vendorCountry = String(extracted.vendor_details.address.country || "").toLowerCase().trim();
    if (vendorCountry && !/philipp|^ph$/i.test(vendorCountry)) return 0;
  }

  // GPPs, non-profits, cooperatives, and government entities are exempt from EWT
  if (isVendorEwtExempt(extracted)) return 0;

  const vendorIndiv = isVendorIndividual(extracted);

  // If the invoice explicitly shows an EWT rate, prefer that
  const wht = extracted?.withholding_tax;
  if (wht?.detected && wht.ewt_rate > 0) {
    const invoiceEwtId = ewtIdByRate(taxMap, wht.ewt_rate, vendorIndiv);
    if (invoiceEwtId) return invoiceEwtId;
  }

  // Account-based EWT: higher priority than category-based, driven by the resolved account
  const accountEwt = pickEwtByAccount(resolvedAccountName, resolvedAccountCode, taxMap, vendorIndiv, isTopWithholdingAgent);
  if (accountEwt) return accountEwt;

  const cat = String(expenseCategory || "").toLowerCase();
  const gs = String(goodsOrServices || "").toLowerCase();

  if (isTopWithholdingAgent) {
    // TWA: 1% on goods (WI157/WC157), 2% on services (WI158/WC158)
    if (gs === "goods") return ewtIdByRate(taxMap, 1, vendorIndiv);
    if (gs === "services") return ewtIdByRate(taxMap, 2, vendorIndiv);
    return ewtIdByRate(taxMap, 2, vendorIndiv) || ewtIdByRate(taxMap, 1, vendorIndiv);
  }

  // Non-TWA: specific categories per BIR RR 11-2018
  // Professional fees: always apply the higher rate for conservatism (BIR RR 2-98 / RR 14-2018).
  // Lower rate (5% individual / 10% corporate) requires a Sworn Declaration from the vendor.
  if (cat === "professional_fees") {
    if (vendorIndiv === false) return ewtIdByRate(taxMap, 15, false);
    return ewtIdByRate(taxMap, 10, true);
  }
  // Outsourced services: 2% (WI120/WC120) — NOT professional fees
  if (cat === "outsourced_services") return ewtIdByRate(taxMap, 2, vendorIndiv);
  // Rental: 5% (WI100/WC100)
  if (cat === "rent") return ewtIdByRate(taxMap, 5, vendorIndiv);
  // Contractors/repairs: 2% (WI140/WC140)
  if (cat === "repairs" || cat === "contractor") return ewtIdByRate(taxMap, 2, vendorIndiv);
  // Freight: 2%
  if (cat === "freight") return ewtIdByRate(taxMap, 2, vendorIndiv);
  // Commission: 10% (WI150/WC150)
  if (cat === "commission") return ewtIdByRate(taxMap, 10, vendorIndiv);

  // Non-TWA with no matching category but invoice shows EWT → still try to apply
  if (wht?.detected && wht.ewt_rate > 0) {
    return ewtIdByRate(taxMap, wht.ewt_rate, vendorIndiv);
  }

  return 0;
}

/**
 * Picks EWT tax ID based on the resolved expense account name.
 * Returns 0 if no keyword in the account name matches a known EWT pattern.
 *
 * BIR ATC reference:
 *   WI010/WC010 — Professional fees (indiv/corp)
 *   WI100/WC100 — Rent
 *   WI120/WC120 — Outsourced / contracted services
 *   WI140/WC140 — Repairs & maintenance / contractor
 *   WI150/WC150 — Commission / brokerage
 *   WI158/WC158 — Goods / inventory (TWA only, 1%)
 *   WI160/WC160 — Utilities (TWA only, 2%)
 */
function pickEwtByAccount(accountName, accountCode, taxMap, vendorIsIndividual, isTWA) {
  const name = String(accountName || "").toLowerCase();
  if (!name) return 0;

  // Rent / rental / lease → 5% (WI100/WC100)
  if (/rent|rental|lease/.test(name)) return ewtIdByRate(taxMap, 5, vendorIsIndividual);

  // Licensed professional fees → higher rate for conservatism (WI010/WC010)
  // Note: \blegal\b prevents false match on "paralegal"; "consulting" covered separately
  if (/professional.fee|professional.service|consultanc|consulting.fee|\blegal\b|audit\b|advisory|accountant|engineer|architect|doctor|notari/.test(name)) {
    if (vendorIsIndividual === false) return ewtIdByRate(taxMap, 15, false);
    return ewtIdByRate(taxMap, 10, true);
  }

  // Outsourced / contracted services → 2% (WI120/WC120)
  // Note: security[\s-]?serv avoids matching unrelated "security" account names (e.g. "Security Deposit")
  if (/outsourc|janitorial|security[\s-]?serv|manpower|staffing|subcontract/.test(name)) return ewtIdByRate(taxMap, 2, vendorIsIndividual);

  // Commission / brokerage → 10% (WI150/WC150)
  if (/\b(commission|brokerage)\b/.test(name)) return ewtIdByRate(taxMap, 10, vendorIsIndividual);

  // Repairs / maintenance / contractor → 2% (WI140/WC140)
  if (/repair|maintenance|contractor\b/.test(name)) return ewtIdByRate(taxMap, 2, vendorIsIndividual);

  // TWA only: utilities → 2% (WI160/WC160)
  if (isTWA && /utilit|electric|meralco|water\b|pldt|smart\b|globe\b|internet|telecom|telephone/.test(name)) {
    return ewtIdByRate(taxMap, 2, vendorIsIndividual);
  }

  // TWA only: goods / inventory / supplies → 1% (WI158/WC158)
  if (isTWA && /inventor|supplies|merchandise|cost.of.sale|cost.of.good|cogs\b|raw.material/.test(name)) {
    return ewtIdByRate(taxMap, 1, vendorIsIndividual);
  }

  return 0;
}

async function getTaxMeta(odoo, companyId, taxIds) {
  if (!taxIds.length) return null;
  const rows = await odoo.searchRead(
    "account.tax",
    [["id", "in", taxIds]],
    ["id", "amount", "price_include"],
    kwWithCompany(companyId, { limit: 10 })
  );
  if (!rows.length) return null;
  const tax = rows[0];
  return {
    priceInclude: !!tax.price_include,
    amount: Number(tax.amount || 0)
  };
}

async function findDuplicateBill(odoo, companyId, vendorId, extracted, docId) {
  // First check if the document is already explicitly linked to any bill
  if (docId) {
    const docRows = await odoo.searchRead(
      "documents.document",
      [["id", "=", Number(docId)], ["res_model", "=", "account.move"]],
      ["res_id"],
      kwWithCompany(companyId, { limit: 1 })
    );
    if (docRows?.length && docRows[0].res_id) {
      const existingBill = await odoo.searchRead(
        "account.move",
        [["id", "=", Number(docRows[0].res_id)]],
        ["id", "ref", "amount_total", "state"],
        kwWithCompany(companyId, { limit: 1 })
      );
      if (existingBill?.length) return existingBill[0];
    }
  }

  const invoiceNumber = String(extracted?.invoice?.number || "").trim();
  const amountTotal = Number(extracted?.totals?.grand_total || 0);
  const domain = [["move_type", "=", "in_invoice"]];
  if (vendorId) domain.push(["partner_id", "=", vendorId]);
  if (invoiceNumber) domain.push(["ref", "=", invoiceNumber]);
  const rows = await odoo.searchRead(
    "account.move",
    domain,
    ["id", "ref", "amount_total", "state"],
    kwWithCompany(companyId, { limit: 20, order: "id desc" })
  );
  return (
    rows.find((r) => {
      const dbAmount = Number(r.amount_total || 0);
      const delta = Math.abs(dbAmount - amountTotal);
      return delta <= 0.02;
    }) || null
  );
}

async function resolveCurrencyId(odoo, companyId, currencyCode) {
  if (!currencyCode) return null;
  const code = currencyCode.toUpperCase().trim();
  if (!code || code === "PHP") return null;
  const rows = await odoo.searchRead(
    "res.currency",
    [["name", "=", code], ["active", "=", true]],
    ["id"],
    kwWithCompany(companyId, { limit: 1 })
  );
  return rows?.[0]?.id ? Number(rows[0].id) : null;
}

// --- Expense Account Resolution ---

const expenseAccountsCache = new Map();

async function loadExpenseAccounts(odoo, companyId) {
  const key = `${companyId}`;
  if (expenseAccountsCache.has(key)) return expenseAccountsCache.get(key);

  let accounts = [];
  const errors = [];

  const attempts = [
    {
      label: "expense_types",
      domain: [["account_type", "in", ["expense", "expense_direct_cost", "expense_depreciation", "asset_current"]]]
    },
    {
      label: "expense_basic",
      domain: [["account_type", "in", ["expense", "expense_direct_cost"]]]
    },
    {
      label: "code_5_or_6",
      domain: ["|", ["code", "like", "5"], ["code", "like", "6"]]
    },
    {
      label: "all_accounts",
      domain: []
    }
  ];

  for (const attempt of attempts) {
    if (accounts.length) break;
    try {
      accounts = await odoo.searchRead(
        "account.account",
        attempt.domain,
        ["id", "code", "name"],
        kwWithCompany(companyId, { limit: 1000, order: "code asc" })
      );
      if (accounts.length) {
        errors.push(`OK: ${attempt.label} returned ${accounts.length} accounts`);
      }
    } catch (err) {
      errors.push(`FAIL: ${attempt.label}: ${String(err?.message || err).slice(0, 120)}`);
    }
  }

  if (!accounts.length) {
    errors.push("ALL QUERIES FAILED - 0 accounts loaded");
  }

  const result = accounts.map((a) => ({
    id: Number(a.id),
    code: String(a.code || ""),
    name: String(a.name || "")
  }));
  result._loadLog = errors;
  expenseAccountsCache.set(key, result);
  return result;
}

const vendorAccountCache = new Map();

async function getVendorDefaultAccountId(odoo, companyId, vendorId) {
  if (!vendorId) return 0;
  const key = `${companyId}:${vendorId}`;
  if (vendorAccountCache.has(key)) return vendorAccountCache.get(key);

  let accountId = 0;
  try {
    const rows = await odoo.searchRead(
      "res.partner",
      [["id", "=", vendorId]],
      ["id", "property_account_expense_id"],
      kwWithCompany(companyId, { limit: 1 })
    );
    const raw = rows?.[0]?.property_account_expense_id;
    accountId = raw ? (Array.isArray(raw) ? Number(raw[0]) : Number(raw)) : 0;
  } catch (_) {}
  vendorAccountCache.set(key, accountId);
  return accountId;
}

let accountMappingCache = null;

async function getAccountMapping() {
  if (accountMappingCache !== null) return accountMappingCache;
  try {
    accountMappingCache = await loadAccountMapping(config);
  } catch (_) {
    accountMappingCache = [];
  }
  return accountMappingCache;
}

function lookupAccountMapping(mapping, companyId, category, targetDb) {
  const cat = String(category || "").trim().toLowerCase();
  if (!cat) return 0;
  const db = String(targetDb || "").trim().toLowerCase();

  // Exact match: target_db + company_id + category
  let match = mapping.find((m) =>
    m.category === cat &&
    m.companyId === companyId &&
    m.targetDb && m.targetDb === db
  );
  if (match) return match.accountId;

  // Fallback: company_id + category (no target_db or blank target_db)
  match = mapping.find((m) =>
    m.category === cat &&
    m.companyId === companyId &&
    !m.targetDb
  );
  if (match) return match.accountId;

  // Fallback: category only (global default row with no company_id and no target_db)
  match = mapping.find((m) => m.category === cat && !m.companyId && !m.targetDb);
  return match ? match.accountId : 0;
}

const GENERIC_ACCOUNT_WORDS = new Set([
  "expense", "expenses", "admin", "administrative", "general", "miscellaneous",
  "other", "misc", "sundry", "various"
]);

const CATEGORY_KEYWORDS = {
  fuel: ["fuel", "gas", "oil", "lpg", "diesel", "petroleum", "gasoline", "petrol"],
  office_supplies: ["office", "supplies", "stationery", "paper", "toner", "ink"],
  meals: ["meals", "food", "representation", "entertainment", "catering"],
  repairs: ["repairs", "maintenance", "repair"],
  rent: ["rent", "rental", "lease"],
  professional_fees: ["professional", "fees", "consulting", "legal", "audit", "advisory"],
  freight: ["freight", "shipping", "delivery", "transport", "logistics", "courier"],
  utilities: ["utilities", "electricity", "water", "power", "telephone", "internet", "communication", "telecom"],
  inventory: ["inventory", "cost of goods", "cogs", "merchandise", "stock", "cost of sales"]
};

function fuzzyMatchAccount(accounts, suggestedName, category, lineDescription) {
  if (!accounts.length) return 0;
  const query = String(suggestedName || lineDescription || category || "").toLowerCase();
  if (!query) return 0;

  const tokens = query.split(/[\s&,/_-]+/).filter((t) => t.length > 2);
  if (!tokens.length) return 0;

  const extraTokens = CATEGORY_KEYWORDS[String(category || "").toLowerCase()] || [];
  const allTokens = [...new Set([...tokens, ...extraTokens])];
  const specificTokens = allTokens.filter((t) => !GENERIC_ACCOUNT_WORDS.has(t));

  let bestId = 0;
  let bestScore = 0;
  for (const acct of accounts) {
    const haystack = `${acct.code} ${acct.name}`.toLowerCase();
    let score = 0;
    let specificHits = 0;
    for (const t of allTokens) {
      if (haystack.includes(t)) {
        const weight = GENERIC_ACCOUNT_WORDS.has(t) ? 1 : t.length;
        score += weight;
        if (!GENERIC_ACCOUNT_WORDS.has(t)) specificHits++;
      }
    }
    const nameWords = acct.name.toLowerCase().split(/[\s&,/_-]+/).filter((w) => w.length > 2);
    const genericNameRatio = nameWords.filter((w) => GENERIC_ACCOUNT_WORDS.has(w)).length / (nameWords.length || 1);
    if (genericNameRatio > 0.5) score = Math.floor(score * 0.4);

    if (score > bestScore || (score === bestScore && specificHits > 0)) {
      bestScore = score;
      bestId = acct.id;
    }
  }
  return bestScore >= 4 ? bestId : 0;
}

function isGenericAccount(acct) {
  if (!acct) return false;
  const name = String(acct.name || "").toLowerCase();
  const nameWords = name.split(/[\s&,/_-]+/).filter((w) => w.length > 2);
  const genericRatio = nameWords.filter((w) => GENERIC_ACCOUNT_WORDS.has(w)).length / (nameWords.length || 1);
  return genericRatio > 0.5;
}

function resolveGeminiCandidate(candidate, expenseAccounts) {
  if (!candidate || !expenseAccounts?.length) return 0;
  const id = Number(candidate.account_id || 0);
  if (id && expenseAccounts.some((a) => a.id === id)) return id;
  const code = String(candidate.account_code || "").trim();
  if (code) {
    const byCode = expenseAccounts.find((a) => a.code === code);
    if (byCode) return byCode.id;
  }
  const name = String(candidate.account_name || "").trim().toLowerCase();
  if (name) {
    const byName = expenseAccounts.find((a) => a.name.toLowerCase() === name);
    if (byName) return byName.id;
    const byPartial = expenseAccounts.find((a) =>
      a.name.toLowerCase().includes(name) || name.includes(a.name.toLowerCase())
    );
    if (byPartial) return byPartial.id;
  }
  return 0;
}

function pickBestGeminiAccount(geminiPick, expenseAccounts) {
  if (!geminiPick || !expenseAccounts?.length) return { accountId: 0, source: "gemini" };
  const primaryId = resolveGeminiCandidate(geminiPick, expenseAccounts);
  if (primaryId) {
    const acct = expenseAccounts.find((a) => a.id === primaryId);
    if (!isGenericAccount(acct)) return { accountId: primaryId, source: "gemini" };
    const alts = geminiPick.alternatives || [];
    for (const alt of alts) {
      const altId = resolveGeminiCandidate(alt, expenseAccounts);
      if (altId) {
        const altAcct = expenseAccounts.find((a) => a.id === altId);
        if (!isGenericAccount(altAcct)) return { accountId: altId, source: "gemini_alt" };
      }
    }
    return { accountId: primaryId, source: "gemini_generic" };
  }
  const alts = geminiPick.alternatives || [];
  for (const alt of alts) {
    const altId = resolveGeminiCandidate(alt, expenseAccounts);
    if (altId) return { accountId: altId, source: "gemini_alt" };
  }
  return { accountId: 0, source: "gemini" };
}

async function resolveExpenseAccountId({
  odoo, companyId, vendorId, category, suggestedName,
  geminiPick, expenseAccounts, accountMapping, targetDb,
  lineDescription, vendorName, targetKey
}) {
  // Helper: enrich a result with accountCode + accountName from expenseAccounts
  const withMeta = (result) => {
    const acct = expenseAccounts?.find((a) => a.id === result.accountId);
    return { ...result, accountCode: acct?.code || "", accountName: acct?.name || "" };
  };

  // Tier 1: vendor default (skip if it's a generic account like Admin Expense)
  const vendorAcct = await getVendorDefaultAccountId(odoo, companyId, vendorId);
  if (vendorAcct && expenseAccounts?.length) {
    const vendorAcctObj = expenseAccounts.find((a) => a.id === vendorAcct);
    if (vendorAcctObj && !isGenericAccount(vendorAcctObj)) {
      return withMeta({ accountId: vendorAcct, source: "vendor_default" });
    }
  }

  // Tier 2: VendorAccountMemory (learned from past corrections, 3+ same correction; per target DB)
  if (vendorName && expenseAccounts?.length && targetKey) {
    const memory = await loadVendorAccountMemory(targetKey);
    const vNorm = String(vendorName || "").trim().toLowerCase();
    for (const entry of memory) {
      const pNorm = String(entry.vendor_name_pattern || "").trim().toLowerCase();
      if (!pNorm) continue;
      if (vNorm.includes(pNorm) || pNorm.includes(vNorm)) {
        const acct = expenseAccounts.find((a) => String(a.code || "").trim() === String(entry.account_code || "").trim());
        if (acct) return withMeta({ accountId: acct.id, source: "vendor_memory" });
      }
    }
  }

  // Tier 3: Gemini pick (validated + repaired via code/name, anti-generic guard)
  if (geminiPick && expenseAccounts?.length) {
    const result = pickBestGeminiAccount(geminiPick, expenseAccounts);
    if (result.accountId) return withMeta(result);
  }

  // Tier 4: vendor name keywords (e.g. "FABRIC TRADING" → Supplies)
  if (vendorName && expenseAccounts?.length) {
    const vnHint = vendorNameAccountHint(vendorName, expenseAccounts);
    if (vnHint) return withMeta({ accountId: vnHint, source: "vendor_name_hint" });
  }

  // Tier 5: sheet mapping (AccountMapping tab)
  if (accountMapping?.length) {
    const mapped = lookupAccountMapping(accountMapping, companyId, category, targetDb);
    if (mapped) return withMeta({ accountId: mapped, source: "sheet_mapping" });
  }

  // Tier 6: fuzzy name match using line description + category keywords
  if (expenseAccounts?.length) {
    const fuzzy = fuzzyMatchAccount(expenseAccounts, suggestedName, category, lineDescription);
    if (fuzzy) return withMeta({ accountId: fuzzy, source: "fuzzy_match" });
  }

  // Tier 7: Gemini pick even if generic (still better than Odoo's blind default)
  if (geminiPick && expenseAccounts?.length) {
    const primaryId = resolveGeminiCandidate(geminiPick, expenseAccounts);
    if (primaryId) return withMeta({ accountId: primaryId, source: "gemini_last_resort" });
  }

  // Tier 8: best non-generic expense account matching any keyword from description/category/vendor
  if (expenseAccounts?.length) {
    const combined = [suggestedName, lineDescription, category, vendorName].filter(Boolean).join(" ").toLowerCase();
    const words = combined.split(/[\s&,/_\-()]+/).filter((w) => w.length > 2);
    const nonGeneric = expenseAccounts.filter((a) => !isGenericAccount(a));
    if (nonGeneric.length) {
      let bestId = 0, bestHits = 0;
      for (const acct of nonGeneric) {
        const hay = `${acct.code} ${acct.name}`.toLowerCase();
        const hits = words.filter((w) => hay.includes(w)).length;
        if (hits > bestHits) { bestHits = hits; bestId = acct.id; }
      }
      if (bestId) return withMeta({ accountId: bestId, source: "keyword_last_resort" });
      return withMeta({ accountId: nonGeneric[0].id, source: "first_non_generic" });
    }
    return withMeta({ accountId: expenseAccounts[0].id, source: "first_available" });
  }

  // Tier 9: env fallback (env ID may not be in expenseAccounts, withMeta handles gracefully)
  if (config.odooDefaults.defaultExpenseAccountId > 0) {
    return withMeta({ accountId: config.odooDefaults.defaultExpenseAccountId, source: "env_fallback" });
  }

  return { accountId: 0, accountCode: "", accountName: "", source: "none" };
}

function adjustPriceForTax(price, invoiceVatInclusive, taxPriceInclude, taxRate) {
  if (!price) return price;
  if (invoiceVatInclusive && !taxPriceInclude) {
    return Math.round((price / (1 + taxRate / 100)) * 1e6) / 1e6;
  }
  if (!invoiceVatInclusive && taxPriceInclude) {
    return Math.round((price * (1 + taxRate / 100)) * 1e6) / 1e6;
  }
  return price;
}

function lineItemsTotalMatchesInvoice(lineItems, grandTotal, netTotal) {
  if (!lineItems.length) return false;
  const lineSum = lineItems.reduce((s, li) => s + Number(li.amount || 0), 0);
  if (!lineSum) return false;
  // When both net and grand totals exist, line item amounts should match the net/vatable
  // total (pre-tax).  Comparing against grand total is misleading because the tax gap makes
  // a wrong lineSum appear close to grand total (e.g. 4785 vs 4885 = 2% but net is 4361).
  // Use 2% tolerance — anything larger indicates wrong quantities or amounts.
  const TOL = 0.02;
  if (netTotal > 0 && netTotal !== grandTotal) {
    const diffNet = Math.abs(lineSum - netTotal) / netTotal;
    if (diffNet < TOL) return true;
  }
  if (grandTotal > 0) {
    const diffGrand = Math.abs(lineSum - grandTotal) / grandTotal;
    if (diffGrand < TOL) return true;
  }
  return false;
}

function extractOcrAmounts(ocrText) {
  if (!ocrText) return [];
  const matches = ocrText.match(/[\d,]+\.?\d*/g) || [];
  return matches
    .map((s) => Number(s.replace(/,/g, "")))
    .filter((n) => n >= 100 && Number.isFinite(n));
}

function isTotalLikeLabel(label) {
  const l = String(label || "").toLowerCase();
  const excludePatterns = ["line_item", "line item", "unit_price", "unit price", "vat_amount", "vat amount", "tax_amount", "tax amount", "exempt", "zero_rated"];
  if (excludePatterns.some((p) => l.includes(p))) return false;
  return l.includes("total") || l.includes("grand") || l.includes("due") || l.includes("amount due") || l.includes("amount_due") || l === "amount" || l.includes("subtotal");
}

function fixExtractedAmounts(extracted, ocrText, logger) {
  const totals = extracted?.totals;
  if (!totals) return;
  const grandTotal = Number(totals.grand_total || 0);
  const lineItems = extracted?.line_items || [];
  const candidates = (extracted?.amount_candidates || [])
    .map((c) => ({ amount: Number(c.amount || 0), confidence: Number(c.confidence || 0), label: String(c.label || "").toLowerCase() }))
    .filter((c) => c.amount >= 10);
  const ocrAmounts = extractOcrAmounts(ocrText);

  let correctTotal = 0;

  const lineSum = lineItems.reduce((s, li) => s + Number(li.amount || 0), 0);

  // Case Y: grand_total looks like a year (2020-2030) confused with a monetary amount
  if (!correctTotal && grandTotal >= 2020 && grandTotal <= 2030 && grandTotal === Math.floor(grandTotal)) {
    if (lineItems.length >= 1 && lineSum > 0 && Math.abs(lineSum - grandTotal) / grandTotal > 0.1 && (lineSum < 2020 || lineSum > 2030)) {
      correctTotal = lineSum;
      if (logger) logger.info("Amount correction: grand total looks like a year number.", {
        geminiTotal: grandTotal, lineSum
      });
    } else {
      const totalCand = candidates
        .filter((c) => isTotalLikeLabel(c.label) && Math.abs(c.amount - grandTotal) / grandTotal > 0.1 && (c.amount < 2020 || c.amount > 2030))
        .sort((a, b) => b.confidence - a.confidence)[0];
      if (totalCand) {
        correctTotal = totalCand.amount;
        if (logger) logger.info("Amount correction: grand total looks like a year, using candidate.", {
          geminiTotal: grandTotal, candidateAmount: totalCand.amount, label: totalCand.label
        });
      } else {
        const anyCand = candidates
          .filter((c) => Math.abs(c.amount - grandTotal) / grandTotal > 0.1 && (c.amount < 2020 || c.amount > 2030))
          .sort((a, b) => b.amount - a.amount)[0];
        if (anyCand) {
          correctTotal = anyCand.amount;
          if (logger) logger.info("Amount correction: grand total looks like a year, using largest non-year candidate.", {
            geminiTotal: grandTotal, candidateAmount: anyCand.amount, label: anyCand.label
          });
        } else {
          const nonYearOcr = ocrAmounts.filter((n) => n < 2020 || n > 2030);
          if (nonYearOcr.length > 0) {
            correctTotal = Math.max(...nonYearOcr);
            if (logger) logger.info("Amount correction: grand total looks like a year, fallback to max OCR.", {
              geminiTotal: grandTotal, maxOcr: correctTotal
            });
          }
        }
      }
    }
  }

  // Case A: line sum >> grand total (grand total is too small — missing digits or picked a line item)
  if (!correctTotal && lineItems.length >= 2 && lineSum >= 100 && grandTotal >= 1) {
    const ratio = lineSum / grandTotal;
    if (ratio >= 2 && ratio <= 20) {
      correctTotal = lineSum;
      if (logger) logger.info("Amount correction: line sum >> grand total.", {
        geminiTotal: grandTotal, lineSum, ratio: ratio.toFixed(1)
      });
    }
  }

  // Case B: grand total >> line sum (grand total inflated, e.g. 85509 vs 8017)
  if (!correctTotal && lineItems.length >= 1 && lineSum >= 100 && grandTotal >= 1) {
    const ratio = grandTotal / lineSum;
    if (ratio >= 5 && ratio <= 15) {
      const bestCandidate = candidates
        .filter((c) => isTotalLikeLabel(c.label))
        .sort((a, b) => b.confidence - a.confidence)[0];
      if (bestCandidate && Math.abs(bestCandidate.amount - lineSum) / lineSum < 2) {
        correctTotal = bestCandidate.amount;
      } else {
        correctTotal = lineSum;
      }
      if (logger) logger.info("Amount correction: grand total >> line sum (inflated).", {
        geminiTotal: grandTotal, lineSum, corrected: correctTotal, ratio: ratio.toFixed(1)
      });
    }
  }

  // Case C: amount_candidate much larger than grand total (grand total truncated or picked a line item)
  if (!correctTotal && grandTotal >= 1) {
    const totalCands = candidates
      .filter((c) => isTotalLikeLabel(c.label))
      .sort((a, b) => b.amount - a.amount);
    for (const c of totalCands) {
      const ratio = c.amount / grandTotal;
      if (ratio >= 2 && ratio <= 20 && c.amount > grandTotal) {
        correctTotal = c.amount;
        if (logger) logger.info("Amount correction: total-candidate >> grand total.", {
          geminiTotal: grandTotal, candidateAmount: c.amount, label: c.label, ratio: ratio.toFixed(1)
        });
        break;
      }
    }
    if (!correctTotal) {
      for (const c of candidates) {
        const ratio = c.amount / grandTotal;
        if (ratio >= 5 && ratio <= 15) {
          correctTotal = c.amount;
          if (logger) logger.info("Amount correction: candidate >> grand total.", {
            geminiTotal: grandTotal, candidateAmount: c.amount, label: c.label, ratio: ratio.toFixed(1)
          });
          break;
        }
      }
    }
  }

  // Case D: amount_candidate much smaller than grand total (grand total inflated)
  if (!correctTotal && grandTotal >= 1) {
    const totalCandidates = candidates.filter((c) => isTotalLikeLabel(c.label));
    for (const c of totalCandidates) {
      const ratio = grandTotal / c.amount;
      if (ratio >= 5 && ratio <= 15) {
        correctTotal = c.amount;
        if (logger) logger.info("Amount correction: grand total >> candidate (inflated).", {
          geminiTotal: grandTotal, candidateAmount: c.amount, label: c.label, ratio: ratio.toFixed(1)
        });
        break;
      }
    }
  }

  // Case E: OCR max much larger than grand total (grand total truncated)
  if (!correctTotal && ocrAmounts.length && grandTotal >= 1) {
    const maxOcr = Math.max(...ocrAmounts);
    const ratio = maxOcr / grandTotal;
    if (ratio >= 2 && ratio <= 20) {
      correctTotal = maxOcr;
      if (logger) logger.info("Amount correction: OCR max >> grand total.", {
        geminiTotal: grandTotal, ocrMax: maxOcr, ratio: ratio.toFixed(1)
      });
    }
  }

  // Case F: grand total much larger than ALL OCR amounts (grand total inflated)
  if (!correctTotal && ocrAmounts.length >= 2 && grandTotal >= 100) {
    const maxOcr = Math.max(...ocrAmounts);
    const ratio = grandTotal / maxOcr;
    if (ratio >= 5 && ratio <= 15) {
      correctTotal = maxOcr;
      if (logger) logger.info("Amount correction: grand total >> OCR max (inflated).", {
        geminiTotal: grandTotal, ocrMax: maxOcr, ratio: ratio.toFixed(1)
      });
    }
  }

  // Case H: grand_total ≈ tax_total or vat_amount (picked VAT component as total)
  if (!correctTotal && grandTotal >= 1) {
    const taxTotal = Number(totals.tax_total || 0);
    const vatAmount = Number(extracted?.vat?.vat_amount || 0);
    const vatBase = Number(extracted?.vat?.vatable_base || 0);
    const taxRef = taxTotal || vatAmount;

    if (taxRef > 0 && Math.abs(grandTotal - taxRef) / grandTotal < 0.1) {
      if (vatBase > 0 && vatBase > taxRef) {
        correctTotal = vatBase + taxRef;
      } else {
        const bigCandidate = candidates
          .filter((c) => c.amount > grandTotal * 2 && isTotalLikeLabel(c.label))
          .sort((a, b) => b.confidence - a.confidence)[0];
        if (bigCandidate) {
          correctTotal = bigCandidate.amount;
        } else {
          correctTotal = Math.round((taxRef / 0.12) * 1.12 * 100) / 100;
        }
      }
      if (logger) logger.info("Amount correction: grand_total ≈ tax/vat_amount (picked VAT as total).", {
        geminiTotal: grandTotal, taxRef, vatBase, corrected: correctTotal
      });
    }
  }

  // Case I: tax_total > grand_total (impossible — tax cannot exceed total)
  if (!correctTotal && grandTotal >= 1) {
    const taxTotal = Number(totals.tax_total || 0);
    if (taxTotal > 0 && taxTotal > grandTotal * 0.20) {
      const bigCandidates = candidates
        .filter((c) => c.amount > grandTotal && isTotalLikeLabel(c.label))
        .sort((a, b) => b.confidence - a.confidence);
      if (bigCandidates.length) {
        correctTotal = bigCandidates[0].amount;
      } else if (lineSum > grandTotal * 1.5) {
        correctTotal = lineSum;
      } else {
        correctTotal = Math.round((taxTotal / 0.12) * 1.12 * 100) / 100;
      }
      if (logger) logger.info("Amount correction: tax_total > 20% of grand_total (likely wrong grand total).", {
        geminiTotal: grandTotal, taxTotal, lineSum, corrected: correctTotal
      });
    }
  }

  // Case G: decimal point misread — grandTotal / 10 or /100 is close to lineSum or a candidate
  if (!correctTotal && grandTotal >= 1000) {
    for (const divisor of [10, 100]) {
      const scaled = grandTotal / divisor;
      if (lineSum >= 100 && Math.abs(scaled - lineSum) / lineSum < 0.4) {
        correctTotal = lineSum;
        if (logger) logger.info("Amount correction: decimal misread (grand total /" + divisor + " ≈ line sum).", {
          geminiTotal: grandTotal, scaled: scaled.toFixed(2), lineSum
        });
        break;
      }
      const matchCandidate = candidates.find((c) =>
        Math.abs(scaled - c.amount) / c.amount < 0.15 && isTotalLikeLabel(c.label)
      );
      if (matchCandidate) {
        correctTotal = matchCandidate.amount;
        if (logger) logger.info("Amount correction: decimal misread (grand total /" + divisor + " ≈ candidate).", {
          geminiTotal: grandTotal, scaled: scaled.toFixed(2), candidateAmount: matchCandidate.amount, label: matchCandidate.label
        });
        break;
      }
    }
  }

  if (correctTotal > 0) {
    totals.grand_total = correctTotal;
    totals.grand_total_confidence = Math.min(totals.grand_total_confidence || 0.5, 0.7);
    if (totals.net_total) totals.net_total = correctTotal;
    if (lineItems.length === 1) {
      const li = lineItems[0];
      const liAmt = Number(li.amount || 0);
      if (Math.abs(liAmt - correctTotal) / (correctTotal || 1) > 0.5) {
        li.amount = correctTotal;
        const qty = Number(li.quantity) || 1;
        li.unit_price = qty > 0 ? Math.round((correctTotal / qty) * 100) / 100 : correctTotal;
      }
    }
  }
}

const VENDOR_NAME_ACCOUNT_KEYWORDS = {
  fabric: ["supplies", "raw materials", "inventory", "cost of sales", "cost of goods"],
  "fabric trading": ["supplies", "raw materials", "inventory", "cost of sales", "cost of goods"],
  textile: ["supplies", "raw materials", "inventory", "cost of sales"],
  cloth: ["supplies", "raw materials", "inventory"],
  hardware: ["supplies", "repairs", "maintenance", "hardware"],
  lumber: ["raw materials", "supplies", "cost of sales", "construction"],
  gas: ["fuel", "oil", "gas", "transportation"],
  fuel: ["fuel", "oil", "gas", "transportation"],
  petroleum: ["fuel", "oil", "gas", "petroleum"],
  food: ["meals", "food", "representation", "entertainment"],
  catering: ["meals", "food", "representation", "catering"],
  restaurant: ["meals", "food", "representation"],
  electrical: ["supplies", "electrical", "utilities"],
  plumbing: ["supplies", "plumbing", "repairs"],
  printing: ["printing", "supplies", "office"],
  stationery: ["office supplies", "stationery"],
  pharmacy: ["medical", "supplies", "medicine"],
  auto: ["repairs", "maintenance", "transportation"],
  tire: ["repairs", "maintenance", "transportation"],
  cement: ["raw materials", "construction", "supplies"],
  steel: ["raw materials", "construction", "supplies"],
  paint: ["supplies", "paint", "maintenance"],
  chemical: ["supplies", "chemicals", "raw materials"],
  laundry: ["laundry", "supplies", "services"],
  cleaning: ["janitorial", "cleaning", "supplies"]
};

function vendorNameAccountHint(vendorName, expenseAccounts) {
  if (!vendorName || !expenseAccounts?.length) return 0;
  const vn = String(vendorName).toLowerCase();
  for (const [keyword, searchTerms] of Object.entries(VENDOR_NAME_ACCOUNT_KEYWORDS)) {
    if (!vn.includes(keyword)) continue;
    for (const term of searchTerms) {
      const match = expenseAccounts.find((a) => {
        const name = a.name.toLowerCase();
        return name.includes(term) && !isGenericAccount(a);
      });
      if (match) return match.id;
    }
  }
  return 0;
}

function buildBillVals(extracted, vendorId, companyId, taxMap, billLevelTaxIds, purchaseJournalId, currencyId, taxMeta, lineAccountIds, vendorCountry, entityFlags, lineAccountMeta) {
  const inv = extracted?.invoice || {};
  const totals = extracted?.totals || {};
  const grandTotal = Number(totals.grand_total || 0);
  const netTotal = Number(totals.net_total || 0);
  const globalVatInclusive = !!totals.amounts_are_vat_inclusive;
  const hasBillTax = billLevelTaxIds.length > 0;
  const taxPriceInclude = !!taxMeta?.priceInclude;
  const taxRate = Number(taxMeta?.amount || 12);
  const billGs = String(extracted?.vat?.goods_or_services || "").toLowerCase();

  const usedNetTotal = hasBillTax && globalVatInclusive && !taxPriceInclude && netTotal > 0;
  const total = usedNetTotal ? netTotal : (grandTotal || netTotal || 0);
  const invoiceDate = String(inv.date || "").slice(0, 10) || undefined;
  const ref = String(inv.number || "").trim();

  const lineItems = extracted?.line_items || [];
  const useLineItems = lineItems.length > 0 && lineItemsTotalMatchesInvoice(lineItems, grandTotal, netTotal);
  const hint = extracted?.expense_account_hint || {};
  const invoiceLines = [];

  // Track whether the system applied the conservative higher rate for professional fees.
  // Not set when the invoice itself already shows an explicit EWT rate (we honour that instead).
  let profFeesEwtApplied = false;
  const whtDetectedOnInvoice = !!(extracted?.withholding_tax?.detected);
  const PROF_FEES_ACCOUNT_RE = /professional.fee|professional.service|consultanc|consulting.fee|\blegal\b|audit\b|advisory|accountant|engineer|architect|doctor|notari/;
  const isProfFeesContext = (category, accountName) => {
    if (String(category || "").toLowerCase() === "professional_fees") return true;
    return PROF_FEES_ACCOUNT_RE.test(String(accountName || "").toLowerCase());
  };

  const expectedUntaxed = hasBillTax && !taxPriceInclude && grandTotal > 0
    ? (netTotal > 0 ? netTotal : Math.round((grandTotal / (1 + taxRate / 100)) * 100) / 100)
    : (grandTotal || netTotal || 0);

  const hasPerLineVat = lineItems.some((li) => li.vat_code);

  if (useLineItems) {
    for (let i = 0; i < lineItems.length; i++) {
      const item = lineItems[i];
      const lineVatCode = String(item.vat_code || "").toLowerCase();

      let lineTaxIds;
      if (hasPerLineVat && lineVatCode) {
        lineTaxIds = pickLineTaxIds(taxMap, item, billGs, vendorCountry, extracted);
      } else {
        lineTaxIds = billLevelTaxIds;
      }

      // Append EWT (withholding tax) if applicable
      const lineGs = String(item.goods_or_services || billGs || "").toLowerCase();
      const acctMeta = lineAccountMeta?.[i] || {};
      const ewtId = pickEwtTaxId(taxMap, item.expense_category, lineGs, entityFlags, extracted, acctMeta.name, acctMeta.code);
      if (ewtId && !lineTaxIds.includes(ewtId)) {
        lineTaxIds = [...lineTaxIds, ewtId];
        if (!whtDetectedOnInvoice && isProfFeesContext(item.expense_category, acctMeta.name)) profFeesEwtApplied = true;
      }

      const lineHasTax = lineTaxIds.length > 0 && lineVatCode !== "no_vat";

      const itemVatInclusive = lineHasTax && (globalVatInclusive || (item.unit_price_includes_vat ?? false));
      const discount = Number(item.discount_percent || 0);
      const rawPrice = Number(item.unit_price || item.amount || 0);
      const line = {
        name: String(item.description || "Line item").slice(0, 256),
        quantity: Number(item.quantity) || 1,
        price_unit: lineHasTax ? adjustPriceForTax(rawPrice, itemVatInclusive, taxPriceInclude, taxRate) : rawPrice
      };
      if (discount > 0 && discount < 100) line.discount = discount;
      const acctId = lineAccountIds?.[i] || 0;
      if (acctId) line.account_id = acctId;
      if (lineTaxIds.length) line.tax_ids = [[6, 0, lineTaxIds]];
      else line.tax_ids = [[5, 0, 0]]; // Explicitly clear taxes to prevent Odoo from applying account defaults
      invoiceLines.push([0, 0, line]);
    }

    if (expectedUntaxed > 0 && invoiceLines.length > 0) {
      const lineUntaxedSum = invoiceLines.reduce((s, entry) => {
        const l = entry[2];
        const disc = Number(l.discount || 0) / 100;
        return s + (l.price_unit * l.quantity * (1 - disc));
      }, 0);
      const diff = expectedUntaxed - lineUntaxedSum;
      if (Math.abs(diff) > 0.005) {
        let bestIdx = 0;
        let bestScore = -Infinity;
        for (let i = 0; i < invoiceLines.length; i++) {
          const l = invoiceLines[i][2];
          const disc = Number(l.discount || 0) / 100;
          const lineTotal = l.price_unit * l.quantity * (1 - disc);
          const perUnitAdj = Math.abs(diff) / (l.quantity || 1);
          const adjRatio = perUnitAdj / (l.price_unit || 1);
          const score = lineTotal - adjRatio * 1e6;
          if ((l.quantity === 1 || adjRatio < 0.001) && disc === 0) {
            if (score > bestScore) { bestScore = score; bestIdx = i; }
          } else if (bestScore === -Infinity && disc === 0) {
            bestScore = score; bestIdx = i;
          }
        }
        const target = invoiceLines[bestIdx][2];
        const qty = target.quantity || 1;
        target.price_unit = Math.round((target.price_unit + diff / qty) * 1e6) / 1e6;
      }
    }
  } else {
    const singleLineVatInclusive = usedNetTotal ? false : globalVatInclusive;
    const adjustedTotal = hasBillTax ? adjustPriceForTax(total, singleLineVatInclusive, taxPriceInclude, taxRate) : total;
    const finalTotal = expectedUntaxed > 0 ? expectedUntaxed : adjustedTotal;
    const lineDescs = lineItems
      .map((li) => String(li.description || "").trim())
      .filter(Boolean);
    const fallbackLabel = lineDescs.length > 0
      ? lineDescs.join(", ").slice(0, 256)
      : "Vendor Bill";
    const line = {
      name: fallbackLabel,
      quantity: 1,
      price_unit: finalTotal
    };
    const acctId = lineAccountIds?.[0] || 0;
    if (acctId) line.account_id = acctId;
    // Append EWT for single-line bills
    const hint = extracted?.expense_account_hint || {};
    const singleCat = lineItems[0]?.expense_category || hint.category || "other";
    const singleGs = String(extracted?.vat?.goods_or_services || "").toLowerCase();
    const singleAcctMeta = lineAccountMeta?.[0] || {};
    const singleEwtId = pickEwtTaxId(taxMap, singleCat, singleGs, entityFlags, extracted, singleAcctMeta.name, singleAcctMeta.code);
    let singleTaxIds = [...billLevelTaxIds];
    if (singleEwtId && !singleTaxIds.includes(singleEwtId)) {
      singleTaxIds.push(singleEwtId);
      if (!whtDetectedOnInvoice && isProfFeesContext(singleCat, singleAcctMeta.name)) profFeesEwtApplied = true;
    }
    if (singleTaxIds.length) line.tax_ids = [[6, 0, singleTaxIds]];
    else line.tax_ids = [[5, 0, 0]]; // Explicitly clear taxes to prevent Odoo from applying account defaults
    invoiceLines.push([0, 0, line]);
  }

  const vals = {
    move_type: "in_invoice",
    partner_id: Number(vendorId),
    company_id: Number(companyId),
    invoice_line_ids: invoiceLines
  };

  if (purchaseJournalId) vals.journal_id = Number(purchaseJournalId);
  if (currencyId) vals.currency_id = Number(currencyId);
  if (ref) vals.ref = ref;
  if (invoiceDate) vals.invoice_date = invoiceDate;
  return { vals, profFeesEwtApplied };
}

const documentFieldSupportCache = new Map();

async function documentsDocumentHasField(odoo, fieldName) {
  if (documentFieldSupportCache.has(fieldName)) return documentFieldSupportCache.get(fieldName);
  try {
    const fg = await odoo.executeKw("documents.document", "fields_get", [[fieldName], ["type"]], {});
    const has = !!fg?.[fieldName];
    documentFieldSupportCache.set(fieldName, has);
    return has;
  } catch (_err) {
    documentFieldSupportCache.set(fieldName, false);
    return false;
  }
}

/**
 * Remove duplicate documents/attachments that Odoo auto-creates when a bill is created.
 * In Odoo 19, the Documents/Accounting bridge creates a mirror document in the purchase
 * journal's folder.  We keep only the original uploaded document (originalDocId) and its
 * attachment (originalAttId), and delete any auto-generated duplicates linked to the bill.
 */
async function removeDuplicateBillDocuments(odoo, companyId, billId, originalDocId, originalAttId, logger) {
  try {
    // 1. Find documents.document records auto-linked to this bill (res_model=account.move)
    //    that are NOT our original document.
    const autoDocsFields = ["id", "name", "attachment_id"];
    let autoDocs = [];
    try {
      autoDocs = await odoo.searchRead(
        "documents.document",
        [
          ["res_model", "=", "account.move"],
          ["res_id", "=", Number(billId)],
          ["id", "!=", Number(originalDocId)]
        ],
        autoDocsFields,
        kwWithCompany(companyId, { limit: 20 })
      );
    } catch (_) {
      // res_model field may not exist on older versions; safe to skip
    }

    for (const autoDoc of autoDocs) {
      const autoAttId = autoDoc.attachment_id
        ? (Array.isArray(autoDoc.attachment_id) ? Number(autoDoc.attachment_id[0]) : Number(autoDoc.attachment_id))
        : 0;
      try {
        await odoo.executeKw("documents.document", "unlink", [[Number(autoDoc.id)]], kwWithCompany(companyId));
        if (logger) logger.info("Removed auto-created duplicate document.", {
          billId, removedDocId: autoDoc.id, removedDocName: autoDoc.name, originalDocId
        });
      } catch (unlinkErr) {
        if (logger) logger.warn("Failed to remove auto-created duplicate document.", {
          billId, docId: autoDoc.id, error: unlinkErr?.message
        });
      }
      // Also remove the auto-created attachment if it's different from the original
      if (autoAttId && autoAttId !== Number(originalAttId)) {
        try {
          await odoo.executeKw("ir.attachment", "unlink", [[autoAttId]], kwWithCompany(companyId));
        } catch (_) {}
      }
    }

    // 2. Find ir.attachment records directly linked to the bill that are not our original.
    const autoAtts = await odoo.searchRead(
      "ir.attachment",
      [
        ["res_model", "=", "account.move"],
        ["res_id", "=", Number(billId)],
        ["id", "!=", Number(originalAttId)]
      ],
      ["id", "name", "description"],
      kwWithCompany(companyId, { limit: 20 })
    );
    for (const dupAtt of autoAtts) {
      // Only remove attachments that look auto-generated (no processed marker, not from chatter)
      const desc = String(dupAtt.description || "");
      if (desc.includes("BILL_OCR_PROCESSED") || desc.includes("Source: documents.document")) continue;
      try {
        await odoo.executeKw("ir.attachment", "unlink", [[Number(dupAtt.id)]], kwWithCompany(companyId));
        if (logger) logger.info("Removed auto-created duplicate attachment.", {
          billId, removedAttId: dupAtt.id, removedAttName: dupAtt.name, originalAttId
        });
      } catch (_) {}
    }
  } catch (err) {
    if (logger) logger.warn("removeDuplicateBillDocuments failed (non-fatal).", {
      billId, originalDocId, error: err?.message || String(err)
    });
  }
}

async function attachFileToBillChatter(odoo, companyId, att, billId, docId) {
  if (!att?.datas) return;
  try {
    const chatAttId = await odoo.create("ir.attachment", {
      name: att.name,
      mimetype: att.mimetype,
      datas: att.datas,
      res_model: "mail.compose.message",
      res_id: 0,
      description: `Source: documents.document#${docId} attachment#${att.id}`
    });
    await odoo.executeKw(
      "account.move",
      "message_post",
      [[Number(billId)]],
      kwWithCompany(companyId, {
        body: `📄 Original document file attached (doc #${docId})`,
        message_type: "comment",
        attachment_ids: [Number(chatAttId)]
      })
    );
  } catch (_err) {
    // best effort
  }
}

function readFolderId(docRow) {
  const raw = docRow?.folder_id;
  return raw ? (Array.isArray(raw) ? Number(raw[0]) : Number(raw)) : 0;
}

/** Return true if the folder (documents.document or documents.folder) is archived. Tries both models. */
async function isFolderArchived(odoo, companyId, folderId) {
  if (!folderId) return false;
  for (const model of ["documents.document", "documents.folder"]) {
    try {
      // active_test: false is required to find archived records in searchRead
      const rows = await odoo.searchRead(
        model,
        [["id", "=", Number(folderId)]],
        ["active"],
        kwWithCompany(companyId, { limit: 1, context: { active_test: false } })
      );
      if (rows?.[0]) {
        const active = rows[0].active;
        return active === false || active === 0;
      }
    } catch (_) {}
  }
  return false;
}

async function ensureAccountingFolderActive(odoo, companyId, journalId, logger, additionalFolderId = 0) {
  const folderIds = new Set();
  if (additionalFolderId) folderIds.add(Number(additionalFolderId));

  for (const field of ["documents_account_folder_id", "account_folder_id"]) {
    try {
      const rows = await odoo.searchRead(
        "res.company", [["id", "=", companyId]], ["id", field], { limit: 1 }
      );
      const fid = m2oId(rows?.[0]?.[field]);
      if (fid) folderIds.add(fid);
    } catch (_) {}
  }

  if (journalId) {
    for (const field of ["documents_folder_id"]) {
      try {
        const rows = await odoo.searchRead(
          "account.journal", [["id", "=", Number(journalId)]], ["id", field], { limit: 1 }
        );
        const fid = m2oId(rows?.[0]?.[field]);
        if (fid) folderIds.add(fid);
      } catch (_) {}
    }
  }

  if (!folderIds.size) {
    const acctNames = /^(finance|accounting|vendor.bill|bills|factur)/i;
    for (const model of ["documents.document", "documents.folder"]) {
      try {
        let domain = [["active", "=", false]];
        if (model === "documents.document") {
          const hasType = await documentsDocumentHasField(odoo, "type");
          if (hasType) domain.push(["type", "=", "folder"]);
          else domain.push(["is_folder", "=", true]);
        }
        const rows = await odoo.searchRead(
          model,
          domain,
          ["id", "name"],
          kwWithCompany(companyId, { limit: 50 })
        );
        for (const r of rows || []) {
          if (acctNames.test(String(r.name || ""))) folderIds.add(Number(r.id));
        }
      } catch (_) {}
    }
  }

  for (const fid of folderIds) {
    for (const model of ["documents.document", "documents.folder"]) {
      try {
        // active_test: false is required to find archived records
        const rows = await odoo.searchRead(model, [["id", "=", fid]], ["id", "active"], { limit: 1, context: { active_test: false } });
        if (rows?.[0] && (rows[0].active === false || rows[0].active === 0)) {
          await odoo.write(model, [fid], { active: true });
          if (logger) logger.info("Unarchived accounting documents folder.", { model, folderId: fid });
        }
      } catch (_) {}
    }
  }
}

async function linkDocumentToBill(odoo, companyId, docId, billId, logger, activeApFolderId = 0, useIsFolder = false, journalId = 0) {
  const docRows = await odoo.searchRead(
    "documents.document",
    [["id", "=", Number(docId)]],
    ["id", "folder_id"],
    kwWithCompany(companyId, { limit: 1, context: { active_test: false } })
  );
  let originalFolderId = readFolderId(docRows?.[0]);

  const folderArchived = originalFolderId ? await isFolderArchived(odoo, companyId, originalFolderId) : false;
  if (folderArchived && activeApFolderId) {
    if (logger) logger.info("Document is in archived folder; moving to active AP folder before link.", {
      docId, archivedFolderId: originalFolderId, activeApFolderId
    });
    await odoo.write("documents.document", [Number(docId)], { folder_id: activeApFolderId });
    originalFolderId = activeApFolderId;
  }

  // Ensure accounting folders are active AFTER moving the document to the active AP folder (if it was archived).
  await ensureAccountingFolderActive(odoo, companyId, journalId, logger, originalFolderId);

  // Step 1: Write res_model/res_id fields WITHOUT folder_id.
  // Odoo's documents_account module has a _compute_folder_id stored computed field that fires
  // when res_model/res_id change — it moves the document to the journal's folder (Purchase).
  // Including folder_id here is futile because the compute overrides it within the same transaction.
  const linkVals = {};
  if (await documentsDocumentHasField(odoo, "res_model")) linkVals.res_model = "account.move";
  if (await documentsDocumentHasField(odoo, "res_id")) linkVals.res_id = Number(billId);
  if (await documentsDocumentHasField(odoo, "account_move_id")) linkVals.account_move_id = Number(billId);
  if (await documentsDocumentHasField(odoo, "invoice_id")) linkVals.invoice_id = Number(billId);

  if (Object.keys(linkVals).length) {
    await odoo.write("documents.document", [Number(docId)], linkVals);
  }

  // Step 2: Restore folder_id in a SEPARATE write call.
  // Since res_model/res_id are not changing in this write, _compute_folder_id will NOT re-fire,
  // so this assignment sticks.
  if (originalFolderId) {
    await sleep(300); // small buffer for any async Odoo processing
    await odoo.write("documents.document", [Number(docId)], { folder_id: originalFolderId });
    if (logger) logger.info("Set document folder after link.", { docId, originalFolderId });

    // Safety check: verify it stuck, and retry once if it didn't.
    await sleep(2000);
    try {
      const rows = await odoo.searchRead(
        "documents.document",
        [["id", "=", Number(docId)]],
        ["id", "folder_id"],
        kwWithCompany(companyId, { limit: 1 })
      );
      const currentFolderId = readFolderId(rows?.[0]);
      if (currentFolderId !== originalFolderId) {
        await odoo.write("documents.document", [Number(docId)], { folder_id: originalFolderId });
        if (logger) logger.info("Re-restored document folder after safety check.", {
          docId, originalFolderId, foundFolderId: currentFolderId
        });
      }
    } catch (_) {}
  }

  const baseUrl = odoo.baseUrl || "";
  const docLink = `${baseUrl}/odoo/documents/${docId}`;
  await safeMessagePost(
    odoo,
    companyId,
    "account.move",
    Number(billId),
    `📎 Source document: <a href="${docLink}">Document #${docId}</a> (Documents app)`
  );
}

async function processOneDocument(args) {
  const {
    logger,
    odoo,
    companyId,
    targetKey,
    doc,
    resolvedVatIds,
    purchaseJournalId,
    industry,
    reprocess = false,
    force = false,
    apFolderId: argApFolderId = 0,
    useIsFolder: argUseIsFolder = false,
    userHint = "",
    entityFlags = {}
  } = args;
  const attachmentId = m2oId(doc.attachment_id);
  if (!attachmentId) return { status: "skip", reason: "no_attachment" };

  const linkedModel = String(doc.res_model || "").trim();
  const linkedId = Number(doc.res_id || 0);
  if (linkedModel === "account.move" && linkedId) {
    const billRows = await odoo.searchRead(
      "account.move",
      [["id", "=", linkedId]],
      ["id", "state"],
      kwWithCompany(companyId, { limit: 1 })
    );
    if (billRows?.length) {
      const billState = String(billRows[0].state || "");
      if (!reprocess) {
        return { status: "skip", reason: "already_linked", billId: linkedId, billState };
      }
      if (billState === "draft") {
        logger.info("Deleting old draft bill for retry.", { docId: doc.id, billId: linkedId });
        try {
          await odoo.executeKw("account.move", "unlink", [[linkedId]], kwWithCompany(companyId));
          const clearVals = { res_model: false, res_id: false };
          if (await documentsDocumentHasField(odoo, "account_move_id")) clearVals.account_move_id = false;
          if (await documentsDocumentHasField(odoo, "invoice_id")) clearVals.invoice_id = false;
          await odoo.write("documents.document", [Number(doc.id)], clearVals);
          doc.res_model = false;
          doc.res_id = false;
        } catch (e) {
          logger.warn("Failed to delete old draft bill on retry.", { error: e.message });
        }
      } else if (!force) {
        logger.info("Bill is not draft; refusing to retry without force.", { docId: doc.id, billId: linkedId });
        await safeMessagePost(odoo, companyId, "documents.document", doc.id,
          "⚠️ <b>🤖 Bot:</b> Cannot retry because the linked bill is already posted/cancelled. Use <b>@bot force</b> to create a duplicate draft anyway.");
        return { status: "skip", reason: "posted_no_force", billId: linkedId, billState };
      }
      // force=true with a posted bill: fall through and create a new draft
    } else {
      // Bill link exists but bill was deleted — clear the stale link
      logger.info("Clearing stale bill link from document (bill was deleted).", { docId: doc.id, staleBillId: linkedId });
      const clearVals = { res_model: false, res_id: false };
      if (await documentsDocumentHasField(odoo, "account_move_id")) clearVals.account_move_id = false;
      if (await documentsDocumentHasField(odoo, "invoice_id")) clearVals.invoice_id = false;
      await odoo.write("documents.document", [Number(doc.id)], clearVals);
    }
  }

  const att = await loadAttachment(odoo, companyId, attachmentId);
  if (!att) return { status: "skip", reason: "attachment_not_found" };

  if (reprocess && isProcessed(att.description, config.scan.processedMarkerPrefix, targetKey, doc.id)) {
    const billId = getProcessedBillId(att.description, config.scan.processedMarkerPrefix, targetKey, doc.id);
    const marker = makeProcessedMarker(config.scan.processedMarkerPrefix, targetKey, doc.id, billId || 0, doc.name);
    const cleaned = String(att.description || "").replace(marker, "").replace(/\n{2,}/g, "\n").trim();
    await odoo.write("ir.attachment", [att.id], { description: cleaned });
    att.description = cleaned;
    logger.info("Reprocess requested: cleared processed marker.", { docId: doc.id });
  }
  if (!reprocess && isProcessed(att.description, config.scan.processedMarkerPrefix, targetKey, doc.id)) {
    const billId = getProcessedBillId(att.description, config.scan.processedMarkerPrefix, targetKey, doc.id);
    if (billId) {
      const billExists = await odoo.searchRead(
        "account.move",
        [["id", "=", billId]],
        ["id"],
        kwWithCompany(companyId, { limit: 1 })
      );
      if (billExists?.length) {
        return { status: "skip", reason: "already_processed", billId };
      }
      logger.info("Linked bill was deleted, clearing marker for reprocessing.", { docId: doc.id, billId });
      const marker = makeProcessedMarker(config.scan.processedMarkerPrefix, targetKey, doc.id, billId, doc.name);
      const cleaned = String(att.description || "").replace(marker, "").replace(/\n{2,}/g, "\n").trim();
      await odoo.write("ir.attachment", [att.id], { description: cleaned });
      att.description = cleaned;
    }
  }

  let ocrText = "";
  const existingJob = parseOcrJobMarker(
    att.description,
    config.scan.ocrJobMarkerPrefix,
    targetKey,
    doc.id,
    att.id
  );

  if (existingJob) {
    logger.info("Found prior OCR job marker; rerunning OCR inline for continuity.", {
      docId: doc.id,
      attId: att.id,
      opName: existingJob.opName
    });
  } else {
    const jobMarker = makeOcrJobMarker(
      config.scan.ocrJobMarkerPrefix,
      targetKey,
      doc.id,
      att.id,
      `inline-${Date.now()}`,
      "inline"
    );
    await odoo.write("ir.attachment", [att.id], {
      description: appendMarker(att.description, jobMarker)
    });
  }

  ocrText = await ocrTextForAttachment(att, config, logger);
  if (!ocrText || ocrText.trim().length < config.scan.ocrMinTextLen) {
    return { status: "skip", reason: "ocr_too_short" };
  }

  const extracted = await extractInvoiceWithGemini(ocrText, config, att, userHint);
  fixExtractedAmounts(extracted, ocrText, logger);
  let vendor = await findVendor(odoo, companyId, extracted, ocrText);
  if (!vendor.id) {
    const createdVendor = await createVendorIfMissing(odoo, companyId, extracted, ocrText);
    if (createdVendor.partnerId) {
      vendor = {
        id: Number(createdVendor.partnerId),
        name: String(createdVendor.name || extracted?.vendor?.name || ""),
        confidence: Number(extracted?.vendor?.confidence || 0),
        source: extracted?.vendor?.source || "unknown",
        created: !!createdVendor.created
      };
      await safeMessagePost(
        odoo,
        companyId,
        "documents.document",
        doc.id,
        `✅ Vendor auto-${createdVendor.created ? "created" : "matched"}: ${vendor.name} (#${vendor.id}).`
      );
    } else {
      await safeMessagePost(
        odoo,
        companyId,
        "documents.document",
        doc.id,
        `⚠️ Manual review required: vendor not confidently matched.\n` +
          `Extracted vendor=${extracted?.vendor?.name || "(blank)"} conf=${Number(extracted?.vendor?.confidence || 0)} source=${extracted?.vendor?.source || "unknown"}\n` +
          `TIN=${extracted?.vendor_details?.tin || "(none)"} Address=${typeof extracted?.vendor_details?.address === 'object' ? JSON.stringify(extracted?.vendor_details?.address) : extracted?.vendor_details?.address || "(none)"}`
      );
      return { status: "skip", reason: "vendor_not_found", manual_review: true };
    }
  }

  if (!reprocess) {
    const duplicate = await findDuplicateBill(odoo, companyId, vendor.id, extracted, doc.id);
    if (duplicate?.id) {
      const marker = makeProcessedMarker(
        config.scan.processedMarkerPrefix,
        targetKey,
        doc.id,
        duplicate.id,
        doc.name
      );
      await odoo.write("ir.attachment", [att.id], {
        description: appendMarker(att.description, marker)
      });
      return { status: "skip", reason: "duplicate", billId: duplicate.id };
    }
  }

  const currencyCode = String(extracted?.invoice?.currency || "").trim();
  const currencyId = await resolveCurrencyId(odoo, companyId, currencyCode);
  const taxMap = resolvedVatIds;
  let vendorCountry = "";
  if (typeof extracted?.vendor_details?.address === "object" && extracted?.vendor_details?.address !== null) {
    vendorCountry = [
      extracted.vendor_details.address.country,
      extracted.vendor_details.address.state,
      extracted.vendor_details.address.city
    ].filter(Boolean).join(" ");
  } else {
    vendorCountry = String(extracted?.vendor_details?.address || "").trim();
  }
  const billLevelTaxIds = pickBillLevelTaxIds(taxMap, extracted, vendorCountry);
  const taxMeta = billLevelTaxIds.length ? await getTaxMeta(odoo, companyId, billLevelTaxIds) : taxMap._meta;

  // --- Vendor research (Google Search grounding) ---
  let vendorResearch = null;
  try {
    const vName = String(extracted?.vendor?.name || vendor.name || "").trim();
    const tName = String(extracted?.vendor_details?.trade_name || "").trim();
    vendorResearch = await researchVendorWithGemini(vName, tName, config);
    if (vendorResearch) {
      logger.info("Vendor research (Google Search).", { docId: doc.id, vendor: vName, research: vendorResearch });
    }
  } catch (err) {
    logger.warn("Vendor research failed.", { docId: doc.id, error: err?.message || String(err) });
  }

  // --- Account resolution ---
  const expenseAccounts = await loadExpenseAccounts(odoo, companyId);
  const acctLoadLog = expenseAccounts._loadLog || [];
  logger.info("Expense accounts loaded.", {
    docId: doc.id, count: expenseAccounts.length,
    sample: expenseAccounts.slice(0, 5).map((a) => `${a.code} ${a.name}`),
    hasNonGeneric: expenseAccounts.some((a) => !isGenericAccount(a)),
    loadLog: acctLoadLog
  });
  const accountMapping = await getAccountMapping();
  let geminiAssignments = null;
  try {
    geminiAssignments = await assignAccountsWithGemini(extracted, expenseAccounts, config, targetKey, industry, ocrText, vendorResearch);
    if (geminiAssignments) {
      logger.info("Gemini Pass 2 account assignments.", {
        docId: doc.id,
        billLevel: {
          accountId: geminiAssignments.bill_level_account_id,
          code: geminiAssignments.bill_level_account_code,
          name: geminiAssignments.bill_level_account_name,
          conf: geminiAssignments.bill_level_confidence
        },
        assignments: (geminiAssignments.assignments || []).map((a) => ({
          line: a.line_index,
          accountId: a.account_id,
          code: a.account_code,
          name: a.account_name,
          conf: a.confidence,
          reason: (a.reasoning || "").slice(0, 80),
          alts: (a.alternatives || []).map((alt) => ({
            id: alt.account_id, code: alt.account_code, name: alt.account_name, conf: alt.confidence
          }))
        }))
      });
    } else {
      logger.warn("Gemini Pass 2 returned null.", { docId: doc.id });
    }
  } catch (err) {
    logger.warn("Gemini Pass 2 failed.", { docId: doc.id, error: err?.message || String(err) });
  }

  const lineItems = extracted?.line_items || [];
  const hint = extracted?.expense_account_hint || {};
  const grandTotal = Number(extracted?.totals?.grand_total || 0);
  const netTotal = Number(extracted?.totals?.net_total || 0);
  const useLines = lineItems.length > 0 && lineItemsTotalMatchesInvoice(lineItems, grandTotal, netTotal);

  const lineCount = useLines ? lineItems.length : 1;
  const lineAccountIds = [];
  const lineAccountSources = [];
  const lineAccountMeta = [];
  for (let i = 0; i < lineCount; i++) {
    const item = useLines ? lineItems[i] : null;
    const category = item?.expense_category || hint.category || "other";
    const lineDesc = item ? String(item.description || "").trim() : "";
    const suggestedName = hint.suggested_account_name || lineDesc || "";
    const geminiLinePick = geminiAssignments?.assignments?.find((a) => a.line_index === i);
    const geminiPick = geminiLinePick || (i === 0 && geminiAssignments ? {
      account_id: geminiAssignments.bill_level_account_id,
      account_code: geminiAssignments.bill_level_account_code || "",
      account_name: geminiAssignments.bill_level_account_name || "",
      confidence: geminiAssignments.bill_level_confidence || 0,
      reasoning: "bill-level fallback",
      alternatives: []
    } : null);

    const vendorNameForHint = String(extracted?.vendor_details?.trade_name || extracted?.vendor?.name || vendor.name || "").trim();
    const resolved = await resolveExpenseAccountId({
      odoo, companyId, vendorId: vendor.id,
      category, suggestedName, geminiPick,
      expenseAccounts, accountMapping, targetDb: odoo.db,
      lineDescription: lineDesc, vendorName: vendorNameForHint || vendor.name,
      targetKey
    });
    lineAccountIds.push(resolved.accountId);
    lineAccountSources.push(resolved.source);
    lineAccountMeta.push({ code: resolved.accountCode || "", name: resolved.accountName || "" });
    logger.info("Account resolved.", {
      docId: doc.id, line: i, category, lineDesc: lineDesc.slice(0, 40),
      accountId: resolved.accountId, source: resolved.source
    });
  }

  const { vals: billVals, profFeesEwtApplied } = buildBillVals(
    extracted,
    vendor.id,
    companyId,
    taxMap,
    billLevelTaxIds,
    purchaseJournalId,
    currencyId,
    taxMeta,
    lineAccountIds,
    vendorCountry,
    entityFlags,
    lineAccountMeta
  );
  
  // Move document to active AP folder if currently archived
  let docFolderId = readFolderId(doc);
  if (docFolderId) {
    const isArchived = await isFolderArchived(odoo, companyId, docFolderId);
    if (isArchived && argApFolderId) {
      if (logger) logger.info("Document is in archived folder; moving to active AP folder before creation.", {
        docId: doc.id, archivedFolderId: docFolderId, activeApFolderId: argApFolderId
      });
      await odoo.write("documents.document", [Number(doc.id)], { folder_id: argApFolderId });
      docFolderId = argApFolderId;
    }
  }

  // Ensure accounting folders are active BEFORE creating the bill, because Odoo's internal
  // account.move creation hooks may try to create a documents.document in the journal's folder.
  await ensureAccountingFolderActive(odoo, companyId, purchaseJournalId, logger, docFolderId);

  // Pass no_document context to prevent Odoo's Documents module from auto-creating
  // a duplicate document in the purchase journal's accounting folder (Odoo 19).
  const billCreateCtx = kwWithCompany(companyId, {
    context: { no_document: true }
  });
  const billId = await odoo.create("account.move", billVals, billCreateCtx);

  // Clean up any auto-created duplicate documents/attachments linked to this bill
  // that Odoo may have generated despite the no_document flag.
  await removeDuplicateBillDocuments(odoo, companyId, billId, doc.id, att.id, logger);

  await persistDocBillMapping(config, doc.id, billId, targetKey);
  const marker = makeProcessedMarker(
    config.scan.processedMarkerPrefix,
    targetKey,
    doc.id,
    Number(billId),
    doc.name
  );
  await odoo.write("ir.attachment", [att.id], {
    description: appendMarker(att.description, marker)
  });
  // Skip attachFileToBillChatter — the original document is linked to the bill via
  // linkDocumentToBill below. Creating a chatter attachment duplicates the file.
  try {
    await linkDocumentToBill(odoo, companyId, Number(doc.id), Number(billId), logger, argApFolderId, argUseIsFolder, purchaseJournalId);
  } catch (linkErr) {
    logger.warn("linkDocumentToBill failed; extraction chatter will still be posted.", {
      docId: doc.id, billId, error: linkErr?.message || String(linkErr)
    });
  }

  const oldDocName = String(doc.name || "document");
  const prefix = "[Bill Created] ";
  const newDocName = oldDocName.startsWith(prefix) ? oldDocName : `${prefix}${oldDocName}`;
  if (newDocName !== oldDocName) {
    try {
      await odoo.write("documents.document", [Number(doc.id)], { name: newDocName });
    } catch (renameErr) {
      logger.warn("Failed to rename document.", { docId: doc.id, error: renameErr?.message });
    }
  }

  await safeMessagePost(
    odoo,
    companyId,
    "documents.document",
    doc.id,
    `✅ <b>🤖 AP Bot:</b> Draft Vendor Bill created: account.move #${billId}<br/>Vendor=${vendor.name || "(unknown)"}`
  );

  {
    const vd = extracted?.vendor_details || {};
    const et = String(vd.entity_type || vendor.entityType || "unknown").toLowerCase();
    const entityLabel = et === "sole_proprietor" ? "Sole Proprietor"
      : et === "corporation" ? "Corporation"
      : et === "individual" ? "Individual"
      : et === "general_professional_partnership" ? "General Professional Partnership"
      : et === "non_profit_organization" ? "Non-Profit Organization"
      : et === "cooperative" ? "Cooperative"
      : et === "government_entity" ? "Government Entity"
      : "Unknown";
    const tn = String(vd.trade_name || vendor.tradeName || "").trim();
    const pn = String(vd.proprietor_name || vendor.proprietorName || "").trim();
    const vendorMsg = [
      `<b>🔍 Vendor extraction</b>`,
      `Name: ${vendor.name || "(unknown)"} | Confidence: ${Number(extracted?.vendor?.confidence || 0).toFixed(2)}`,
      `Entity type: <b>${entityLabel}</b>`,
      tn && tn.toLowerCase() !== (vendor.name || "").toLowerCase() ? `Trade name: ${tn}` : null,
      pn ? `Proprietor/Owner: ${pn}` : null,
      vd.tin ? `TIN: ${vd.tin}` : null,
      vd.address ? `Address: ${typeof vd.address === 'object' ? Object.values(vd.address).filter(Boolean).join(", ") : vd.address}` : null,
      vendor.created ? `<i>Vendor auto-created in Odoo (as ${et === "sole_proprietor" || et === "individual" ? "Individual" : "Company"})</i>` : null
    ].filter(Boolean).join("<br/>");
    await safeMessagePost(odoo, companyId, "account.move", Number(billId), vendorMsg);
  }

  {
    const lines = [];
    for (let i = 0; i < lineAccountIds.length; i++) {
      const acctId = lineAccountIds[i];
      const acct = acctId ? expenseAccounts.find((a) => a.id === acctId) : null;
      const li = useLines && lineItems[i] ? lineItems[i] : null;
      const desc = li ? String(li.description || "").slice(0, 60) : "Single line";
      const resolvedSource = lineAccountSources[i] || "";
      const srcLabel = resolvedSource ? ` <i>(${resolvedSource})</i>` : "";
      lines.push(`Line ${i + 1}: ${desc} → ${acct ? `<b>${acct.code} ${acct.name}</b>${srcLabel}` : `(account #${acctId || "default"}) <i>(${resolvedSource || "no accounts loaded"})</i>`}`);
    }
    const geminiInfo = geminiAssignments
      ? `Gemini: bill_level=${geminiAssignments.bill_level_account_code || "?"} ${geminiAssignments.bill_level_account_name || "?"}`
      : "Gemini Pass 2: null";
    const loadStatus = acctLoadLog.length ? acctLoadLog.join("; ") : "no log";
    const vendorResearchLine = vendorResearch ? `🔍 Vendor research: <i>${vendorResearch.slice(0, 300)}</i>` : "";
    const acctMsgParts = [`<b>💡 Account suggestions</b> <i>(${expenseAccounts.length} accounts loaded)</i>`, `<i>${loadStatus}</i>`];
    if (vendorResearchLine) acctMsgParts.push(vendorResearchLine);
    acctMsgParts.push(geminiInfo, ...lines);
    const acctMsg = acctMsgParts.join("<br/>");
    await safeMessagePost(odoo, companyId, "account.move", Number(billId), acctMsg);
  }

  {
    const t = extracted?.totals || {};
    const amtMsg = [
      `<b>📊 Extracted amounts</b>`,
      `Grand total: ${Number(t.grand_total || 0).toFixed(2)} | Net total: ${Number(t.net_total || 0).toFixed(2)} | Tax: ${Number(t.tax_total || 0).toFixed(2)}`,
      `VAT-inclusive prices: ${t.amounts_are_vat_inclusive ? "Yes" : "No"} | Currency: ${extracted?.invoice?.currency || "(not detected)"}`,
      extracted?.invoice?.number ? `Invoice #: ${extracted.invoice.number}` : null,
      extracted?.invoice?.date ? `Invoice date: ${extracted.invoice.date}` : null
    ].filter(Boolean).join("<br/>");
    await safeMessagePost(odoo, companyId, "account.move", Number(billId), amtMsg);
  }

  if ((extracted?.warnings || []).length || Number(extracted?.vendor?.confidence || 0) < 0.9) {
    await safeMessagePost(
      odoo,
      companyId,
      "account.move",
      Number(billId),
      `<b>⚠️ Manual review recommended.</b> Vendor confidence=${Number(extracted?.vendor?.confidence || 0).toFixed(2)}<br/>Warnings:<br/>- ${(extracted?.warnings || []).join("<br/>- ") || "(none)"}`
    );
  }

  // EWT (withholding tax) chatter notification
  {
    const ewtCountry = String(entityFlags?.country || "").trim();
    const isPHEntity = !ewtCountry || /philipp|^ph$/i.test(ewtCountry);
    if (isPHEntity) {
      const vendorExempt = isVendorEwtExempt(extracted);
      if (vendorExempt) {
        const exemptEt = String(extracted?.vendor_details?.entity_type || "").toLowerCase();
        const exemptLabel = exemptEt === "general_professional_partnership" ? "General Professional Partnership (GPP)"
          : exemptEt === "non_profit_organization" ? "Non-Profit Organization"
          : exemptEt === "cooperative" ? "Cooperative"
          : exemptEt === "government_entity" ? "Government Entity"
          : exemptEt;
        const exemptReason = exemptEt === "general_professional_partnership"
          ? "GPPs are pass-through entities exempt from income tax; payments are not subject to EWT."
          : exemptEt === "non_profit_organization"
          ? "Non-profit organizations are exempt from income tax under NIRC Sec. 30; payments are not subject to EWT."
          : exemptEt === "cooperative"
          ? "Cooperatives are exempt from income tax under the Cooperative Code; payments are not subject to EWT."
          : "Government entities are exempt from EWT.";
        await safeMessagePost(
          odoo, companyId, "account.move", Number(billId),
          `<b>🏛️ EWT exempt</b> — Vendor classified as ${exemptLabel}. ${exemptReason}`
        );
      }
      const ewtMap = taxMap.ewt || {};
      const hasAnyEwt = Object.values(ewtMap).some((v) => v > 0);
      const isTwa = !!entityFlags?.isTopWithholdingAgent;
      const wht = extracted?.withholding_tax;
      const invoiceEwtDetected = !!(wht?.detected);
      const ewtParts = [];
      if (isTwa) ewtParts.push("Entity is a Top Withholding Agent (TWA)");
      const vendorIndiv = isVendorIndividual(extracted);
      if (vendorIndiv === true) ewtParts.push("Vendor: individual/sole proprietor (WI codes)");
      else if (vendorIndiv === false && !vendorExempt) ewtParts.push("Vendor: corporation/juridical (WC codes)");
      if (invoiceEwtDetected) {
        const detailParts = [];
        if (wht.ewt_rate) detailParts.push(`rate: ${wht.ewt_rate}%`);
        if (wht.ewt_amount) detailParts.push(`amount: ${Number(wht.ewt_amount).toFixed(2)}`);
        if (wht.atc_code) detailParts.push(`ATC: ${wht.atc_code}`);
        if (wht.bir_form_reference) detailParts.push(`BIR Form: ${wht.bir_form_reference}`);
        ewtParts.push(`Invoice shows withholding tax (${detailParts.join(", ")})`);
      }
      if (!hasAnyEwt && (isTwa || invoiceEwtDetected)) {
        await safeMessagePost(
          odoo, companyId, "account.move", Number(billId),
          `<b>⚠️ Withholding tax notice:</b> No EWT tax records found in the database. ` +
          `Please create the appropriate withholding tax records (e.g., EWT 1%, 2%, 5%, 10%) ` +
          `and the system will automatically apply them on future bills.` +
          (ewtParts.length ? `<br/>${ewtParts.join("<br/>")}` : ``)
        );
      } else if (ewtParts.length && hasAnyEwt) {
        await safeMessagePost(
          odoo, companyId, "account.move", Number(billId),
          `<b>🏛️ EWT applied</b> — ${ewtParts.join(". ")}. ` +
          `Expanded withholding tax applied on bill lines per BIR RR 11-2018.`
        );
      }
      if (profFeesEwtApplied) {
        const vendorIndivForMsg = isVendorIndividual(extracted);
        const higherRate = vendorIndivForMsg === false ? 15 : 10;
        const lowerRate = vendorIndivForMsg === false ? 10 : 5;
        const profFeesNote = vendorIndivForMsg !== false
          ? `To avail the lower ${lowerRate}% rate, the vendor must submit a <b>Sworn Declaration</b> ` +
            `(Annex B-2 of BIR RR 14-2018) certifying that their gross receipts for the current year ` +
            `will not exceed ₱3,000,000. Please request this document from the vendor before processing payment.`
          : `${higherRate}% is the standard rate for corporate/juridical persons under ATC WC010 (BIR RR 2-98). ` +
            `If the vendor qualifies for the ${lowerRate}% rate, request the applicable BIR exemption certificate or ruling.`;
        await safeMessagePost(
          odoo, companyId, "account.move", Number(billId),
          `<b>📋 Professional fees EWT — ${higherRate}% applied (conservative rate).</b><br/>${profFeesNote}`
        );
      }
    }
  }

  // Entity mismatch: warn if the invoice is addressed to a different entity than the Odoo company
  {
    const billedToName = String(extracted?.billed_to?.name || "").trim();
    const billedToConf = Number(extracted?.billed_to?.confidence || 0);
    if (billedToName && billedToConf >= 0.5) {
      try {
        const companyRows = await odoo.searchRead(
          "res.company", [["id", "=", companyId]], ["id", "name"], { limit: 1 }
        );
        const companyName = String(companyRows?.[0]?.name || "").trim();
        if (companyName) {
          const normalize = (s) => s.toLowerCase()
            .replace(/\b(inc|corp|ltd|pte|llc|co\b|sa|sdn|bhd|pty|plc|ph|sg)\b\.?/gi, "")
            .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
          const normBilled = normalize(billedToName);
          const normCompany = normalize(companyName);
          const isMatch = normBilled.includes(normCompany) || normCompany.includes(normBilled)
            || normBilled.split(" ").filter(Boolean).some((w) => w.length > 3 && normCompany.includes(w));
          if (!isMatch) {
            await safeMessagePost(
              odoo, companyId, "account.move", Number(billId),
              `<b>⚠️ Entity mismatch — please verify.</b><br/>` +
              `Invoice is addressed to: <b>${billedToName}</b><br/>` +
              `Bill recorded under: <b>${companyName}</b><br/>` +
              `If this invoice belongs to a different entity, please move it to the correct company before posting.`
            );
          }
        }
      } catch (_) {}
    }
  }

  const feedbackCount = Number(geminiAssignments?._feedbackCount || 0);
  const vendorMemoryLines = lineAccountSources
    .map((s, i) => (s === "vendor_memory" ? i + 1 : null))
    .filter((n) => n != null);
  if (feedbackCount > 0 || vendorMemoryLines.length > 0) {
    const parts = [];
    if (feedbackCount > 0) parts.push(`${feedbackCount} past correction(s) used as hints for account selection`);
    if (vendorMemoryLines.length > 0) parts.push(`Vendor account memory applied on line(s) ${vendorMemoryLines.join(", ")}`);
    await safeMessagePost(
      odoo,
      companyId,
      "account.move",
      Number(billId),
      `<b>📚 Self-learning</b><br/>${parts.join("<br/>")}`
    );
  }

  {
    const snapshotLines = [];
    const grandTotalSnapshot = Number(extracted?.totals?.grand_total || 0);
    for (let i = 0; i < lineAccountIds.length; i++) {
      const acctId = lineAccountIds[i];
      const acct = acctId ? expenseAccounts.find((a) => a.id === acctId) : null;
      const li = useLines && lineItems[i] ? lineItems[i] : null;
      const desc = li ? String(li.description || "").trim() : "Vendor Bill";
      const qty = li ? Number(li.quantity) || 1 : 1;
      const priceUnit = li ? Number(li.unit_price || li.amount || 0) : grandTotalSnapshot;
      const discPct = li ? Number(li.discount_percent || 0) : 0;
      snapshotLines.push({
        account_id: acctId || 0,
        account_code: acct ? String(acct.code || "").trim() : "",
        account_name: acct ? String(acct.name || "").trim() : "",
        price_unit: priceUnit,
        quantity: qty,
        discount: discPct,
        description: desc.slice(0, 256),
        resolution_source: lineAccountSources[i] || ""
      });
    }
    const snapshot = {
      partner_id: vendor.id,
      vendor_name: String(vendor.name || "").trim(),
      lines: snapshotLines,
      grand_total: grandTotalSnapshot,
      industry: String(industry || "").trim(),
      doc_id: Number(doc.id)
    };
    const snapshotHtml = `<!--SNAPSHOT_V1:${JSON.stringify(snapshot)}-->`;
    await safeMessagePost(odoo, companyId, "account.move", Number(billId), snapshotHtml);
  }

  return { status: "ok", billId: Number(billId), vendorId: vendor.id, vendorCreated: !!vendor.created };
}

async function processTargetGroup(target, startMs, logger) {
  const odoo = new OdooClient(target.targetCfg);
  const state = await loadState(config, target.targetKey);

  const resolvedVatIds = await pickVatTaxesForCompany(odoo, target.companyId);

  let apFolderId = Number(target.apFolderId || 0);
  let useIsFolder = false;
  if (!apFolderId) {
    const parentName = String(target.apFolderParent ?? "").trim() || undefined;
    const r = await resolveApFolderId(odoo, target.companyId, { parentFolderName: parentName });
    apFolderId = r.apFolderId;
    useIsFolder = r.useIsFolder;
  }

  const docs = await listCandidateDocuments(odoo, target.companyId, apFolderId, useIsFolder);
  const lastProcessed = Number(state.last_doc_id || 0);
  const newDocs = docs
    .filter((d) => Number(d.id) > lastProcessed)
    .sort((a, b) => Number(a.id) - Number(b.id));
  const revisitDocs = docs
    .filter((d) => Number(d.id) <= lastProcessed)
    .sort((a, b) => Number(a.id) - Number(b.id));
  const docsSorted = [...newDocs, ...revisitDocs];

  const stats = {
    scanned: 0,
    created: 0,
    skipped: 0,
    errors: 0,
    lastDocId: Number(state.last_doc_id || 0)
  };

  for (const doc of docsSorted) {
    if (outOfTime(startMs)) {
      logger.warn("Stopped target processing due to runtime budget.", {
        targetKey: target.targetKey
      });
      break;
    }
    stats.scanned += 1;
    try {
      const result = await processOneDocument({
        logger,
        odoo,
        companyId: target.companyId,
        targetKey: target.targetKey,
        doc,
        resolvedVatIds,
        purchaseJournalId: target.purchaseJournalId,
        industry: target.industry,
        apFolderId,
        useIsFolder,
        entityFlags: {
          country: target.country || "",
          isTopWithholdingAgent: !!target.isTopWithholdingAgent
        }
      });
      if (result.status === "ok") stats.created += 1;
      else stats.skipped += 1;
      stats.lastDocId = Math.max(stats.lastDocId, Number(doc.id) || 0);
    } catch (err) {
      stats.errors += 1;
      logger.error("Document processing failed.", {
        targetKey: target.targetKey,
        docId: doc.id,
        error: err?.message || String(err)
      });
    }
  }

  await saveState(config, target.targetKey, {
    last_doc_id: stats.lastDocId
  });
  return stats;
}

async function runOne({ logger, payload = {} }) {
  const timeStart = new Date().toISOString();
  clearPerRunCaches();
  const targets = await getTargets(logger);
  if (!targets.length) {
    throw new Error("No enabled routing rows available.");
  }

  const targetKeyInput = String(payload.target_key || "").trim();
  const docId = Number(payload.doc_id || payload.document_id || payload.id || 0);
  const attachmentId = Number(payload.attachment_id || 0);
  const messageBody = String(payload.message_body || "").trim();
  if (!docId && !attachmentId) {
    throw new Error("run-one requires either doc_id or attachment_id.");
  }

  let userHint = "";
  let isBotCommand = false;
  let isForce = false;
  let isRetry = false;

  if (messageBody) {
    const plainText = messageBody.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    isBotCommand = /@(bot|ocr|worker|ai)\b/i.test(plainText);
    isForce = isBotCommand && /\bforce\b/i.test(plainText);
    isRetry = isBotCommand && /\bretry|run\b/i.test(plainText);
    
    if (isBotCommand) {
      userHint = plainText.replace(/@(bot|ocr|worker|ai)\s*(retry|run|force)?\s*,?\s*/gi, "").trim();
    }
  }

  const forceReprocess = isForce || isRetry || !!(payload.reprocess || payload.force_reprocess);

  let target = null;
  if (targetKeyInput) {
    target = targets.find((t) => t.targetKey === targetKeyInput) || null;
    if (!target) throw new Error(`target_key not found: ${targetKeyInput}`);
  } else if (targets.length === 1) {
    target = targets[0];
  } else {
    throw new Error("Multiple targets enabled. Pass target_key in request body.");
  }

  const odoo = new OdooClient(target.targetCfg);
  const companyId = Number(target.companyId);

  const docFields = ["id", "name", "attachment_id", "folder_id", "company_id", "create_date", "res_model", "res_id"];
  let docs = [];
  if (docId) {
    docs = await odoo.searchRead(
      "documents.document",
      [["id", "=", docId]],
      docFields,
      kwWithCompany(companyId, { limit: 1 })
    );
    if (!docs?.length) {
      try {
        docs = await odoo.searchRead(
          "documents.document",
          [["id", "=", docId], ["active", "in", [true, false]]],
          docFields,
          { limit: 1 }
        );
      } catch (_) {}
    }
  } else {
    docs = await odoo.searchRead(
      "documents.document",
      [["attachment_id", "=", attachmentId]],
      docFields,
      kwWithCompany(companyId, { limit: 1, order: "id desc" })
    );
  }

  const doc = docs?.[0] || null;
  if (!doc) {
    throw new Error(
      docId
        ? `Document not found for doc_id=${docId}. It may have been deleted from Odoo (check Odoo trash/archive). Try uploading the file again to the AP folder to get a new doc_id.`
        : `Document not found for attachment_id=${attachmentId}.`
    );
  }

  const resolvedVatIds = await pickVatTaxesForCompany(odoo, companyId);

  let apFolderId = Number(target.apFolderId || 0);
  let useIsFolder = false;
  if (!apFolderId) {
    const parentName = String(target.apFolderParent ?? "").trim() || undefined;
    const r = await resolveApFolderId(odoo, companyId, { parentFolderName: parentName });
    apFolderId = r.apFolderId;
    useIsFolder = r.useIsFolder;
  }

  // Guard: only process documents that live inside the configured AP folder (or its subfolders).
  // The batch-scan path enforces this via listCandidateDocuments; we must mirror that here.
  if (apFolderId && !isBotCommand) {
    const docFolderIdVal = readFolderId(doc);
    if (docFolderIdVal) {
      const allowedFolderIds = await resolveSubfolderIds(odoo, companyId, apFolderId, useIsFolder);
      if (!allowedFolderIds.includes(docFolderIdVal)) {
        logger.info("run-one: document is not in AP folder — skipping.", {
          docId: doc.id, docFolder: docFolderIdVal, apFolderId
        });
        return {
          ok: true,
          mode: "run-one",
          time_start: timeStart,
          time_completed: new Date().toISOString(),
          targetKey: target.targetKey,
          doc: { id: Number(doc.id), name: String(doc.name || ""), attachment_id: m2oId(doc.attachment_id) },
          result: { status: "skip", reason: "not_in_ap_folder" }
        };
      }
    }
  }

  const result = await processOneDocument({
    logger,
    odoo,
    companyId,
    targetKey: target.targetKey,
    doc,
    resolvedVatIds,
    purchaseJournalId: target.purchaseJournalId,
    industry: target.industry,
    reprocess: forceReprocess,
    force: isForce,
    apFolderId,
    useIsFolder,
    userHint,
    entityFlags: {
      country: target.country || "",
      isTopWithholdingAgent: !!target.isTopWithholdingAgent
    }
  });

  return {
    ok: true,
    mode: "run-one",
    time_start: timeStart,
    time_completed: new Date().toISOString(),
    targetKey: target.targetKey,
    doc: { id: Number(doc.id), name: String(doc.name || ""), attachment_id: m2oId(doc.attachment_id) },
    result
  };
}

async function listApDocuments({ logger, payload = {} }) {
  const targets = await getTargets(logger);
  if (!targets.length) {
    throw new Error("No enabled routing rows available.");
  }

  const targetKeyInput = String(payload.target_key || "").trim();
  let target = null;
  if (targetKeyInput) {
    target = targets.find((t) => t.targetKey === targetKeyInput) || null;
    if (!target) throw new Error(`target_key not found: ${targetKeyInput}`);
  } else if (targets.length === 1) {
    target = targets[0];
  } else {
    throw new Error("Multiple targets enabled. Pass target_key in request query or body.");
  }

  const odoo = new OdooClient(target.targetCfg);
  let apFolderId = Number(target.apFolderId || 0);
  let useIsFolder = false;
  if (!apFolderId) {
    const parentName = String(target.apFolderParent ?? "").trim() || undefined;
    const r = await resolveApFolderId(odoo, target.companyId, { parentFolderName: parentName });
    apFolderId = r.apFolderId;
    useIsFolder = r.useIsFolder;
  }

  const folderIds = await resolveSubfolderIds(odoo, target.companyId, apFolderId, useIsFolder);
  const folderCond = folderIds.length === 1
    ? [["folder_id", "=", folderIds[0]]]
    : [["folder_id", "in", folderIds]];
  const docDomain = [
    ...folderCond,
    ["attachment_id", "!=", false]
  ];
  if (useIsFolder) {
    let isNotFolderDomain = ["is_folder", "=", false];
    try {
      const hasType = await documentsDocumentHasField(odoo, "type");
      if (hasType) isNotFolderDomain = ["type", "!=", "folder"];
    } catch (_) {}
    docDomain.push(isNotFolderDomain);
  }
  const allDocs = await odoo.searchRead(
    "documents.document",
    docDomain,
    ["id", "name", "attachment_id", "create_date"],
    kwWithCompany(target.companyId, { limit: 5000, order: "id desc" })
  );
  return {
    ok: true,
    targetKey: target.targetKey,
    apFolderId,
    subfolderIds: folderIds.length > 1 ? folderIds : undefined,
    count: allDocs.length,
    documents: allDocs.map((d) => ({
      doc_id: Number(d.id),
      name: String(d.name || ""),
      attachment_id: m2oId(d.attachment_id),
      create_date: d.create_date || null
    }))
  };
}

function clearPerRunCaches() {
  expenseAccountsCache.clear();
  vendorAccountCache.clear();
  accountMappingCache = null;
}

async function runWorker({ logger }) {
  clearPerRunCaches();
  const timeStart = new Date().toISOString();
  const startMs = Date.now();
  const targets = await getTargets(logger);
  const totals = {
    targets: targets.length,
    scanned: 0,
    created: 0,
    skipped: 0,
    errors: 0
  };
  const targetStats = [];
  const parallel = Math.max(1, config.server?.runWorkerTargetsParallel ?? 1);

  if (parallel <= 1) {
    for (const target of targets) {
      if (outOfTime(startMs)) break;
      try {
        const stats = await processTargetGroup(target, startMs, logger);
        totals.scanned += stats.scanned;
        totals.created += stats.created;
        totals.skipped += stats.skipped;
        totals.errors += stats.errors;
        targetStats.push({ targetKey: target.targetKey, ...stats });
      } catch (err) {
        totals.errors += 1;
        targetStats.push({ targetKey: target.targetKey, error: err?.message || String(err) });
        logger.error("Target failed.", { targetKey: target.targetKey, error: err?.message || String(err) });
      }
    }
  } else {
    for (let i = 0; i < targets.length; i += parallel) {
      if (outOfTime(startMs)) break;
      const chunk = targets.slice(i, i + parallel);
      const results = await Promise.all(
        chunk.map(async (target) => {
          try {
            const stats = await processTargetGroup(target, startMs, logger);
            return { targetKey: target.targetKey, stats, error: null };
          } catch (err) {
            logger.error("Target failed.", { targetKey: target.targetKey, error: err?.message || String(err) });
            return { targetKey: target.targetKey, stats: null, error: err?.message || String(err) };
          }
        })
      );
      for (const { targetKey, stats, error } of results) {
        if (error) {
          totals.errors += 1;
          targetStats.push({ targetKey, error });
        } else {
          totals.scanned += stats.scanned;
          totals.created += stats.created;
          totals.skipped += stats.skipped;
          totals.errors += stats.errors;
          targetStats.push({ targetKey, ...stats });
        }
      }
    }
  }

  return {
    ok: true,
    time_start: timeStart,
    time_completed: new Date().toISOString(),
    elapsedMs: Date.now() - startMs,
    totals,
    targets: targetStats
  };
}

async function getRoutingSummary(logger) {
  const targets = await getTargets(logger);
  return {
    routingRowCount: targets.length,
    targetsCount: targets.length,
    targets: targets.map((t) => ({
      targetKey: t.targetKey,
      baseUrl: t.targetCfg.baseUrl,
      db: t.targetCfg.db,
      companyId: t.companyId,
      sourceProjectId: t.sourceProjectId
    }))
  };
}

const SNAPSHOT_V1_RE = /<!--SNAPSHOT_V1:(.+?)-->/s;

async function collectFeedback(logger) {
  const targets = await getTargets(logger);
  const lookbackDays = Math.max(1, config.feedback.lookbackDays || 14);
  const lookbackDate = new Date();
  lookbackDate.setDate(lookbackDate.getDate() - lookbackDays);
  const lookbackIso = lookbackDate.toISOString().slice(0, 10);
  const allRows = [];

  for (const target of targets) {
    const odoo = new OdooClient(target.targetCfg);
    const companyId = Number(target.companyId);
    const industry = String(target.industry || "").trim();
    try {
      const moves = await odoo.searchRead(
        "account.move",
        [
          ["move_type", "=", "in_invoice"],
          ["company_id", "=", companyId],
          ["create_date", ">=", lookbackIso]
        ],
        ["id"],
        { order: "id desc", limit: 500 }
      );
      if (!moves?.length) continue;
      const moveIds = moves.map((m) => m.id);

      const messages = await odoo.searchRead(
        "mail.message",
        [
          ["model", "=", "account.move"],
          ["res_id", "in", moveIds]
        ],
        ["res_id", "body"],
        { limit: 5000 }
      );
      const snapshotByMove = new Map();
      for (const msg of messages || []) {
        const body = msg.body || "";
        const match = body.match(SNAPSHOT_V1_RE);
        if (!match) continue;
        try {
          const snapshot = JSON.parse(match[1]);
          const billId = Number(msg.res_id);
          if (!snapshotByMove.has(billId)) snapshotByMove.set(billId, snapshot);
        } catch (_) {}
      }

      const billIdsWithSnapshot = [...snapshotByMove.keys()];
      if (!billIdsWithSnapshot.length) continue;

      const lines = await odoo.searchRead(
        "account.move.line",
        [["move_id", "in", billIdsWithSnapshot]],
        ["move_id", "account_id", "name", "quantity", "price_unit"],
        { order: "move_id, id" }
      );
      const accountIds = [...new Set((lines || []).map((l) => (Array.isArray(l.account_id) ? l.account_id[0] : l.account_id)).filter(Boolean))];
      let accounts = [];
      if (accountIds.length) {
        accounts = await odoo.searchRead(
          "account.account",
          [["id", "in", accountIds]],
          ["id", "code", "name"],
          { limit: accountIds.length }
        );
      }
      const accountById = new Map((accounts || []).map((a) => [a.id, a]));

      const linesByMove = new Map();
      for (const line of lines || []) {
        const mid = Array.isArray(line.move_id) ? Number(line.move_id[0]) : Number(line.move_id);
        if (!linesByMove.has(mid)) linesByMove.set(mid, []);
        const acctId = Array.isArray(line.account_id) ? line.account_id[0] : line.account_id;
        const acct = accountById.get(acctId);
        linesByMove.get(mid).push({
          account_id: acctId,
          account_code: acct ? String(acct.code || "").trim() : "",
          account_name: acct ? String(acct.name || "").trim() : "",
          name: String(line.name || "").trim(),
          quantity: Number(line.quantity) || 1,
          price_unit: Number(line.price_unit) || 0
        });
      }

      for (const billId of billIdsWithSnapshot) {
        const snapshot = snapshotByMove.get(billId);
        const currentLines = linesByMove.get(billId) || [];
        const snapLines = snapshot.lines || [];
        for (let i = 0; i < Math.max(snapLines.length, currentLines.length); i++) {
          const snap = snapLines[i];
          const curr = currentLines[i];
          if (!snap || !curr) continue;
          const origCode = String(snap.account_code || "").trim();
          const origName = String(snap.account_name || "").trim();
          const corrCode = String(curr.account_code || "").trim();
          const corrName = String(curr.account_name || "").trim();
          if (origCode === corrCode && origName === corrName) continue;
          allRows.push({
            timestamp: new Date().toISOString(),
            doc_id: snapshot.doc_id,
            bill_id: billId,
            target_key: target.targetKey,
            company_id: companyId,
            industry,
            vendor_name: String(snapshot.vendor_name || "").trim(),
            item_description: String(snap.description || curr.name || "").trim().slice(0, 256),
            original_account_code: origCode,
            original_account_name: origName,
            corrected_account_code: corrCode,
            corrected_account_name: corrName,
            correction_type: "account_change"
          });
        }
      }
    } catch (err) {
      logger.warn("collectFeedback: target failed.", { targetKey: target.targetKey, error: err?.message || String(err) });
    }
  }

  if (allRows.length) {
    await appendFeedbackCorrections(allRows);
    logger.info("collectFeedback: appended corrections to GCS.", { count: allRows.length });
  }
  await updateVendorMemoryFromFeedback(logger);
  return { ok: true, correctionsAppended: allRows.length, lookbackDays };
}

async function handleDocumentDelete(logger, payload = {}) {
  const docId = Number(payload.doc_id || payload.document_id || payload.id || 0);
  if (!docId) {
    return { ok: false, error: "missing_doc_id" };
  }
  const entry = await getDocBillEntry(config, docId);
  if (!entry || !entry.bill_id) {
    return { ok: true, billDeleted: false, message: "no_draft_bill_mapping" };
  }
  const targets = await getTargets(logger);
  const target = targets.find((t) => t.targetKey === String(entry.target_key || "").trim());
  if (!target) {
    return { ok: false, error: "target_not_found", target_key: entry.target_key };
  }
  const odoo = new OdooClient(target.targetCfg);
  const companyId = Number(target.companyId);
  const moves = await odoo.searchRead(
    "account.move",
    [["id", "=", entry.bill_id]],
    ["id", "state"],
    kwWithCompany(companyId, { limit: 1 })
  );
  const move = moves?.[0];
  if (!move) {
    await removeDocBillEntry(config, docId);
    return { ok: true, billDeleted: false, message: "bill_already_deleted" };
  }
  if (String(move.state || "").toLowerCase() !== "draft") {
    return { ok: false, error: "bill_not_draft", message: "Document is linked to a posted bill; delete or unlink in Odoo first." };
  }
  try {
    const clearVals = { res_model: false, res_id: false };
    if (await documentsDocumentHasField(odoo, "account_move_id")) clearVals.account_move_id = false;
    if (await documentsDocumentHasField(odoo, "invoice_id")) clearVals.invoice_id = false;
    await odoo.write("documents.document", [Number(docId)], clearVals);
  } catch (_) {
    // Document may already be gone; safe to ignore
  }
  await odoo.executeKw("account.move", "unlink", [[entry.bill_id]], {});
  await removeDocBillEntry(config, docId);
  logger.info("handleDocumentDelete: draft bill unlinked.", { doc_id: docId, bill_id: entry.bill_id });
  return { ok: true, billDeleted: true, bill_id: entry.bill_id };
}

module.exports = {
  runWorker,
  runOne,
  listApDocuments,
  getRoutingSummary,
  collectFeedback,
  handleDocumentDelete
};
