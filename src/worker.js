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
    "vat_purchase_tax_id_goods",
    "vat_purchase_tax_id_services",
    "vat_purchase_tax_id_generic",
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
      ["id", "name", "amount", "amount_type", "type_tax_use", "price_include", "description", "tax_group_id"],
      kwWithCompany(companyId, { limit: 2000, order: "name asc" })
    )) || [];

  const norm = (s) => String(s || "").toLowerCase();
  const has = (t, re) => re.test(`${norm(t.name)} ${norm(t.description)} ${Array.isArray(t.tax_group_id) ? norm(t.tax_group_id[1]) : ""}`);
  const isWithholding = (t) => has(t, /fwvat|ewvat|withhold|withholding|wht|designated|ds\b/);
  const isImport = (t) => has(t, /\bimport\b|\bimportation\b|\b12%\s*i\b/);
  const isNcr = (t) => has(t, /\bncr\b|non[-\s]?credit/);

  const vat12 = taxes.filter((t) => {
    const amount = Number(t.amount || 0);
    return (
      t.amount_type === "percent" &&
      Math.abs(amount - 12) < 0.0001 &&
      !isWithholding(t) &&
      !isImport(t) &&
      !isNcr(t)
    );
  });

  if (!vat12.length) {
    return { goodsId: null, servicesId: null, genericId: null };
  }

  const isCapitalGoods = (t) => has(t, /capital\s*goods|capital\s*asset|\bcapital\b.*\bgoods\b|\b12%\s*c\b|\b12%c\b/);
  const serviceLike = (t) => has(t, /service|consult|professional|repair|rent|labor|contract|freight/) && !isCapitalGoods(t);
  const goodsLike = (t) => has(t, /goods|supply|material|inventory|product|merch/) && !isCapitalGoods(t);

  const generic = pickTopTaxByScore(vat12, (t) => {
    let score = 0;
    if (isCapitalGoods(t)) return -100;
    if (norm(t.type_tax_use) === "purchase") score += 5;
    if (!t.price_include) score += 2;
    if (serviceLike(t) || goodsLike(t)) score += 1;
    return score;
  });
  const services = pickTopTaxByScore(vat12, (t) => {
    let score = 0;
    if (isCapitalGoods(t)) return -100;
    if (serviceLike(t)) score += 10;
    if (!goodsLike(t)) score += 2;
    if (!t.price_include) score += 1;
    return score;
  });
  const goods = pickTopTaxByScore(vat12, (t) => {
    let score = 0;
    if (isCapitalGoods(t)) return -100;
    if (goodsLike(t)) score += 10;
    if (!serviceLike(t)) score += 2;
    if (!t.price_include) score += 1;
    return score;
  });

  return {
    goodsId: Number(goods?.id || generic?.id || 0) || null,
    servicesId: Number(services?.id || generic?.id || 0) || null,
    genericId: Number(generic?.id || 0) || null
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
      const pick = await pickVatTaxesForCompany(odoo, g.companyId);

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
          String(row.vat_purchase_tax_id_goods || "").trim(),
          String(row.vat_purchase_tax_id_services || "").trim(),
          String(row.vat_purchase_tax_id_generic || "").trim(),
          String(row.purchase_journal_id || "").trim(),
          String(row.ap_folder_id || "").trim(),
          String(row.industry || "").trim()
        ].join("|");

        row.vat_purchase_tax_id_goods = pick.goodsId ? String(pick.goodsId) : "";
        row.vat_purchase_tax_id_services = pick.servicesId ? String(pick.servicesId) : "";
        row.vat_purchase_tax_id_generic = pick.genericId ? String(pick.genericId) : "";
        if (journalId) row.purchase_journal_id = String(journalId);
        if (apFolderId) row.ap_folder_id = String(apFolderId);
        if (industryVal) row.industry = industryVal; // industry is source-only (General task), no target fallback

        const after = [
          String(row.vat_purchase_tax_id_goods || "").trim(),
          String(row.vat_purchase_tax_id_services || "").trim(),
          String(row.vat_purchase_tax_id_generic || "").trim(),
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
  const vatGoodsField = g("sourceGeneralTaskVatGoodsField");
  const vatServicesField = g("sourceGeneralTaskVatServicesField");
  const vatGenericField = g("sourceGeneralTaskVatGenericField");

  const fields = ["id", "project_id", dbField, industryField];
  if (enabledField) fields.push(enabledField);
  if (billWorkerField) fields.push(billWorkerField);
  if (multiCompanyField) fields.push(multiCompanyField);
  if (companyIdField) fields.push(companyIdField);
  if (emailField) fields.push(emailField);
  if (passwordField) fields.push(passwordField);
  const accountingFields = [apFolderField, purchaseJournalField, vatGoodsField, vatServicesField, vatGenericField].filter(Boolean);
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
      purchaseJournalId: m2oId(purchaseJournalField ? task[purchaseJournalField] : null),
      vatIds: {
        goods: m2oId(vatGoodsField ? task[vatGoodsField] : null),
        services: m2oId(vatServicesField ? task[vatServicesField] : null),
        generic: m2oId(vatGenericField ? task[vatGenericField] : null)
      }
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
      vatIds: accounting.vatIds,
      industry
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
        vatIds: {
          goods: row.vat_purchase_tax_id_goods || 0,
          services: row.vat_purchase_tax_id_services || 0,
          generic: row.vat_purchase_tax_id_generic || 0
        },
        industry: String(row.industry || "").trim()
      });
    }
  }
  return [...groups.values()];
}

async function resolveApFolderId(odoo, companyId, opts = {}) {
  const parentFolderName = String(opts.parentFolderName || "").trim();
  const names = ["Accounts Payable", "Account Payables", "AP", "Vendor Bills"];

  // If parent specified (e.g. "Accounting"), resolve root folder with that name first
  let parentId = null;
  if (parentFolderName) {
    try {
      const parents = await odoo.searchRead(
        "documents.document",
        [["is_folder", "=", true], ["name", "=", parentFolderName], ["folder_id", "=", false]],
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

  // Odoo 19: folders are documents.document with is_folder=true
  try {
    for (const name of names) {
      const folders = await odoo.searchRead(
        "documents.document",
        [["is_folder", "=", true], ["name", "=", name], ...folderIdDomain],
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
    let frontier = [rootFolderId];
    for (let depth = 0; depth < 5 && frontier.length; depth++) {
      const children = await odoo.searchRead(
        "documents.document",
        [["is_folder", "=", true], ["folder_id", "in", frontier]],
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
  const isFolderCond = useIsFolder ? [["is_folder", "=", false]] : [];

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
    await odoo.executeKw(
      model,
      "message_post",
      [[Number(resId)]],
      kwWithCompany(companyId, {
        body: String(body || ""),
        message_type: "comment",
        subtype_xmlid: "mail.mt_note",
        body_is_html: true
      })
    );
  } catch (_err) {
    // best effort
  }
}

async function findVendor(odoo, companyId, extracted, ocrText) {
  const picked = pickVendorFromExtraction(extracted, ocrText);
  const vendorName = String(picked.name || "").trim();
  if (!vendorName) return { id: 0, name: "", confidence: 0, source: picked.source };

  const details = extracted?.vendor_details || {};
  const tradeName = String(details.trade_name || "").trim();
  const proprietorName = String(details.proprietor_name || "").trim();
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
  const proprietorName = String(details.proprietor_name || "").trim();

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
  if (String(details.address || "").trim()) vals.street = String(details.address).trim().slice(0, 255);
  if (String(details.tin || "").trim()) vals.vat = String(details.tin).trim();
  const notes = [];
  if (isSoleProp && tradeName) notes.push(`Trade name: ${tradeName}`);
  if (isSoleProp && proprietorName && proprietorName.toLowerCase() !== name.toLowerCase()) {
    notes.push(`Proprietor: ${proprietorName}`);
  }
  if (tradeName && !isSoleProp && tradeName.toLowerCase() !== name.toLowerCase()) {
    notes.push(`DBA: ${tradeName}`);
  }
  if (notes.length) vals.comment = notes.join("\n");
  let newId;
  try {
    vals.company_type = isSoleProp ? "person" : "company";
    newId = await odoo.create("res.partner", vals);
  } catch (e) {
    if (String(e?.message || "").includes("company_type")) {
      delete vals.company_type;
      if (isSoleProp) vals.is_company = false;
      else vals.is_company = true;
      try {
        newId = await odoo.create("res.partner", vals);
      } catch (_) {
        delete vals.is_company;
        newId = await odoo.create("res.partner", vals);
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

function pickTaxIds(vatIds, extracted) {
  const classification = String(extracted?.vat?.classification || "").toLowerCase();
  const lineItems = extracted?.line_items || [];
  const anyLineVatable = lineItems.some(
    (li) => String(li.vat_code || "").toLowerCase() === "vatable"
  );

  if (
    !anyLineVatable &&
    (classification === "exempt" || classification === "zero_rated" || classification === "unknown")
  ) {
    return [];
  }
  const gs = String(extracted?.vat?.goods_or_services || "").toLowerCase();
  if (gs === "services" && Number(vatIds.services)) return [Number(vatIds.services)];
  if (gs === "goods" && Number(vatIds.goods)) return [Number(vatIds.goods)];
  const generic = Number(vatIds.generic) || 0;
  return generic ? [generic] : [];
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

async function findDuplicateBill(odoo, companyId, vendorId, extracted) {
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
  // Tier 1: vendor default (skip if it's a generic account like Admin Expense)
  const vendorAcct = await getVendorDefaultAccountId(odoo, companyId, vendorId);
  if (vendorAcct && expenseAccounts?.length) {
    const vendorAcctObj = expenseAccounts.find((a) => a.id === vendorAcct);
    if (vendorAcctObj && !isGenericAccount(vendorAcctObj)) {
      return { accountId: vendorAcct, source: "vendor_default" };
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
        if (acct) return { accountId: acct.id, source: "vendor_memory" };
      }
    }
  }

  // Tier 3: Gemini pick (validated + repaired via code/name, anti-generic guard)
  if (geminiPick && expenseAccounts?.length) {
    const result = pickBestGeminiAccount(geminiPick, expenseAccounts);
    if (result.accountId) return result;
  }

  // Tier 4: vendor name keywords (e.g. "FABRIC TRADING" → Supplies)
  if (vendorName && expenseAccounts?.length) {
    const vnHint = vendorNameAccountHint(vendorName, expenseAccounts);
    if (vnHint) return { accountId: vnHint, source: "vendor_name_hint" };
  }

  // Tier 5: sheet mapping (AccountMapping tab)
  if (accountMapping?.length) {
    const mapped = lookupAccountMapping(accountMapping, companyId, category, targetDb);
    if (mapped) return { accountId: mapped, source: "sheet_mapping" };
  }

  // Tier 6: fuzzy name match using line description + category keywords
  if (expenseAccounts?.length) {
    const fuzzy = fuzzyMatchAccount(expenseAccounts, suggestedName, category, lineDescription);
    if (fuzzy) return { accountId: fuzzy, source: "fuzzy_match" };
  }

  // Tier 7: Gemini pick even if generic (still better than Odoo's blind default)
  if (geminiPick && expenseAccounts?.length) {
    const primaryId = resolveGeminiCandidate(geminiPick, expenseAccounts);
    if (primaryId) return { accountId: primaryId, source: "gemini_last_resort" };
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
      if (bestId) return { accountId: bestId, source: "keyword_last_resort" };
      return { accountId: nonGeneric[0].id, source: "first_non_generic" };
    }
    return { accountId: expenseAccounts[0].id, source: "first_available" };
  }

  // Tier 9: env fallback
  if (config.odooDefaults.defaultExpenseAccountId > 0) {
    return { accountId: config.odooDefaults.defaultExpenseAccountId, source: "env_fallback" };
  }

  return { accountId: 0, source: "none" };
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
  if (grandTotal > 0) {
    const diffGrand = Math.abs(lineSum - grandTotal) / grandTotal;
    if (diffGrand < 0.05) return true;
  }
  if (netTotal > 0 && netTotal !== grandTotal) {
    const diffNet = Math.abs(lineSum - netTotal) / netTotal;
    if (diffNet < 0.05) return true;
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
  return l.includes("total") || l.includes("grand") || l.includes("due") || l.includes("amount due") || l.includes("amount_due") || l === "amount";
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
    if (lineItems.length >= 1 && lineSum > 0 && Math.abs(lineSum - grandTotal) / grandTotal > 0.1) {
      correctTotal = lineSum;
      if (logger) logger.info("Amount correction: grand total looks like a year number.", {
        geminiTotal: grandTotal, lineSum
      });
    } else {
      const totalCand = candidates
        .filter((c) => isTotalLikeLabel(c.label) && Math.abs(c.amount - grandTotal) / grandTotal > 0.1)
        .sort((a, b) => b.confidence - a.confidence)[0];
      if (totalCand) {
        correctTotal = totalCand.amount;
        if (logger) logger.info("Amount correction: grand total looks like a year, using candidate.", {
          geminiTotal: grandTotal, candidateAmount: totalCand.amount, label: totalCand.label
        });
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

function buildBillVals(extracted, vendorId, companyId, taxIds, purchaseJournalId, currencyId, taxMeta, lineAccountIds) {
  const inv = extracted?.invoice || {};
  const totals = extracted?.totals || {};
  const grandTotal = Number(totals.grand_total || 0);
  const netTotal = Number(totals.net_total || 0);
  const globalVatInclusive = !!totals.amounts_are_vat_inclusive;
  const hasTax = taxIds.length > 0;
  const taxPriceInclude = !!taxMeta?.priceInclude;
  const taxRate = Number(taxMeta?.amount || 12);

  const usedNetTotal = hasTax && globalVatInclusive && !taxPriceInclude && netTotal > 0;
  const total = usedNetTotal ? netTotal : (grandTotal || netTotal || 0);
  const invoiceDate = String(inv.date || "").slice(0, 10) || undefined;
  const ref = String(inv.number || "").trim();

  const lineItems = extracted?.line_items || [];
  const useLineItems = lineItems.length > 0 && lineItemsTotalMatchesInvoice(lineItems, grandTotal, netTotal);
  const hint = extracted?.expense_account_hint || {};
  const invoiceLines = [];

  const expectedUntaxed = hasTax && !taxPriceInclude && grandTotal > 0
    ? (netTotal > 0 ? netTotal : Math.round((grandTotal / (1 + taxRate / 100)) * 100) / 100)
    : (grandTotal || netTotal || 0);

  const hasPerLineVat = lineItems.some((li) => li.vat_code);

  if (useLineItems) {
    for (let i = 0; i < lineItems.length; i++) {
      const item = lineItems[i];
      const lineVatCode = String(item.vat_code || "").toLowerCase();

      let lineHasTax;
      if (hasPerLineVat && lineVatCode) {
        lineHasTax = lineVatCode === "vatable" && taxIds.length > 0;
      } else {
        lineHasTax = hasTax;
      }

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
      if (lineHasTax) line.tax_ids = [[6, 0, taxIds]];
      invoiceLines.push([0, 0, line]);
    }

    if (!hasPerLineVat && expectedUntaxed > 0 && invoiceLines.length > 0) {
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
    const adjustedTotal = hasTax ? adjustPriceForTax(total, singleLineVatInclusive, taxPriceInclude, taxRate) : total;
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
    if (hasTax) line.tax_ids = [[6, 0, taxIds]];
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
  return vals;
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
      const rows = await odoo.searchRead(
        model,
        [["id", "=", Number(folderId)]],
        ["active"],
        kwWithCompany(companyId, { limit: 1 })
      );
      if (rows?.[0]) {
        const active = rows[0].active;
        return active === false || active === 0;
      }
    } catch (_) {}
  }
  return false;
}

async function ensureAccountingFolderActive(odoo, companyId, journalId, logger) {
  const folderIds = new Set();

  for (const field of ["documents_account_folder_id"]) {
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
        const rows = await odoo.searchRead(
          model,
          model === "documents.document"
            ? [["is_folder", "=", true], ["active", "=", false]]
            : [["active", "=", false]],
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
        const rows = await odoo.searchRead(model, [["id", "=", fid]], ["id", "active"], { limit: 1 });
        if (rows?.[0] && (rows[0].active === false || rows[0].active === 0)) {
          await odoo.write(model, [fid], { active: true });
          if (logger) logger.info("Unarchived accounting documents folder.", { model, folderId: fid });
        }
      } catch (_) {}
    }
  }
}

async function linkDocumentToBill(odoo, companyId, docId, billId, logger, activeApFolderId = 0, useIsFolder = false, journalId = 0) {
  await ensureAccountingFolderActive(odoo, companyId, journalId, logger);

  const docRows = await odoo.searchRead(
    "documents.document",
    [["id", "=", Number(docId)]],
    ["id", "folder_id"],
    kwWithCompany(companyId, { limit: 1 })
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

  const linkVals = {};
  if (await documentsDocumentHasField(odoo, "res_model")) linkVals.res_model = "account.move";
  if (await documentsDocumentHasField(odoo, "res_id")) linkVals.res_id = Number(billId);
  if (await documentsDocumentHasField(odoo, "account_move_id")) linkVals.account_move_id = Number(billId);
  if (await documentsDocumentHasField(odoo, "invoice_id")) linkVals.invoice_id = Number(billId);
  if (originalFolderId) linkVals.folder_id = originalFolderId;

  if (Object.keys(linkVals).length) {
    await odoo.write("documents.document", [Number(docId)], linkVals);
  }

  if (originalFolderId) {
    const delays = [800, 1500, 3000, 5000];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      await sleep(delays[attempt]);
      try {
        const rows = await odoo.searchRead(
          "documents.document",
          [["id", "=", Number(docId)]],
          ["id", "folder_id"],
          kwWithCompany(companyId, { limit: 1 })
        );
        const currentFolderId = readFolderId(rows?.[0]);
        if (currentFolderId === originalFolderId) break;
        await odoo.write("documents.document", [Number(docId)], { folder_id: originalFolderId });
        if (logger) logger.info("Restored document folder after link.", {
          docId, originalFolderId, movedTo: currentFolderId, attempt: attempt + 1
        });
      } catch (_) {}
    }
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
    vatIds,
    purchaseJournalId,
    industry,
    reprocess = false,
    apFolderId: argApFolderId = 0,
    useIsFolder: argUseIsFolder = false
  } = args;
  const attachmentId = m2oId(doc.attachment_id);
  if (!attachmentId) return { status: "skip", reason: "no_attachment" };

  if (!reprocess) {
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
        return { status: "skip", reason: "already_linked", billId: linkedId, billState: String(billRows[0].state || "") };
      }
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

  const extracted = await extractInvoiceWithGemini(ocrText, config, att);
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
          `TIN=${extracted?.vendor_details?.tin || "(none)"} Address=${extracted?.vendor_details?.address || "(none)"}`
      );
      return { status: "skip", reason: "vendor_not_found", manual_review: true };
    }
  }

  if (!reprocess) {
    const duplicate = await findDuplicateBill(odoo, companyId, vendor.id, extracted);
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
  let taxIds = pickTaxIds(vatIds, extracted);
  if (!taxIds.length) {
    const cls = String(extracted?.vat?.classification || "").toLowerCase();
    const anyVatable = (extracted?.line_items || []).some((li) => String(li.vat_code || "").toLowerCase() === "vatable");
    const hasExtractedTax = Number(extracted?.totals?.tax_total || 0) > 0;
    if (cls === "vatable" || anyVatable || hasExtractedTax) {
      try {
        const autoPick = await pickVatTaxesForCompany(odoo, companyId);
        const autoVatIds = {
          goods: autoPick.goodsId || 0,
          services: autoPick.servicesId || 0,
          generic: autoPick.genericId || 0
        };
        taxIds = pickTaxIds(autoVatIds, extracted);
        if (taxIds.length) {
          logger.info("Auto-detected purchase VAT tax from Odoo (target vatIds were empty).", { docId: doc.id, taxIds, autoVatIds });
        }
      } catch (err) {
        logger.warn("VAT auto-detect failed.", { docId: doc.id, error: err?.message || String(err) });
      }
    }
  }
  const taxMeta = await getTaxMeta(odoo, companyId, taxIds);

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
    logger.info("Account resolved.", {
      docId: doc.id, line: i, category, lineDesc: lineDesc.slice(0, 40),
      accountId: resolved.accountId, source: resolved.source
    });
  }

  const billVals = buildBillVals(
    extracted,
    vendor.id,
    companyId,
    taxIds,
    purchaseJournalId,
    currencyId,
    taxMeta,
    lineAccountIds
  );
  const billId = await odoo.create("account.move", billVals);
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
  await attachFileToBillChatter(odoo, companyId, att, Number(billId), Number(doc.id));
  await linkDocumentToBill(odoo, companyId, Number(doc.id), Number(billId), logger, argApFolderId, argUseIsFolder, purchaseJournalId);
  await safeMessagePost(
    odoo,
    companyId,
    "documents.document",
    doc.id,
    `✅ Draft Vendor Bill created: account.move #${billId}<br/>Vendor=${vendor.name || "(unknown)"}`
  );

  {
    const vd = extracted?.vendor_details || {};
    const et = String(vd.entity_type || vendor.entityType || "unknown").toLowerCase();
    const entityLabel = et === "sole_proprietor" ? "Sole Proprietor"
      : et === "corporation" ? "Corporation"
      : et === "individual" ? "Individual"
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
      vd.address ? `Address: ${vd.address}` : null,
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
        vatIds: target.vatIds,
        purchaseJournalId: target.purchaseJournalId,
        industry: target.industry,
        apFolderId,
        useIsFolder
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
  if (!docId && !attachmentId) {
    throw new Error("run-one requires either doc_id or attachment_id.");
  }

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

  if (doc.res_model === "account.move" && doc.res_id) {
    const existingBill = await odoo.searchRead(
      "account.move",
      [["id", "=", Number(doc.res_id)]],
      ["id", "state"],
      kwWithCompany(companyId, { limit: 1 })
    );
    if (existingBill?.length) {
      const reprocess = !!(payload.reprocess || payload.force_reprocess);
      if (!reprocess) {
        logger.info("Document already linked to bill; skipping.", {
          docId: doc.id, billId: doc.res_id, state: existingBill[0].state
        });
        return {
          ok: true, mode: "run-one", time_start: timeStart, time_completed: new Date().toISOString(),
          targetKey: target.targetKey,
          doc: { id: Number(doc.id), name: String(doc.name || ""), attachment_id: m2oId(doc.attachment_id) },
          result: { status: "skip", reason: "already_linked", billId: Number(doc.res_id), billState: String(existingBill[0].state || "") }
        };
      }
    } else {
      logger.info("Clearing stale bill link from document (bill was deleted).", {
        docId: doc.id, staleBillId: doc.res_id
      });
      const clearVals = { res_model: false, res_id: false };
      if (await documentsDocumentHasField(odoo, "account_move_id")) clearVals.account_move_id = false;
      if (await documentsDocumentHasField(odoo, "invoice_id")) clearVals.invoice_id = false;
      await odoo.write("documents.document", [Number(doc.id)], clearVals);
    }
  }

  let runOneApFolderId = Number(target.apFolderId || 0);
  let runOneUseIsFolder = false;
  if (!runOneApFolderId) {
    const parentName = String(target.apFolderParent ?? "").trim() || undefined;
    const r = await resolveApFolderId(odoo, companyId, { parentFolderName: parentName });
    runOneApFolderId = r.apFolderId;
    runOneUseIsFolder = r.useIsFolder;
  }

  const result = await processOneDocument({
    logger,
    odoo,
    companyId,
    targetKey: target.targetKey,
    doc,
    vatIds: target.vatIds,
    purchaseJournalId: target.purchaseJournalId,
    industry: target.industry,
    reprocess: !!(payload.reprocess || payload.force_reprocess),
    apFolderId: runOneApFolderId,
    useIsFolder: runOneUseIsFolder
  });

  return {
    ok: true,
    mode: "run-one",
    time_start: timeStart,
    time_completed: new Date().toISOString(),
    targetKey: target.targetKey,
    doc: {
      id: Number(doc.id),
      name: String(doc.name || ""),
      attachment_id: m2oId(doc.attachment_id)
    },
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
  if (useIsFolder) docDomain.push(["is_folder", "=", false]);
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
