// @ts-nocheck
const { config } = require("./config");
const { OdooClient, kwWithCompany } = require("./odoo");
const { m2oId, normalizeOdooBaseUrl, deriveDbFromBaseUrl, isFalsyOdooValue, sleep } = require("./utils");
const { loadBsState, saveBsState, persistBsDocMapping, getBsDocEntry, removeBsDocEntry, loadOdooFieldNamesFromGcs } = require("./state");
const { detectFormat, parseStructured } = require("./bs-parsers");
const { extractBankStatementWithGemini, parseChatterHint } = require("./bs-gemini");
const { matchBankJournal } = require("./bs-journal");
const { validateExtraction, checkDuplicate, checkContinuity, fmtNum } = require("./bs-validation");
const { reconcileStatementLines } = require("./bs-reconcile");
const { makeProcessedMarker, isProcessed, appendMarker } = require("./markers");

const BS_DOC_FIELDS = ["id", "name", "folder_id", "attachment_id", "create_uid"];

function outOfTime(startMs) {
  return Date.now() - startMs > config.budget.runBudgetMs - config.budget.reserveMs;
}

// ---------------------------------------------------------------------------
// Target loading (reuses source Odoo routing but filters by BS worker field)
// ---------------------------------------------------------------------------

async function getBsTargetsFromOdoo(logger) {
  const src = config.odooDefaults;
  const baseUrl = normalizeOdooBaseUrl(src.sourceBaseUrl);
  const db = String(src.sourceDb || "").trim();
  const login = String(src.sourceLogin || "").trim();
  const password = String(src.sourcePassword || "").trim();
  if (!baseUrl || !db || !login || !password) {
    throw new Error("Odoo routing requires SOURCE_BASE_URL, SOURCE_DB, SOURCE_LOGIN, SOURCE_PASSWORD");
  }
  const odoo = new OdooClient({ baseUrl, db, login, password });

  const dbField = src.sourceGeneralTaskDbField;
  const enabledField = src.sourceGeneralTaskEnabledField;
  const bsWorkerField = config.bankStatement.bsWorkerField;
  const multiCompanyField = src.sourceGeneralTaskMultiCompanyField;
  const companyIdField = src.sourceGeneralTaskCompanyIdField;
  const emailField = src.sourceGeneralTaskEmailField;
  const passwordField = src.sourceGeneralTaskPasswordField;
  const stageName = src.sourceGeneralTaskStageName || "General";

  const gcsFields = await loadOdooFieldNamesFromGcs(config);
  const g = (key) => (gcsFields[key] != null && String(gcsFields[key]).trim() !== "" ? String(gcsFields[key]).trim() : src[key]);
  const bsFolderField = g("sourceGeneralTaskBsFolderField") || config.bankStatement.bsFolderField;

  const baseFields = ["id", "project_id", dbField];
  for (const f of [enabledField, bsWorkerField, multiCompanyField, companyIdField, emailField, passwordField]) {
    if (f && !baseFields.includes(f)) baseFields.push(f);
  }
  const fieldsWithFolder = [...baseFields];
  if (bsFolderField && !fieldsWithFolder.includes(bsFolderField)) fieldsWithFolder.push(bsFolderField);

  const domain = [["stage_id.name", "=", stageName]];
  const tasksLimit = Math.max(1, config.routing?.odooTasksLimit ?? 500);

  let tasks = [];
  try {
    tasks = await odoo.searchRead("project.task", domain, fieldsWithFolder, { limit: tasksLimit });
  } catch (err) {
    const msg = String(err?.message || err).toLowerCase();
    if (msg.includes("invalid field") && bsFolderField) {
      try {
        tasks = await odoo.searchRead("project.task", domain, baseFields, { limit: tasksLimit });
        logger.info("getBsTargetsFromOdoo: loaded without optional BS folder field.", { field: bsFolderField });
      } catch (err2) {
        logger.warn("getBsTargetsFromOdoo: search_read failed.", { error: err2?.message || String(err2) });
        return [];
      }
    } else {
      logger.warn("getBsTargetsFromOdoo: search_read failed.", { error: err?.message || String(err) });
      return [];
    }
  }

  const toBool = (v) => v === true || v === 1 || String(v || "").toLowerCase() === "true" || String(v || "").trim() === "1";
  const targets = [];

  for (const task of tasks) {
    if (enabledField && !toBool(task[enabledField])) continue;
    if (bsWorkerField && !toBool(task[bsWorkerField])) continue;

    const rawDb = (task[dbField] != null && task[dbField] !== false)
      ? (Array.isArray(task[dbField]) ? task[dbField][1] || task[dbField][0] : task[dbField])
      : "";
    const targetDbRaw = String(rawDb || "").trim();
    if (!targetDbRaw) continue;

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

    const taskEmail = (emailField && task[emailField] != null) ? String(task[emailField] || "").trim() : "";
    const taskApiKey = (passwordField && task[passwordField] != null) ? String(task[passwordField] || "").trim() : "";
    if (!taskEmail || !taskApiKey) continue;

    const bsFolderId = bsFolderField ? m2oId(task[bsFolderField]) : 0;
    const targetKey = [normalizeOdooBaseUrl(targetBaseUrl), targetDb, String(taskEmail).toLowerCase(), String(companyId)].join("|");

    targets.push({
      targetKey,
      targetCfg: { baseUrl: targetBaseUrl, db: targetDb, login: taskEmail, password: taskApiKey },
      companyId,
      bsFolderId
    });
  }

  logger.info("getBsTargetsFromOdoo: loaded targets.", { count: targets.length });
  return targets;
}

// ---------------------------------------------------------------------------
// Batch run: process all targets
// ---------------------------------------------------------------------------

async function runBsWorker({ logger, payload = {} }) {
  const startMs = Date.now();
  const targets = await getBsTargetsFromOdoo(logger);
  if (!targets.length) return { ok: true, mode: "bs-run", targets: 0, processed: 0, elapsedMs: Date.now() - startMs };

  const parallel = config.server.runWorkerTargetsParallel || 1;
  let totalProcessed = 0;
  const targetResults = [];

  for (let i = 0; i < targets.length; i += parallel) {
    if (outOfTime(startMs)) break;
    const batch = targets.slice(i, i + parallel);
    const batchResults = await Promise.allSettled(
      batch.map((t) => processBsTarget(t, startMs, logger))
    );
    for (const r of batchResults) {
      const val = r.status === "fulfilled" ? r.value : { targetKey: "?", error: r.reason?.message };
      targetResults.push(val);
      totalProcessed += val.processed || 0;
    }
  }

  return {
    ok: true,
    mode: "bs-run",
    targets: targets.length,
    processed: totalProcessed,
    elapsedMs: Date.now() - startMs,
    targetResults
  };
}

// ---------------------------------------------------------------------------
// Single-target processing
// ---------------------------------------------------------------------------

async function processBsTarget(target, startMs, logger) {
  const { targetKey, targetCfg, companyId, bsFolderId } = target;
  const odoo = new OdooClient(targetCfg);
  const tLogger = { ...logger, info: (m, d) => logger.info(m, { ...d, targetKey }), warn: (m, d) => logger.warn(m, { ...d, targetKey }), error: (m, d) => logger.error(m, { ...d, targetKey }) };

  try {
    await odoo.authenticate();
  } catch (err) {
    tLogger.error("BS: auth failed.", { error: err?.message });
    return { targetKey, processed: 0, error: err?.message };
  }

  const state = await loadBsState(config, targetKey);
  const lastDocId = state.last_doc_id || 0;

  // Find BS folder: only process documents in a folder whose name contains "bank"
  // (from task config or auto-detect). If none found, batch run skips this target.
  let folderId = bsFolderId;

  if (!folderId) {
    try {
      let folders = [];
      
      // Get ALL folders first, since case-insensitive search might be flaky on some Odoo versions
      try {
        folders = await odoo.searchRead(
          "documents.folder", [], ["id", "name", "parent_folder_id"],
          kwWithCompany(companyId, { limit: 200 })
        );
      } catch (err) {
        if (!err?.message?.includes("doesn't exist")) throw err;
      }
      
      if (folders && folders.length > 0) {
        // Try to find one named Bank Statement
        let preferred = folders.find((f) => /bank\s*statement/i.test(String(f.name || "")));
        
        // Next try just bank
        if (!preferred) {
          preferred = folders.find((f) => /bank/i.test(String(f.name || "")));
        }
        
        // Next try finance
        if (!preferred) {
          preferred = folders.find((f) => /finance/i.test(String(f.name || "")));
        }
        
        // Next try accounting
        if (!preferred) {
          preferred = folders.find((f) => /accounting/i.test(String(f.name || "")));
        }

        if (preferred) {
          folderId = preferred.id;
          tLogger.info("BS: using matching bank/finance folder.", { folderId, folderName: preferred.name });
        } else {
          tLogger.warn("BS: no folder with 'bank', 'finance' or 'accounting' in name — skipping batch scan for this target.");
        }
      } 
      
      if (!folderId) {
        // Fallback for newer Odoo versions where `documents.folder` is deprecated in favor of `documents.workspace`
        // But first check if it's because folders array was empty but `documents.folder` exists (like Odoo 16/17 where you might not have a matching folder)
        try {
          // Use folder_id
          const workspaces = await odoo.searchRead(
            "documents.document", [], ["folder_id"],
            kwWithCompany(companyId, { limit: 500 })
          );
          
          if (workspaces && workspaces.length > 0) {
            // we have to extract unique workspaces from the documents
            const workspaceMap = new Map();
            for (const doc of workspaces) {
              if (doc.folder_id && Array.isArray(doc.folder_id)) {
                workspaceMap.set(doc.folder_id[0], doc.folder_id[1]);
              }
            }
            
            const uniqueWorkspaces = Array.from(workspaceMap.entries()).map(([id, name]) => ({id, name}));
            
            let preferred = uniqueWorkspaces.find((w) => /bank\s*statement/i.test(String(w.name || "")));
            if (!preferred) preferred = uniqueWorkspaces.find((w) => /bank/i.test(String(w.name || "")));
            if (!preferred) preferred = uniqueWorkspaces.find((w) => /finance/i.test(String(w.name || "")));
            if (!preferred) preferred = uniqueWorkspaces.find((w) => /accounting/i.test(String(w.name || "")));
            if (!preferred && uniqueWorkspaces.length === 1) preferred = uniqueWorkspaces[0];
            
            if (preferred) {
              folderId = preferred.id;
              tLogger.info("BS: using matching bank/finance folder via document lookup.", { folderId, folderName: preferred.name });
            } else {
              tLogger.warn("BS: no folder with 'bank', 'finance' or 'accounting' in name — skipping batch scan for this target.");
            }
          } else {
            tLogger.warn("BS: no documents folders or workspaces found — skipping batch scan for this target.");
          }
        } catch (err) {
          tLogger.warn("BS: folder search via documents failed — skipping batch scan for this target.", { error: err?.message });
        }
      }
    } catch (err) { tLogger.warn("folder search failed", { error: err?.message }); }
  }

  if (!folderId) {
    return { targetKey, processed: 0, skipped: "no_bank_folder" };
  }

  // List candidate documents (only in the bank folder)
  const docDomain = [
    ["is_folder", "=", false],
    ["attachment_id", "!=", false]
  ];
  docDomain.push(["folder_id", "=", folderId]);

  let docs = [];
  try {
    let fieldsToFetch = [...BS_DOC_FIELDS];
    
    docs = await odoo.searchRead(
      "documents.document",
      docDomain,
      fieldsToFetch,
      kwWithCompany(companyId, { limit: 50, order: "id asc" })
    );
  } catch (err) {
    tLogger.warn("BS: failed to list documents.", { error: err?.message });
    return { targetKey, processed: 0, error: err?.message };
  }

  const newDocs = docs.filter((d) => d.id > lastDocId);
  let processed = 0;
  let maxDocId = lastDocId;

  for (const doc of newDocs) {
    if (outOfTime(startMs)) break;
    try {
      await processBsDocument({ odoo, companyId, targetKey, doc, logger: tLogger, config });
      processed += 1;
    } catch (err) {
      tLogger.error("BS: failed to process document.", { docId: doc.id, error: err?.message });
    }
    if (doc.id > maxDocId) maxDocId = doc.id;
  }

  if (maxDocId > lastDocId) {
    await saveBsState(config, targetKey, { last_doc_id: maxDocId });
  }

  return { targetKey, processed };
}

// ---------------------------------------------------------------------------
// Single-document run (webhook / run-one)
// ---------------------------------------------------------------------------

async function runBsOne({ logger, payload = {} }) {
  const docId = Number(payload.doc_id || payload.document_id || payload.id || 0);
  const targetKeyFilter = String(payload.target_key || "").trim();
  const messageBody = String(payload.message_body || "").trim();
  const isForce = /force/i.test(messageBody);
  const userHint = parseChatterHint(messageBody);

  if (!docId) throw new Error("doc_id required");

  const targets = await getBsTargetsFromOdoo(logger);
  let target = null;

  if (targetKeyFilter) {
    target = targets.find((t) => t.targetKey === targetKeyFilter);
  } else if (targets.length === 1) {
    target = targets[0];
  } else {
    // Try each target to find the doc
    for (const t of targets) {
      try {
        const odoo = new OdooClient(t.targetCfg);
        await odoo.authenticate();
        const docs = await odoo.searchRead("documents.document", [["id", "=", docId]], ["id"], kwWithCompany(t.companyId, { limit: 1 }));
        if (docs.length) { target = t; break; }
      } catch (_) { /* skip */ }
    }
  }

  if (!target) throw new Error(`No matching BS target found for doc_id ${docId}`);

  const { targetKey, targetCfg, companyId } = target;
  const odoo = new OdooClient(targetCfg);
  await odoo.authenticate();

  const docs = await odoo.searchRead(
    "documents.document", [["id", "=", docId]],
    BS_DOC_FIELDS,
    kwWithCompany(companyId, { limit: 1 })
  );
  if (!docs.length) throw new Error(`Document ${docId} not found.`);

  const doc = docs[0];
  const result = await processBsDocument({ odoo, companyId, targetKey, doc, logger, config, userHint, isForce });
  return { ok: true, mode: "bs-run-one", targetKey, docId, result };
}

// ---------------------------------------------------------------------------
// Core document processing pipeline
// ---------------------------------------------------------------------------

async function processBsDocument({ odoo, companyId, targetKey, doc, logger, config, userHint = "", isForce = false }) {
  const docId = doc.id;
  const attId = m2oId(doc.attachment_id);
  if (!attId) {
    logger.info("BS: skipping doc without attachment.", { docId });
    return { status: "skip", reason: "no_attachment" };
  }

  // Load attachment
  const attachments = await odoo.searchRead(
    "ir.attachment", [["id", "=", attId]],
    ["id", "name", "mimetype", "datas", "description"],
    kwWithCompany(companyId, { limit: 1 })
  );
  if (!attachments.length) {
    logger.info("BS: attachment not found.", { docId, attId });
    return { status: "skip", reason: "attachment_not_found" };
  }

  const attachment = attachments[0];
  const markerPrefix = config.bankStatement.processedMarkerPrefix;

  // Check processed marker (skip if already processed, unless force)
  if (!isForce && isProcessed(attachment.description, markerPrefix, targetKey, docId)) {
    logger.info("BS: already processed.", { docId });
    return { status: "skip", reason: "already_processed" };
  }

  const format = detectFormat(attachment.mimetype, attachment.name);
  if (!format) {
    await postChatter(odoo, companyId, docId, `<b>🤖 Bank Statement Bot:</b> Unsupported file format: ${attachment.mimetype || attachment.name}`);
    return { status: "error", reason: "unsupported_format" };
  }

  logger.info("BS: processing document.", { docId, format, name: attachment.name });

  // Extract data
  let extracted = null;
  if (format === "csv" || format === "excel" || format === "ofx") {
    const buffer = Buffer.from(attachment.datas || "", "base64");
    const parsed = parseStructured(buffer, format);
    if (parsed && parsed.transactions?.length) {
      extracted = {
        bank_name: parsed.metadata?.bank_name || "",
        account_number: parsed.metadata?.account_number || "",
        statement_date_from: parsed.transactions[0]?.date || "",
        statement_date_to: parsed.transactions[parsed.transactions.length - 1]?.date || "",
        opening_balance: null,
        closing_balance: parsed.metadata?.closing_balance ?? null,
        currency: parsed.metadata?.currency || "",
        transactions: parsed.transactions,
        warnings: []
      };
    }
  }

  if (!extracted || !extracted.transactions?.length) {
    // Fall back to Gemini extraction (for PDFs, images, or when structured parsing fails)
    try {
      extracted = await extractBankStatementWithGemini(config, attachment, userHint);
    } catch (err) {
      logger.error("BS: Gemini extraction failed.", { docId, error: err?.message });
      await postChatter(odoo, companyId, docId,
        `<b>🤖 Bank Statement Bot:</b> AI extraction failed: ${escHtml(err?.message || "Unknown error")}. Please try again with @bot retry.`
      );
      return { status: "error", reason: "extraction_failed", error: err?.message };
    }
  }

  // Validate
  const tolerance = config.bankStatement?.mathTolerancePercent ?? 0.5;
  const validation = validateExtraction(extracted, tolerance);

  if (!validation.valid) {
    const errorHtml = validation.errors.map((e) => `<li>${escHtml(e)}</li>`).join("");
    const warnHtml = validation.warnings.map((w) => `<li>${escHtml(w)}</li>`).join("");
    await postChatter(odoo, companyId, docId,
      `<b>🤖 Bank Statement Bot — Extraction Error:</b><ul>${errorHtml}</ul>` +
      (warnHtml ? `<b>Warnings:</b><ul>${warnHtml}</ul>` : "") +
      `<br/>Please upload a clearer file or use <b>@bot retry</b> with hints.`
    );
    return { status: "error", reason: "validation_failed", errors: validation.errors };
  }

  // Match journal
  let folderName = "";
  if (doc.folder_id) folderName = Array.isArray(doc.folder_id) ? doc.folder_id[1] : "";
  
  const journalResult = await matchBankJournal(odoo, companyId, extracted, {
    folderName,
    userHint,
    logger
  });

  if (!journalResult.journal) {
    await postChatter(odoo, companyId, docId,
      `<b>🤖 Bank Statement Bot — Journal Error:</b> ${escHtml(journalResult.error)}`
    );
    return { status: "error", reason: "no_journal", error: journalResult.error };
  }

  const journal = journalResult.journal;
  const journalId = journal.id;

  // Currency check
  if (extracted.currency && journal.currency_id) {
    const journalCurrency = Array.isArray(journal.currency_id) ? journal.currency_id[1] : "";
    if (journalCurrency && extracted.currency.toUpperCase() !== journalCurrency.toUpperCase()) {
      await postChatter(odoo, companyId, docId,
        `<b>🤖 Bank Statement Bot — Currency Mismatch:</b> Statement currency is ${escHtml(extracted.currency)} but journal "${escHtml(journal.name)}" uses ${escHtml(journalCurrency)}.`
      );
      return { status: "error", reason: "currency_mismatch" };
    }
  }

  // Duplicate check
  if (!isForce) {
    const dupeResult = await checkDuplicate(odoo, companyId, journalId, extracted);
    if (dupeResult.isDuplicate) {
      await postChatter(odoo, companyId, docId,
        `<b>🤖 Bank Statement Bot:</b> This statement (${escHtml(extracted.statement_date_from)} to ${escHtml(extracted.statement_date_to)}) appears to already be imported (${dupeResult.existingCount} lines). Use <b>@bot retry force</b> to override.`
      );
      return { status: "skip", reason: "duplicate", existingCount: dupeResult.existingCount };
    }
  }

  // Create the bank statement header first so lines are grouped under it.
  const statementDate = extracted.statement_date_to ||
                        extracted.statement_date_from ||
                        new Date().toISOString().slice(0, 10);
  let statementId = null;
  try {
    const stmtVals = {
      journal_id: journalId,
      date: statementDate,
      name: attachment.name || doc.name || `BS ${statementDate}`,
    };
    if (extracted.opening_balance != null) stmtVals.balance_start = extracted.opening_balance;
    if (extracted.closing_balance != null) stmtVals.balance_end_real = extracted.closing_balance;
    statementId = await odoo.create("account.bank.statement", stmtVals);
    logger.info("BS: created bank statement header.", { docId, statementId });
  } catch (err) {
    logger.warn("BS: failed to create bank statement header; lines will proceed without one.", { docId, error: err?.message });
  }

  // Import statement lines
  const lineIds = [];
  for (const txn of extracted.transactions) {
    try {
      const vals = {
        journal_id: journalId,
        date: txn.date || statementDate,
        amount: txn.amount || 0,
        payment_ref: txn.description || txn.reference || "Bank Transaction"
      };
      if (statementId) vals.statement_id = statementId;
      const lineId = await odoo.create("account.bank.statement.line", vals);
      lineIds.push(lineId);
    } catch (err) {
      logger.error("BS: failed to create statement line.", { docId, txn, error: err?.message });
    }
  }

  if (!lineIds.length) {
    await postChatter(odoo, companyId, docId,
      `<b>🤖 Bank Statement Bot:</b> Failed to import any transactions. Please check the file and try again.`
    );
    return { status: "error", reason: "import_failed" };
  }

  // Save mapping
  await persistBsDocMapping(config, docId, journalId, lineIds, targetKey, statementId);

  // Write processed marker
  const marker = makeProcessedMarker(markerPrefix, targetKey, docId, journalId, doc.name || "");
  const newDesc = appendMarker(attachment.description, marker);
  try {
    await odoo.write("ir.attachment", [attId], { description: newDesc });
  } catch (_) { /* non-critical */ }

  const oldDocName = String(doc.name || "document");
  const prefix = "[BS Imported] ";
  const newDocName = oldDocName.startsWith(prefix) ? oldDocName : `${prefix}${oldDocName}`;
  if (newDocName !== oldDocName) {
    try {
      await odoo.write("documents.document", [docId], { name: newDocName });
    } catch (renameErr) {
      logger.warn("Failed to rename BS document.", { docId, error: renameErr?.message });
    }
  }

  // Continuity check
  const continuity = await checkContinuity(odoo, companyId, journalId, extracted);

  // Auto-reconciliation
  let reconcileResult = { reconciled: 0, suggested: 0, unmatched: 0, details: [] };
  try {
    reconcileResult = await reconcileStatementLines(odoo, companyId, journalId, lineIds, config, logger);
  } catch (err) {
    logger.warn("BS: reconciliation failed (non-critical).", { docId, error: err?.message });
  }

  // Post success summary to chatter
  const txnCount = lineIds.length;
  const period = `${extracted.statement_date_from || "?"} to ${extracted.statement_date_to || "?"}`;
  const opening = extracted.opening_balance != null ? fmtNum(extracted.opening_balance) : "N/A";
  const closing = extracted.closing_balance != null ? fmtNum(extracted.closing_balance) : "N/A";
  const currency = extracted.currency || "";

  let summaryHtml = `<b>🤖 Bank Statement Bot — Import Successful</b><br/>`;
  summaryHtml += `Imported <b>${txnCount} transactions</b> (${escHtml(period)}) into <b>${escHtml(journal.name)}</b>.<br/>`;
  summaryHtml += `Opening: ${opening} / Closing: ${closing}${currency ? ` / Currency: ${escHtml(currency)}` : ""}<br/>`;
  summaryHtml += `Auto-reconciled: <b>${reconcileResult.reconciled}</b> | Needs review: <b>${reconcileResult.suggested + reconcileResult.unmatched}</b>`;

  if (continuity.hasGap) {
    summaryHtml += `<br/><br/><b>Warning:</b> ${escHtml(continuity.message)}`;
  }

  if (validation.warnings.length) {
    summaryHtml += `<br/><br/><b>Warnings:</b><ul>${validation.warnings.map((w) => `<li>${escHtml(w)}</li>`).join("")}</ul>`;
  }

  // Add reconciliation suggestions
  const suggestions = reconcileResult.details.filter((d) => d.status === "suggested");
  if (suggestions.length) {
    summaryHtml += `<br/><b>Reconciliation Suggestions:</b><ul>`;
    for (const s of suggestions.slice(0, 10)) {
      summaryHtml += `<li>"${escHtml(s.payment_ref)}" (${fmtNum(s.amount)}) may match ${escHtml(s.matched_moves)} — ${Math.round(s.confidence * 100)}% confidence</li>`;
    }
    if (suggestions.length > 10) summaryHtml += `<li>...and ${suggestions.length - 10} more</li>`;
    summaryHtml += `</ul>`;
  }

  await postChatter(odoo, companyId, docId, summaryHtml);

  logger.info("BS: document processed.", { docId, journalId, lines: txnCount, reconciled: reconcileResult.reconciled });
  return { status: "ok", lines: txnCount, journalId, reconciled: reconcileResult.reconciled };
}

// ---------------------------------------------------------------------------
// Document delete handler (webhook)
// ---------------------------------------------------------------------------

async function handleBsDocumentDelete(logger, payload) {
  const docId = Number(payload.doc_id || payload.document_id || payload.id || 0);
  if (!docId) return { ok: false, error: "missing_doc_id" };

  const entry = await getBsDocEntry(config, docId);
  if (!entry) return { ok: true, action: "no_mapping_found" };

  const targetKeyFilter = String(payload.target_key || entry.target_key || "").trim();
  const targets = await getBsTargetsFromOdoo(logger);
  const target = targets.find((t) => t.targetKey === targetKeyFilter) || targets[0];

  if (!target) return { ok: false, error: "target_not_found" };

  const odoo = new OdooClient(target.targetCfg);
  await odoo.authenticate();

  // Delete unreconciled statement lines
  const lineIds = entry.line_ids || [];
  if (lineIds.length) {
    const lines = await odoo.searchRead(
      "account.bank.statement.line",
      [["id", "in", lineIds]],
      ["id", "is_reconciled"],
      kwWithCompany(target.companyId)
    );
    const unreconciledIds = lines.filter((l) => !l.is_reconciled).map((l) => l.id);
    const reconciledIds = lines.filter((l) => l.is_reconciled).map((l) => l.id);

    if (unreconciledIds.length) {
      try {
        // Delete the underlying moves to remove statement lines
        const moves = await odoo.searchRead(
          "account.bank.statement.line",
          [["id", "in", unreconciledIds]],
          ["move_id"],
          kwWithCompany(target.companyId)
        );
        const moveIds = moves.map((m) => m2oId(m.move_id)).filter(Boolean);
        if (moveIds.length) {
          await odoo.executeKw("account.move", "button_draft", [moveIds], kwWithCompany(target.companyId));
          await odoo.executeKw("account.move", "unlink", [moveIds], kwWithCompany(target.companyId));
        }
      } catch (err) {
        logger.warn("BS delete: failed to remove statement lines.", { docId, error: err?.message });
      }
    }

    // Delete the parent statement header if all its lines were removed
    const statementId = entry.statement_id;
    if (statementId && !reconciledIds.length) {
      try {
        await odoo.executeKw("account.bank.statement", "unlink", [[statementId]], kwWithCompany(target.companyId));
      } catch (err) {
        logger.warn("BS delete: failed to remove bank statement header.", { docId, statementId, error: err?.message });
      }
    }

    await removeBsDocEntry(config, docId);
    return {
      ok: true,
      action: "deleted",
      deleted: unreconciledIds.length,
      kept_reconciled: reconciledIds.length
    };
  }

  await removeBsDocEntry(config, docId);
  return { ok: true, action: "mapping_cleared" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function postChatter(odoo, companyId, docId, htmlBody) {
  try {
    await odoo.executeKw("documents.document", "message_post", [[docId]], kwWithCompany(companyId, {
      body: htmlBody,
      message_type: "comment",
      subtype_xmlid: "mail.mt_note",
      body_is_html: true
    }));
  } catch (err) {
    // Non-critical: chatter post failure should not stop processing
  }
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = {
  runBsWorker,
  runBsOne,
  handleBsDocumentDelete,
  getBsTargetsFromOdoo
};
