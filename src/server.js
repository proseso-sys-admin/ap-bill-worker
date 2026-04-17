const express = require("express");
const { config, validateConfig } = require("./config");
const { createLogger } = require("./logger");
const { sleep } = require("./utils");
const { runWorker, runOne, listApDocuments, collectFeedback, handleDocumentDelete, getTargetsFromOdoo } = require("./worker");
const { runBsWorker, runBsOne, handleBsDocumentDelete } = require("./bs-worker");
const { OdooClient } = require("./odoo");
const { attachWebhookRoutes } = require("./webhookRoutes");

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
    "/collect-feedback",
    "/webhook/document-upload/:slug", "/webhook/document-delete/:slug", "/webhook/chatter-message/:slug",
    "/bs/run", "/bs/run-one",
    "/webhook/bs-document-upload/:slug", "/webhook/bs-document-delete/:slug", "/webhook/bs-chatter-message/:slug"
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
  const { getRoutingSummary, getTargetsFromOdoo } = require("./worker");
  try {
    const routingSummary = await getRoutingSummary(logger);
    const targets = await getTargetsFromOdoo(logger);
    if (!targets.length) return res.json({ ok: false, error: "no targets loaded from Odoo", routingSummary });
    const target = targets[0];
    const odoo = new OdooClient(target.targetCfg);
    const companyId = target.companyId;
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
      target: target.targetCfg.baseUrl,
      db: target.targetCfg.db,
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

// Old secret-in-URL webhook routes removed. See attachWebhookRoutes() below
// for the tenant-aware /webhook/<type>/:slug endpoints that replaced them.

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

// Old BS secret-in-URL webhook routes removed. See attachWebhookRoutes() below
// for the tenant-aware /webhook/bs-<type>/:slug endpoints that replaced them.

// ---------------------------------------------------------------------------
// Tenant-aware webhook routes: /webhook/<type>/:slug
// Authenticated via Odoo-callback verification (no URL secret).
// ---------------------------------------------------------------------------

function toInt(v, f) { const n = Number.parseInt(String(v ?? ""), 10); return Number.isFinite(n) ? n : f; }

attachWebhookRoutes(app, {
  getTargets: getTargetsFromOdoo,
  makeClient: (targetCfg) => new OdooClient(targetCfg),
  logger,
  limiterOpts: {
    ratePerMinute: toInt(process.env.WEBHOOK_RATE_LIMIT_PER_MIN, 60),
    burst: toInt(process.env.WEBHOOK_RATE_LIMIT_BURST, 60)
  },
  handlers: {
    onDocumentUpload: async ({ target, payload, logger: log }) => {
      if (isRunning) { const e = new Error("already_running"); e.status = 409; throw e; }
      const maxConcurrent = config.server.runOneMaxConcurrency || 5;
      if (runOneCount >= maxConcurrent) { const e = new Error("too_many_concurrent"); e.status = 503; throw e; }
      const docId = Number(payload.doc_id || 0);
      const attachmentId = Number(payload.attachment_id || 0);
      if (!docId && !attachmentId) { const e = new Error("doc_id or attachment_id required"); e.status = 400; throw e; }
      if (inFlightDocs.has(docId)) return { ok: true, message: "duplicate ignored" };
      runOneCount += 1;
      inFlightDocs.add(docId);
      const retryDelaysMs = [0, 1000, 2000, 2000];
      let lastResult = null;
      let lastError = null;
      try {
        for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
          if (attempt > 0) await sleep(retryDelaysMs[attempt]);
          try {
            lastResult = await runOne({ logger: log, payload: { doc_id: docId, attachment_id: attachmentId, target_key: target.targetKey } });
            const skipReason = lastResult?.result?.reason;
            const skip = lastResult?.result?.status === "skip" && (skipReason === "no_attachment" || skipReason === "attachment_not_found");
            if (!skip) return lastResult;
            lastError = new Error(`Transient: ${skipReason}`);
          } catch (err) {
            lastError = err;
            const msg = err?.message || String(err);
            const isRace = /document not found|not found for attachment_id/i.test(msg);
            if (!isRace || attempt === retryDelaysMs.length - 1) throw err;
          }
        }
        if (lastResult) return lastResult;
        throw lastError || new Error("retries_exhausted");
      } finally {
        runOneCount -= 1;
        inFlightDocs.delete(docId);
      }
    },
    onDocumentDelete: async ({ target, payload, logger: log }) => {
      const result = await handleDocumentDelete(log, { ...payload, target_key: target.targetKey });
      if (result.error === "missing_doc_id") { const e = new Error(result.error); e.status = 400; throw e; }
      if (result.ok === false && result.error) {
        const e = new Error(result.error);
        e.status = result.error === "bill_not_draft" ? 409 : 404;
        throw e;
      }
      return result;
    },
    onChatterMessage: async ({ target, payload, logger: log }) => {
      const maxConcurrent = config.server.runOneMaxConcurrency || 5;
      if (runOneCount >= maxConcurrent) { const e = new Error("too_many_concurrent"); e.status = 503; throw e; }
      const docId = Number(payload.doc_id || payload.res_id || 0);
      if (!docId) { const e = new Error("doc_id required"); e.status = 400; throw e; }
      runOneCount += 1;
      try {
        return await runOne({
          logger: log,
          payload: {
            doc_id: docId,
            target_key: target.targetKey,
            message_body: payload.message_body || payload.body || ""
          }
        });
      } finally {
        runOneCount -= 1;
      }
    },
    onBsDocumentUpload: async ({ target, payload, logger: log }) => {
      if (isBsRunning) { const e = new Error("already_running"); e.status = 409; throw e; }
      const maxConcurrent = config.server.runOneMaxConcurrency || 5;
      if (bsRunOneCount >= maxConcurrent) { const e = new Error("too_many_concurrent"); e.status = 503; throw e; }
      const docId = Number(payload.doc_id || 0);
      if (!docId) { const e = new Error("doc_id required"); e.status = 400; throw e; }
      if (bsInFlightDocs.has(docId)) return { ok: true, message: "duplicate ignored" };
      bsRunOneCount += 1;
      bsInFlightDocs.add(docId);
      const retryDelaysMs = [0, 1000, 2000, 2000];
      let lastResult = null;
      let lastError = null;
      try {
        for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
          if (attempt > 0) await sleep(retryDelaysMs[attempt]);
          try {
            lastResult = await runBsOne({ logger: log, payload: { doc_id: docId, target_key: target.targetKey } });
            const skipReason = lastResult?.result?.reason;
            const skip = lastResult?.result?.status === "skip" && (skipReason === "no_attachment" || skipReason === "attachment_not_found");
            if (!skip) return lastResult;
            lastError = new Error(`Transient: ${skipReason}`);
          } catch (err) {
            lastError = err;
            const isRace = /not found/i.test(err?.message || "");
            if (!isRace || attempt === retryDelaysMs.length - 1) throw err;
          }
        }
        if (lastResult) return lastResult;
        throw lastError || new Error("retries_exhausted");
      } finally {
        bsRunOneCount -= 1;
        bsInFlightDocs.delete(docId);
      }
    },
    onBsDocumentDelete: async ({ target, payload, logger: log }) => {
      const result = await handleBsDocumentDelete(log, { ...payload, target_key: target.targetKey });
      if (result.error === "missing_doc_id") { const e = new Error(result.error); e.status = 400; throw e; }
      return result;
    },
    onBsChatterMessage: async ({ target, payload, logger: log }) => {
      const maxConcurrent = config.server.runOneMaxConcurrency || 5;
      if (bsRunOneCount >= maxConcurrent) { const e = new Error("too_many_concurrent"); e.status = 503; throw e; }
      const docId = Number(payload.doc_id || payload.res_id || 0);
      if (!docId) { const e = new Error("doc_id required"); e.status = 400; throw e; }
      bsRunOneCount += 1;
      try {
        return await runBsOne({
          logger: log,
          payload: {
            doc_id: docId,
            target_key: target.targetKey,
            message_body: payload.message_body || payload.body || ""
          }
        });
      } finally {
        bsRunOneCount -= 1;
      }
    }
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
