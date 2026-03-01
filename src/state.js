const { readJsonObject, writeJsonObject } = require("./gcs");

function stateObjectName(config, targetKey) {
  return `${config.gcs.statePrefix}/${encodeURIComponent(targetKey)}.json`;
}

async function loadState(config, targetKey) {
  if (!config.gcs.stateBucket) return { last_doc_id: 0 };
  return readJsonObject(config.gcs.stateBucket, stateObjectName(config, targetKey), {
    last_doc_id: 0
  });
}

async function saveState(config, targetKey, state) {
  if (!config.gcs.stateBucket) return;
  await writeJsonObject(config.gcs.stateBucket, stateObjectName(config, targetKey), state || {});
}

const docBillMappingObjectName = (config) =>
  `${config.gcs.docBillMappingPrefix || "AP_DOC_BILL_MAPPING_V1"}/mapping.json`;

function accountingConfigObjectName(config, targetKey) {
  const prefix = config.gcs.accountingConfigPrefix || "AP_ACCOUNTING_CONFIG";
  return `${prefix}/${encodeURIComponent(targetKey)}.json`;
}

const odooFieldNamesObjectName = (config) =>
  `${config.gcs.statePrefix || "AP_BILL_STATE_V1"}/odoo_field_names.json`;

/** Load Odoo General task field name overrides from GCS. Returns {} if bucket unset or file missing. */
async function loadOdooFieldNamesFromGcs(config) {
  const bucket = config.gcs.stateBucket || config.gcs.bucket;
  if (!bucket) return {};
  const raw = await readJsonObject(bucket, odooFieldNamesObjectName(config), null);
  if (!raw || typeof raw !== "object") return {};
  return raw;
}

/** Save Odoo General task field name overrides to GCS. Keys match config.odooDefaults (e.g. sourceGeneralTaskApFolderField). */
async function saveOdooFieldNamesToGcs(config, payload) {
  const bucket = config.gcs.stateBucket || config.gcs.bucket;
  if (!bucket || !payload || typeof payload !== "object") return;
  await writeJsonObject(bucket, odooFieldNamesObjectName(config), payload);
}

async function loadAccountingConfigCache(config, targetKey) {
  if (!config.gcs.stateBucket) return null;
  const raw = await readJsonObject(config.gcs.stateBucket, accountingConfigObjectName(config, targetKey), null);
  if (!raw || typeof raw !== "object") return null;
  const ttlMs = (config.accountingConfigCacheTtlMinutes || 0) * 60 * 1000;
  if (ttlMs > 0 && raw.fetched_at) {
    if (Date.now() - new Date(raw.fetched_at).getTime() > ttlMs) return null;
  }
  return {
    apFolderId: Number(raw.apFolderId || 0),
    apFolderParent: String(raw.apFolderParent || "").trim(),
    purchaseJournalId: Number(raw.purchaseJournalId || 0)
  };
}

async function saveAccountingConfigCache(config, targetKey, accounting) {
  if (!config.gcs.stateBucket || !accounting) return;
  const payload = {
    fetched_at: new Date().toISOString(),
    apFolderId: Number(accounting.apFolderId || 0),
    apFolderParent: String(accounting.apFolderParent || "").trim(),
    purchaseJournalId: Number(accounting.purchaseJournalId || 0)
  };
  await writeJsonObject(config.gcs.stateBucket, accountingConfigObjectName(config, targetKey), payload);
}

async function getDocBillEntry(config, docId) {
  if (!config.gcs.stateBucket) return null;
  const map = await readJsonObject(config.gcs.stateBucket, docBillMappingObjectName(config), {});
  return map[String(docId)] || null;
}

async function persistDocBillMapping(config, docId, billId, targetKey) {
  if (!config.gcs.stateBucket) return;
  const map = await readJsonObject(config.gcs.stateBucket, docBillMappingObjectName(config), {});
  map[String(docId)] = { bill_id: Number(billId), target_key: String(targetKey || "").trim() };
  await writeJsonObject(config.gcs.stateBucket, docBillMappingObjectName(config), map);
}

async function removeDocBillEntry(config, docId) {
  if (!config.gcs.stateBucket) return;
  const map = await readJsonObject(config.gcs.stateBucket, docBillMappingObjectName(config), {});
  delete map[String(docId)];
  await writeJsonObject(config.gcs.stateBucket, docBillMappingObjectName(config), map);
}

module.exports = {
  loadState,
  saveState,
  getDocBillEntry,
  persistDocBillMapping,
  removeDocBillEntry,
  loadAccountingConfigCache,
  saveAccountingConfigCache,
  loadOdooFieldNamesFromGcs,
  saveOdooFieldNamesToGcs,
  odooFieldNamesObjectName
};
