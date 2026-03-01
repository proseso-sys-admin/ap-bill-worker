const { google } = require("googleapis");
const { normalizeOdooBaseUrl, toNumber } = require("./utils");

function toBoolean(value) {
  const x = String(value || "").trim().toLowerCase();
  return x === "1" || x === "true" || x === "yes" || x === "y";
}

function rowToObject(headers, row) {
  const out = {};
  headers.forEach((h, idx) => {
    out[h] = row[idx] ?? "";
  });
  return out;
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  return google.sheets({ version: "v4", auth });
}

async function readSheetValues(spreadsheetId, range) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

/** Returns { pass: boolean, reason?: string } for debugging why a row is rejected. */
function getRoutingRowValidation(row) {
  const enabled = toBoolean(row.enabled);
  if (!enabled) return { pass: false, reason: "enabled is not true/1/yes/y" };
  const targetBaseUrl = normalizeOdooBaseUrl(row.target_base_url);
  const targetDb = String(row.target_db || "").trim();
  const targetLogin = String(row.target_login || "").trim();
  const targetPassword = String(row.target_password || "").trim();
  const targetCompanyId = toNumber(row.target_company_id, 0);
  if (!targetBaseUrl) return { pass: false, reason: "target_base_url empty" };
  if (!targetDb) return { pass: false, reason: "target_db empty" };
  if (!targetLogin) return { pass: false, reason: "target_login empty" };
  if (!targetPassword) return { pass: false, reason: "target_password empty" };
  if (!targetCompanyId) return { pass: false, reason: "target_company_id missing or zero" };
  return { pass: true };
}

function toRoutingRowStrict(row) {
  const { pass } = getRoutingRowValidation(row);
  if (!pass) return null;
  const enabled = toBoolean(row.enabled);
  const targetBaseUrl = normalizeOdooBaseUrl(row.target_base_url);
  const targetDb = String(row.target_db || "").trim();
  const targetLogin = String(row.target_login || "").trim();
  const targetPassword = String(row.target_password || "").trim();
  const targetCompanyId = toNumber(row.target_company_id, 0);

  return {
    enabled,
    source_project_id: toNumber(row.source_project_id, 0),
    target_base_url: targetBaseUrl,
    target_db: targetDb,
    target_login: targetLogin,
    target_password: targetPassword,
    target_company_id: targetCompanyId,
    ap_folder_id: toNumber(row.ap_folder_id, 0),
    ap_folder_parent: String(row.ap_folder_parent ?? "").trim() || undefined,
    purchase_journal_id: toNumber(row.purchase_journal_id, 0),
    industry: String(row.industry || "").trim()
  };
}

async function loadRoutingSheetData(config) {
  const range = `${config.routing.routingSheetName}!A:ZZ`;
  const values = await readSheetValues(config.routing.spreadsheetId, range);
  if (!values.length) return { headers: [], rows: [] };
  const [headerRow, ...dataRows] = values;
  const headers = headerRow.map((h) => String(h || "").trim().toLowerCase());
  const rows = dataRows.map((r) => rowToObject(headers, r));
  return { headers, rows };
}

function indexToColLetter(idx) {
  let result = "";
  let n = idx;
  do {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return result;
}

async function saveRoutingSheetData(config, headers, rows) {
  if (config.routing?.source === "odoo") return;
  const vatCols = [
    "purchase_journal_id", "ap_folder_id", "industry"
  ];
  const sheets = await getSheetsClient();
  const baseRange = config.routing.routingSheetName;
  for (const col of vatCols) {
    const idx = headers.indexOf(col);
    if (idx < 0) continue;
    const colLetter = indexToColLetter(idx);
    const range = `${baseRange}!${colLetter}1:${colLetter}${rows.length + 1}`;
    const values = [[col], ...rows.map((row) => [row[col] ?? ""])];
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.routing.spreadsheetId,
      range,
      valueInputOption: "RAW",
      requestBody: { values }
    });
  }
}

async function loadRawRoutingRows(config) {
  const { rows } = await loadRoutingSheetData(config);
  return rows;
}

async function loadRoutingRows(config) {
  const raw = await loadRawRoutingRows(config);
  return raw.map(toRoutingRowStrict).filter(Boolean);
}

async function loadAccountMapping(config) {
  const sheetName = config.routing.accountMappingSheetName;
  if (!sheetName || !config.routing.spreadsheetId) return [];
  try {
    const range = `${sheetName}!A:ZZ`;
    const values = await readSheetValues(config.routing.spreadsheetId, range);
    if (!values.length) return [];
    const [headerRow, ...dataRows] = values;
    const headers = headerRow.map((h) => String(h || "").trim().toLowerCase());
    const rows = dataRows.map((r) => rowToObject(headers, r));
    return rows
      .filter((r) => r.category && r.account_id)
      .map((r) => ({
        targetDb: String(r.target_db || "").trim().toLowerCase(),
        companyId: toNumber(r.company_id, 0),
        category: String(r.category || "").trim().toLowerCase(),
        accountId: toNumber(r.account_id, 0),
        accountName: String(r.account_name || "").trim()
      }))
      .filter((r) => r.accountId && (r.companyId || r.targetDb));
  } catch (_err) {
    return [];
  }
}

module.exports = {
  loadRoutingRows,
  loadRawRoutingRows,
  loadRoutingSheetData,
  saveRoutingSheetData,
  toRoutingRowStrict,
  getRoutingRowValidation,
  loadAccountMapping
};
