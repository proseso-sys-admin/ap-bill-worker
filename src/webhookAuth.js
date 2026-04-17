async function verifyWebhookTenant({ slug, model, id, getTargets, makeClient, logger, requireRecord = true }) {
  const s = String(slug || "").trim();
  const m = String(model || "").trim();
  const recordId = Number(id);

  if (!s || !m || !Number.isFinite(recordId) || recordId <= 0) {
    return { ok: false, status: 400, reason: "invalid_input" };
  }

  let targets;
  try {
    targets = await getTargets(logger);
  } catch (err) {
    logger?.error?.("verifyWebhookTenant: getTargets failed.", { error: err?.message || String(err) });
    return { ok: false, status: 502, reason: "targets_unavailable" };
  }

  const target = (targets || []).find((t) => String(t?.targetCfg?.db || "") === s);
  if (!target) {
    logger?.info?.("verifyWebhookTenant: unknown tenant slug.", { slug: s });
    return { ok: false, status: 404, reason: "unknown_tenant" };
  }

  // Delete webhooks (on_unlink) fire AFTER the record is gone, so record-existence check
  // would always 404. For those paths callers pass requireRecord=false and we rely on the
  // tenant slug + rate limit as the auth signal.
  if (!requireRecord) {
    return { ok: true, target };
  }

  let client;
  try {
    client = makeClient(target.targetCfg);
  } catch (err) {
    logger?.error?.("verifyWebhookTenant: client construction failed.", { slug: s, error: err?.message || String(err) });
    return { ok: false, status: 502, reason: "odoo_error" };
  }

  let rows;
  try {
    rows = await client.searchRead(m, [["id", "=", recordId]], ["id"], { limit: 1 });
  } catch (err) {
    logger?.warn?.("verifyWebhookTenant: Odoo searchRead failed.", { slug: s, model: m, id: recordId, error: err?.message || String(err) });
    return { ok: false, status: 502, reason: "odoo_error" };
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, status: 404, reason: "record_not_found" };
  }

  return { ok: true, target };
}

module.exports = { verifyWebhookTenant };
