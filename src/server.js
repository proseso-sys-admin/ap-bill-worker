const express = require("express");
const { config, validateConfig } = require("./config");
const { createLogger } = require("./logger");
const { sleep } = require("./utils");
const { runWorker, runOne, listApDocuments, collectFeedback, handleDocumentDelete } = require("./worker");
const { runBsWorker, runBsOne, handleBsDocumentDelete } = require("./bs-worker");

const logger = createLogger(config.server.logLevel);
const app = express();
app.use((req, res, next) => {
  express.json({ limit: "1mb" })(req, res, (err) => {
    if (err && err.type === "entity.parse.failed") {
      req.body = {};
      return next();
    }
    next(err);
  });
});

let isRunning = false;
let runOneCount = 0;
const inFlightDocs = new Set();
let isBsRunning = false;
let bsRunOneCount = 0;
const bsInFlightDocs = new Set();

function isAuthorized(req, bodySecret = null) {
  if (!config.server.sharedSecret) return true;
  const ip = req.ip || req.socket?.remoteAddress || "";
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  const headerToken = (req.header("x-worker-secret") || "").trim();
  const bodyToken = bodySecret != null ? String(bodySecret || "").trim() : "";
  const queryToken = (req.query.worker_secret || "").trim();
  const token = headerToken || bodyToken || queryToken;
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
  res.status(200).json({
  ok: true,
  service: "ap-bill-ocr-worker",
  routes: [
    "/health", "/healthz", "/run", "/run-one", "/list-docs", "/debug",
    "/collect-feedback", "/webhook/document-upload", "/webhook/document-delete", "/webhook/chatter-message",
    "/bs/run", "/bs/run-one",
    "/webhook/bs-document-upload", "/webhook/bs-document-delete", "/webhook/bs-chatter-message"
  ]
});
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
  if (isRunning) return res.status(409).json({ ok: false, error: "already_running", message: "Full worker run in progress." });
  const maxConcurrent = config.server.runOneMaxConcurrency || 5;
  if (runOneCount >= maxConcurrent) {
    res.setHeader("Retry-After", "30");
    return res.status(503).json({ ok: false, error: "too_many_concurrent_run_one", message: "Max concurrent run-one reached; retry later." });
  }
  runOneCount += 1;
  try {
    logger.info("Worker run-one started.", { trigger: "http_post", payload: req.body || {}, runOneCount });
    const result = await runOne({ logger, payload: req.body || {} });
    logger.info("Worker run-one finished.", { targetKey: result.targetKey, docId: result.doc?.id, status: result.result?.status });
    return res.status(200).json(result);
  } catch (err) {
    const msg = err?.message || String(err);
    const detail = err?.response?.data ? JSON.stringify(err.response.data) : err?.stack;
    logger.error("Worker run-one failed.", { error: msg, detail });
    return res.status(500).json({ ok: false, error: msg, detail: detail || undefined });
  } finally {
    runOneCount -= 1;
  }
});

app.post("/collect-feedback", async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const result = await collectFeedback(logger);
    return res.status(200).json(result);
  } catch (err) {
    const msg = err?.message || String(err);
    logger.error("collect-feedback failed.", { error: msg });
    return res.status(500).json({ ok: false, error: msg });
  }
});

app.post("/webhook/document-upload", async (req, res) => {
  if (!isAuthorized(req, req.body?.worker_secret)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (isRunning) return res.status(409).json({ ok: false, error: "already_running", message: "Full worker run in progress." });
  const maxConcurrent = config.server.runOneMaxConcurrency || 5;
  if (runOneCount >= maxConcurrent) {
    res.setHeader("Retry-After", "30");
    return res.status(503).json({ ok: false, error: "too_many_concurrent_run_one", message: "Max concurrent run-one reached; retry later." });
  }
  const payload = req.body || {};
  const docId = Number(payload.doc_id || payload.document_id || payload.id || 0);
  const attachmentId = Number(payload.attachment_id || 0);
  const targetKey = String(payload.target_key || "").trim();
  if (!docId && !attachmentId) {
    return res.status(400).json({ ok: false, error: "doc_id or attachment_id required" });
  }
  if (inFlightDocs.has(docId)) {
    logger.info("Webhook document-upload: duplicate ignored.", { doc_id: docId, runOneCount });
    return res.status(200).json({ ok: true, message: "duplicate ignored" });
  }
  runOneCount += 1;
  inFlightDocs.add(docId);
  const retryDelaysMs = [0, 1000, 2000, 2000]; // instant first try; backoff only when race (document/attachment not committed yet)
  let lastError = null;
  let lastResult = null;
  try {
    for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
      if (attempt > 0) {
        const delay = retryDelaysMs[attempt];
        logger.info("Webhook document-upload: retrying after race.", { doc_id: docId, attempt: attempt + 1, delay_ms: delay });
        await sleep(delay);
      }
      try {
        logger.info("Webhook document-upload: run-one attempt.", { doc_id: docId, attachment_id: attachmentId, target_key: targetKey || "(any)", runOneCount, attempt: attempt + 1 });
        lastResult = await runOne({ logger, payload: { doc_id: docId, attachment_id: attachmentId, target_key: targetKey || undefined } });
        const reason = lastResult?.result?.reason;
        const skip = lastResult?.result?.status === "skip" && (reason === "no_attachment" || reason === "attachment_not_found");
        if (!skip) return res.status(200).json(lastResult);
        lastError = new Error(`Transient: ${reason}`);
      } catch (err) {
        lastError = err;
        const msg = err?.message || String(err);
        const isRace = /document not found|not found for attachment_id/i.test(msg);
        if (!isRace || attempt === retryDelaysMs.length - 1) {
          logger.error("Webhook document-upload failed.", { error: msg });
          return res.status(500).json({ ok: false, error: msg });
        }
      }
    }
    if (lastResult) return res.status(200).json(lastResult);
    const msg = lastError?.message || String(lastError);
    logger.error("Webhook document-upload failed after retries.", { error: msg });
    return res.status(500).json({ ok: false, error: msg });
  } finally {
    runOneCount -= 1;
    inFlightDocs.delete(docId);
  }
});

app.post("/webhook/document-delete", async (req, res) => {
  if (!isAuthorized(req, req.body?.worker_secret)) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const payload = req.body || {};
    const result = await handleDocumentDelete(logger, payload);
    if (result.error === "missing_doc_id") return res.status(400).json(result);
    if (result.ok === false && result.error) {
      const status = result.error === "bill_not_draft" ? 409 : 404;
      return res.status(status).json(result);
    }
    return res.status(200).json(result);
  } catch (err) {
    const msg = err?.message || String(err);
    logger.error("Webhook document-delete failed.", { error: msg });
    return res.status(500).json({ ok: false, error: msg });
  }
});

app.post("/webhook/chatter-message", async (req, res) => {
  if (!isAuthorized(req, req.body?.worker_secret)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const maxConcurrent = config.server.runOneMaxConcurrency || 5;
  if (runOneCount >= maxConcurrent) {
    res.setHeader("Retry-After", "30");
    return res.status(503).json({ ok: false, error: "too_many_concurrent" });
  }
  const payload = req.body || {};
  const docId = Number(payload.doc_id || payload.document_id || payload.id || 0);
  if (!docId) return res.status(400).json({ ok: false, error: "doc_id required" });

  runOneCount += 1;
  try {
    const result = await runOne({
      logger,
      payload: {
        doc_id: docId,
        target_key: payload.target_key || undefined,
        message_body: payload.message_body || ""
      }
    });
    return res.status(200).json(result);
  } catch (err) {
    const msg = err?.message || String(err);
    logger.error("Webhook chatter-message failed.", { error: msg });
    return res.status(500).json({ ok: false, error: msg });
  } finally {
    runOneCount -= 1;
  }
});

// ---------------------------------------------------------------------------
// Bank Statement Worker routes
// ---------------------------------------------------------------------------

app.post("/bs/run", async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (isBsRunning) return res.status(409).json({ ok: false, error: "already_running" });
  isBsRunning = true;
  try {
    logger.info("BS worker run started.", { trigger: "http_post" });
    const result = await runBsWorker({ logger, payload: req.body || {} });
    logger.info("BS worker run finished.", { elapsedMs: result.elapsedMs, targets: result.targets, processed: result.processed });
    return res.status(200).json(result);
  } catch (err) {
    const msg = err?.message || String(err);
    logger.error("BS worker run failed.", { error: msg });
    return res.status(500).json({ ok: false, error: msg });
  } finally {
    isBsRunning = false;
  }
});

app.get("/bs/run", async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (isBsRunning) return res.status(409).json({ ok: false, error: "already_running" });
  isBsRunning = true;
  try {
    logger.info("BS worker run started.", { trigger: "http_get" });
    const result = await runBsWorker({ logger });
    logger.info("BS worker run finished.", { elapsedMs: result.elapsedMs });
    return res.status(200).json(result);
  } catch (err) {
    const msg = err?.message || String(err);
    logger.error("BS worker run failed.", { error: msg });
    return res.status(500).json({ ok: false, error: msg });
  } finally {
    isBsRunning = false;
  }
});

app.post("/bs/run-one", async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (isBsRunning) return res.status(409).json({ ok: false, error: "already_running", message: "Full BS worker run in progress." });
  const maxConcurrent = config.server.runOneMaxConcurrency || 5;
  if (bsRunOneCount >= maxConcurrent) {
    res.setHeader("Retry-After", "30");
    return res.status(503).json({ ok: false, error: "too_many_concurrent", message: "Max concurrent bs-run-one reached; retry later." });
  }
  bsRunOneCount += 1;
  try {
    const result = await runBsOne({ logger, payload: req.body || {} });
    return res.status(200).json(result);
  } catch (err) {
    const msg = err?.message || String(err);
    logger.error("BS run-one failed.", { error: msg });
    return res.status(500).json({ ok: false, error: msg });
  } finally {
    bsRunOneCount -= 1;
  }
});

app.post("/webhook/bs-document-upload", async (req, res) => {
  if (!isAuthorized(req, req.body?.worker_secret)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (isBsRunning) return res.status(409).json({ ok: false, error: "already_running" });
  const maxConcurrent = config.server.runOneMaxConcurrency || 5;
  if (bsRunOneCount >= maxConcurrent) {
    res.setHeader("Retry-After", "30");
    return res.status(503).json({ ok: false, error: "too_many_concurrent" });
  }
  const payload = req.body || {};
  const docId = Number(payload.doc_id || payload.document_id || payload.id || 0);
  const targetKey = String(payload.target_key || "").trim();
  if (!docId) return res.status(400).json({ ok: false, error: "doc_id required" });
  if (bsInFlightDocs.has(docId)) {
    logger.info("Webhook bs-document-upload: duplicate ignored.", { doc_id: docId, runOneCount: bsRunOneCount });
    return res.status(200).json({ ok: true, message: "duplicate ignored" });
  }

  bsRunOneCount += 1;
  bsInFlightDocs.add(docId);
  const retryDelaysMs = [0, 1000, 2000, 2000];
  let lastError = null;
  let lastResult = null;
  try {
    for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
      if (attempt > 0) await sleep(retryDelaysMs[attempt]);
      try {
        lastResult = await runBsOne({ logger, payload: { doc_id: docId, target_key: targetKey || undefined } });
        const skip = lastResult?.result?.status === "skip" && (lastResult?.result?.reason === "no_attachment" || lastResult?.result?.reason === "attachment_not_found");
        if (!skip) return res.status(200).json(lastResult);
        lastError = new Error(`Transient: ${lastResult?.result?.reason}`);
      } catch (err) {
        lastError = err;
        const isRace = /not found/i.test(err?.message || "");
        if (!isRace || attempt === retryDelaysMs.length - 1) {
          return res.status(500).json({ ok: false, error: err?.message });
        }
      }
    }
    if (lastResult) return res.status(200).json(lastResult);
    return res.status(500).json({ ok: false, error: lastError?.message });
  } finally {
    bsRunOneCount -= 1;
    bsInFlightDocs.delete(docId);
  }
});

app.post("/webhook/bs-document-delete", async (req, res) => {
  if (!isAuthorized(req, req.body?.worker_secret)) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const result = await handleBsDocumentDelete(logger, req.body || {});
    if (result.error === "missing_doc_id") return res.status(400).json(result);
    return res.status(200).json(result);
  } catch (err) {
    const msg = err?.message || String(err);
    logger.error("BS webhook document-delete failed.", { error: msg });
    return res.status(500).json({ ok: false, error: msg });
  }
});

app.post("/webhook/bs-chatter-message", async (req, res) => {
  if (!isAuthorized(req, req.body?.worker_secret)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const maxConcurrent = config.server.runOneMaxConcurrency || 5;
  if (bsRunOneCount >= maxConcurrent) {
    res.setHeader("Retry-After", "30");
    return res.status(503).json({ ok: false, error: "too_many_concurrent" });
  }
  const payload = req.body || {};
  const docId = Number(payload.doc_id || payload.document_id || payload.id || 0);
  if (!docId) return res.status(400).json({ ok: false, error: "doc_id required" });

  bsRunOneCount += 1;
  try {
    const result = await runBsOne({
      logger,
      payload: {
        doc_id: docId,
        target_key: payload.target_key || undefined,
        message_body: payload.message_body || ""
      }
    });
    return res.status(200).json(result);
  } catch (err) {
    const msg = err?.message || String(err);
    logger.error("BS webhook chatter-message failed.", { error: msg });
    return res.status(500).json({ ok: false, error: msg });
  } finally {
    bsRunOneCount -= 1;
  }
});

// ---------------------------------------------------------------------------

function start() {
  try {
    validateConfig();
  } catch (err) {
    logger.error("Config validation failed.", { error: err.message });
    // Optional: exit gracefully if config is invalid, depending on desired behavior
    // process.exit(1); 
  }
  app.listen(config.server.port, () => {
    logger.info("Server started.", { port: config.server.port });
  });
}

start();
