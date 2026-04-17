async function verifyWebhookTenant({ slug, model, id, getTargets, makeClient, logger }) {
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

  let client;
  try {
    client = makeClient(target.targetCfg);
  } catch (err) {
    logger?.error?.("verifyWebhookTenant: client construction failed.", { slug: s, error: err?.message || String(err) });
    return { ok: false, status: 502, reason: "odoo_error" };
  }

  let rows;
  try {
    rows = await client.read(m, [recordId], ["id"]);
  } catch (err) {
    logger?.warn?.("verifyWebhookTenant: Odoo read failed.", { slug: s, model: m, id: recordId, error: err?.message || String(err) });
    return { ok: false, status: 502, reason: "odoo_error" };
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, status: 404, reason: "record_not_found" };
  }

  return { ok: true, target };
}

module.exports = { verifyWebhookTenant };
