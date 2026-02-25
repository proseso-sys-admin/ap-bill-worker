const express = require("express");
const { config, validateConfig } = require("./config");
const { createLogger } = require("./logger");
const { runWorker, runOne, listApDocuments } = require("./worker");

const logger = createLogger(config.server.logLevel);
const app = express();
app.use(express.json({ limit: "1mb" }));

let isRunning = false;

function isAuthorized(req) {
  if (!config.server.sharedSecret) return true;
  const ip = req.ip || req.socket?.remoteAddress || "";
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  const token = (req.header("x-worker-secret") || "").trim();
  return token && token === config.server.sharedSecret;
}

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true, service: "ap-bill-ocr-worker" });
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, service: "ap-bill-ocr-worker" });
});

app.get("/", (_req, res) => {
  // When adding a new route (e.g. /collect-feedback, webhooks), add it here so GET / lists all available endpoints.
  res.status(200).json({ ok: true, service: "ap-bill-ocr-worker", routes: ["/health", "/healthz", "/run", "/run-one", "/list-docs", "/debug"] });
});

app.get("/list-docs", async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const payload = { target_key: req.query.target_key || "" };
    const result = await listApDocuments({ logger, payload });
    return res.status(200).json(result);
  } catch (err) {
    const msg = err?.message || String(err);
    const detail = err?.response?.data ? JSON.stringify(err.response.data) : err?.stack;
    logger.error("List docs failed.", { error: msg, detail });
    return res.status(500).json({ ok: false, error: msg, detail: detail || undefined });
  }
});

app.post("/debug", async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const { OdooClient, kwWithCompany } = require("./odoo");
  const { loadRoutingSheetData, loadRoutingRows, getRoutingRowValidation } = require("./sheets");
  const { getRoutingSummary } = require("./worker");
  try {
    const routingSummary = await getRoutingSummary(logger);
    const { rows: rawRows } = await loadRoutingSheetData(config);
    const toBool = (v) => ["1", "true", "yes", "y"].includes(String(v || "").trim().toLowerCase());
    const first25 = rawRows.slice(0, 25).map((r, i) => ({
      index: i + 1,
      db: String(r.target_db || "").trim(),
      enabled: String(r.enabled || "").trim(),
      validation: getRoutingRowValidation(r)
    }));
    const enabledRows = rawRows
      .map((r, i) => ({ row: r, index: i + 1 }))
      .filter(({ row }) => toBool(row.enabled))
      .map(({ row, index }) => ({
        index,
        db: String(row.target_db || "").trim(),
        enabled: String(row.enabled || "").trim(),
        validation: getRoutingRowValidation(row)
      }));
    Object.assign(routingSummary, {
      rawRowCount: rawRows.length,
      rawRowsValidation: first25,
      enabledRowsValidation: enabledRows
    });
    const rows = await loadRoutingRows(config);
    if (!rows.length) return res.json({ ok: false, error: "no routing rows", routingSummary });
    const row = rows[0];
    const odoo = new OdooClient({
      baseUrl: row.target_base_url,
      db: row.target_db,
      login: row.target_login,
      password: row.target_password
    });
    const companyId = row.target_company_id;
    const results = {};

    results.auth = { uid: await odoo.authenticate() };

    const partners = await odoo.searchRead("res.partner", [], ["id", "name"],
      kwWithCompany(companyId, { limit: 1 }));
    results.res_partner = { count: partners.length, sample: partners[0]?.name || null };

    try {
      const modules = await odoo.searchRead("ir.module.module",
        [["name", "=", "documents"], ["state", "=", "installed"]],
        ["id", "name", "state", "shortdesc"],
        { limit: 5 });
      results.documents_module = modules;
    } catch (e) { results.documents_module_error = e.message; }

    try {
      const folders = await odoo.searchRead("documents.folder", [], ["id", "name"],
        kwWithCompany(companyId, { limit: 5 }));
      results.documents_folder = folders;
    } catch (e) { results.documents_folder_error = e.message; }

    try {
      const docs = await odoo.searchRead("documents.document", [], ["id", "name"],
        kwWithCompany(companyId, { limit: 1 }));
      results.documents_document = { count: docs.length };
    } catch (e) { results.documents_document_error = e.message; }

    try {
      const fields = await odoo.executeKw("documents.document", "fields_get", [], { attributes: ["string", "type", "relation"] });
      const folderFields = {};
      for (const [k, v] of Object.entries(fields)) {
        if (k.includes("folder") || k.includes("workspace") || k.includes("tag") || k.includes("facet") || k.includes("categ") || v.relation) {
          folderFields[k] = { string: v.string, type: v.type, relation: v.relation || null };
        }
      }
      results.document_fields = folderFields;
    } catch (e) { results.document_fields_error = e.message; }

    for (const model of ["documents.facet", "documents.tag", "documents.workspace", "documents.share"]) {
      try {
        const rows2 = await odoo.searchRead(model, [], ["id", "name"], kwWithCompany(companyId, { limit: 5 }));
        results[model.replace(/\./g, "_")] = rows2;
      } catch (e) { results[model.replace(/\./g, "_") + "_error"] = e.message; }
    }

    return res.json({
      ok: true,
      routingSummary,
      target: row.target_base_url,
      db: row.target_db,
      companyId,
      results
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post("/run", async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (isRunning) return res.status(409).json({ ok: false, error: "already_running" });
  isRunning = true;
  try {
    logger.info("Worker run started.", { trigger: "http_post" });
    const result = await runWorker({ logger, payload: req.body || {} });
    logger.info("Worker run finished.", { elapsedMs: result.elapsedMs, totals: result.totals });
    return res.status(200).json(result);
  } catch (err) {
    const msg = err?.message || String(err);
    const detail = err?.response?.data ? JSON.stringify(err.response.data) : err?.stack;
    logger.error("Worker run failed.", { error: msg, detail });
    return res.status(500).json({ ok: false, error: msg, detail: detail || undefined });
  } finally {
    isRunning = false;
  }
});

app.get("/run", async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (isRunning) return res.status(409).json({ ok: false, error: "already_running" });
  isRunning = true;
  try {
    logger.info("Worker run started.", { trigger: "http_get" });
    const result = await runWorker({ logger });
    logger.info("Worker run finished.", { elapsedMs: result.elapsedMs, totals: result.totals });
    return res.status(200).json(result);
  } catch (err) {
    const msg = err?.message || String(err);
    const detail = err?.response?.data ? JSON.stringify(err.response.data) : err?.stack;
    logger.error("Worker run failed.", { error: msg, detail });
    return res.status(500).json({ ok: false, error: msg, detail: detail || undefined });
  } finally {
    isRunning = false;
  }
});

app.post("/run-one", async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (isRunning) return res.status(409).json({ ok: false, error: "already_running" });
  isRunning = true;
  try {
    logger.info("Worker run-one started.", { trigger: "http_post", payload: req.body || {} });
    const result = await runOne({ logger, payload: req.body || {} });
    logger.info("Worker run-one finished.", { targetKey: result.targetKey, docId: result.doc?.id, status: result.result?.status });
    return res.status(200).json(result);
  } catch (err) {
    const msg = err?.message || String(err);
    const detail = err?.response?.data ? JSON.stringify(err.response.data) : err?.stack;
    logger.error("Worker run-one failed.", { error: msg, detail });
    return res.status(500).json({ ok: false, error: msg, detail: detail || undefined });
  } finally {
    isRunning = false;
  }
});

function start() {
  validateConfig();
  app.listen(config.server.port, () => {
    logger.info("Server started.", { port: config.server.port });
  });
}

start();
