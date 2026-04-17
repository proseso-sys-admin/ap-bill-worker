const { verifyWebhookTenant } = require("./webhookAuth");
const { createRateLimiter } = require("./rateLimiter");

function normalizePayload(body, targetKey) {
  const src = body || {};
  const docId = Number(src._id || src.id || src.doc_id || src.document_id || 0);
  return {
    ...src,
    doc_id: docId,
    target_key: targetKey
  };
}

function makeWebhookMiddleware({ getTargets, makeClient, logger, limiter, requireRecord = true }) {
  return async function webhookAuthMiddleware(req, res, next) {
    const slug = String(req.params.slug || "").trim();
    const body = req.body || {};
    const model = String(body._model || body.model || "").trim();
    const id = Number(body._id || body.id || 0);

    if (!slug || !model || !Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_input" });
    }

    const gate = limiter.tryAcquire(slug);
    if (!gate.allowed) {
      res.setHeader("Retry-After", String(gate.retryAfterSec));
      return res.status(429).json({ ok: false, error: "rate_limited" });
    }

    try {
      const verdict = await verifyWebhookTenant({
        slug, model, id, getTargets, makeClient, logger, requireRecord
      });
      if (!verdict.ok) {
        return res.status(verdict.status).json({ ok: false, error: verdict.reason });
      }
      req.verifiedTarget = verdict.target;
      req.verifiedPayload = normalizePayload(body, verdict.target.targetKey);
      return next();
    } catch (err) {
      logger?.error?.("webhookAuthMiddleware unexpected error.", { error: err?.message || String(err) });
      return res.status(500).json({ ok: false, error: "internal" });
    }
  };
}

function wrapHandler(handler, logger) {
  return async function routeHandler(req, res) {
    try {
      const result = await handler({
        target: req.verifiedTarget,
        payload: req.verifiedPayload,
        body: req.body,
        logger
      });
      return res.status(200).json(result);
    } catch (err) {
      const msg = err?.message || String(err);
      logger?.error?.("webhook handler failed.", { error: msg, path: req.path });
      return res.status(500).json({ ok: false, error: msg });
    }
  };
}

function attachWebhookRoutes(app, {
  getTargets,
  makeClient,
  logger,
  handlers,
  limiterOpts = { ratePerMinute: 60 }
}) {
  const limiter = createRateLimiter(limiterOpts);
  const authRecord = makeWebhookMiddleware({ getTargets, makeClient, logger, limiter, requireRecord: true });
  const authTenantOnly = makeWebhookMiddleware({ getTargets, makeClient, logger, limiter, requireRecord: false });

  app.post("/webhook/document-upload/:slug", authRecord, wrapHandler(handlers.onDocumentUpload, logger));
  app.post("/webhook/document-delete/:slug", authTenantOnly, wrapHandler(handlers.onDocumentDelete, logger));
  app.post("/webhook/chatter-message/:slug", authRecord, wrapHandler(handlers.onChatterMessage, logger));
  app.post("/webhook/bs-document-upload/:slug", authRecord, wrapHandler(handlers.onBsDocumentUpload, logger));
  app.post("/webhook/bs-document-delete/:slug", authTenantOnly, wrapHandler(handlers.onBsDocumentDelete, logger));
  app.post("/webhook/bs-chatter-message/:slug", authRecord, wrapHandler(handlers.onBsChatterMessage, logger));
}

module.exports = {
  attachWebhookRoutes,
  makeWebhookMiddleware,
  normalizePayload
};
