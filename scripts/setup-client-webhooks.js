#!/usr/bin/env node
/**
 * Setup AP + BS webhook automation rules across all client Odoo databases.
 *
 * Reads routing config from proseso-ventures General Tasks (project.task rows
 * with x_studio_accounting_database set). For each client DB found, installs
 * 6 automation rules pointing at /webhook/<type>/<slug> on the worker.
 *
 * - Skips tenants whose rules already exist (idempotent). Use --force to
 *   delete + recreate.
 * - --dry-run previews actions without writing anything.
 * - Never writes to proseso-ventures (source). Never flips General Task flags.
 *
 * Env:
 *   SOURCE_LOGIN, SOURCE_API_KEY (required)
 *   SOURCE_URL (default https://proseso-ventures.odoo.com)
 *   SOURCE_DB  (default proseso-ventures)
 *   WORKER_BASE_URL (default https://ap-bill-ocr-worker-njiacix2yq-as.a.run.app)
 *
 * Usage:
 *   node scripts/setup-client-webhooks.js --list
 *   node scripts/setup-client-webhooks.js --slug klaro-ventures --dry-run
 *   node scripts/setup-client-webhooks.js --all [--dry-run] [--force] [--inactive]
 */

const { OdooClient } = require("../src/odoo");

const WORKER_BASE = process.env.WORKER_BASE_URL || "https://ap-bill-ocr-worker-njiacix2yq-as.a.run.app";
const SOURCE_URL = process.env.SOURCE_URL || "https://proseso-ventures.odoo.com";
const SOURCE_DB  = process.env.SOURCE_DB  || "proseso-ventures";

const RULE_SPECS = [
  {
    name: "AP Worker: Notify on document upload",
    model: "documents.document",
    trigger: "on_create_or_write",
    filter_domain: "[('folder_id.name', 'ilike', 'payable')]",
    filter_pre_domain: "[('folder_id.name', 'ilike', 'payable')]",
    webhook_path: "document-upload",
    fields: ["doc_id"]
  },
  {
    name: "AP Worker: Notify on document delete",
    model: "documents.document",
    trigger: "on_unlink",
    filter_domain: "[('folder_id.name', 'ilike', 'payable')]",
    filter_pre_domain: null,
    webhook_path: "document-delete",
    fields: ["doc_id"]
  },
  {
    name: "AP Bill Chatter Message (for @bot retry)",
    model: "mail.message",
    trigger: "on_create",
    filter_domain: "['&', ('model', '=', 'documents.document'), '|', '|', '|', ('body', 'ilike', '@bot'), ('body', 'ilike', '@ocr'), ('body', 'ilike', '@worker'), ('body', 'ilike', '@ai')]",
    filter_pre_domain: null,
    webhook_path: "chatter-message",
    fields: ["msg_id", "msg_res_id", "msg_model", "msg_body"]
  },
  {
    name: "Bank Statement Upload",
    model: "documents.document",
    trigger: "on_create_or_write",
    filter_domain: "[('folder_id.name', 'ilike', 'bank')]",
    filter_pre_domain: "[('folder_id.name', 'ilike', 'bank')]",
    webhook_path: "bs-document-upload",
    fields: ["doc_id"]
  },
  {
    name: "Bank Statement Delete",
    model: "documents.document",
    trigger: "on_unlink",
    filter_domain: "[('folder_id.name', 'ilike', 'bank')]",
    filter_pre_domain: null,
    webhook_path: "bs-document-delete",
    fields: ["doc_id"]
  },
  {
    name: "Bank Statement Chatter Message (for @bot retry)",
    model: "mail.message",
    trigger: "on_create",
    filter_domain: "['&', ('model', '=', 'documents.document'), '|', '|', '|', ('body', 'ilike', '@bot'), ('body', 'ilike', '@ocr'), ('body', 'ilike', '@worker'), ('body', 'ilike', '@ai')]",
    filter_pre_domain: null,
    webhook_path: "bs-chatter-message",
    fields: ["msg_id", "msg_res_id", "msg_model", "msg_body"]
  }
];

function parseArgs(argv) {
  const a = { list: false, all: false, slug: null, dryRun: false, force: false, active: true, includeSource: false };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--list") a.list = true;
    else if (v === "--all") a.all = true;
    else if (v === "--dry-run") a.dryRun = true;
    else if (v === "--force") a.force = true;
    else if (v === "--inactive") a.active = false;
    else if (v === "--include-source") a.includeSource = true;
    else if (v === "--slug") a.slug = String(argv[++i] || "").trim();
    else if (v.startsWith("--slug=")) a.slug = v.slice(7).trim();
    else throw new Error(`Unknown arg: ${v}`);
  }
  return a;
}

function extractSlug(accountingDbUrl) {
  const m = String(accountingDbUrl || "").match(/^https?:\/\/([^./]+)/i);
  return m ? m[1] : null;
}

async function loadClientTasks(src) {
  const rows = await src.searchRead(
    "project.task",
    [["x_studio_accounting_database", "!=", false]],
    ["id", "name", "project_id", "x_studio_accounting_database", "x_studio_email", "x_studio_api_key", "x_studio_enabled", "x_studio_odoo_bill_worker", "x_studio_odoo_bank_statement_worker"],
    { limit: 500 }
  );
  return rows
    .map((r) => {
      const url = String(r.x_studio_accounting_database || "").trim();
      const slug = extractSlug(url);
      return {
        taskId: r.id,
        project: Array.isArray(r.project_id) ? r.project_id[1] : String(r.project_id || ""),
        slug,
        url,
        login: String(r.x_studio_email || "").trim(),
        apiKey: String(r.x_studio_api_key || "").trim(),
        enabled: !!r.x_studio_enabled,
        billWorker: !!r.x_studio_odoo_bill_worker,
        bsWorker: !!r.x_studio_odoo_bank_statement_worker
      };
    })
    .filter((t) => t.slug && t.url && t.login && t.apiKey);
}

async function discoverFieldIds(client) {
  const rows = await client.searchRead(
    "ir.model.fields",
    ["|",
      "&", ["model", "=", "documents.document"], ["name", "=", "id"],
      "&", ["model", "=", "mail.message"], ["name", "in", ["id", "res_id", "model", "body"]]
    ],
    ["id", "model", "name"],
    { limit: 10 }
  );
  const find = (model, name) => {
    const r = rows.find((x) => x.model === model && x.name === name);
    return r ? r.id : null;
  };
  const ids = {
    doc_id: find("documents.document", "id"),
    msg_id: find("mail.message", "id"),
    msg_res_id: find("mail.message", "res_id"),
    msg_model: find("mail.message", "model"),
    msg_body: find("mail.message", "body")
  };
  const missing = Object.entries(ids).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Missing field ids: ${missing.join(", ")}`);
  return ids;
}

async function discoverModelIds(client) {
  const rows = await client.searchRead(
    "ir.model",
    [["model", "in", ["documents.document", "mail.message"]]],
    ["id", "model"],
    { limit: 5 }
  );
  const find = (m) => rows.find((x) => x.model === m)?.id;
  return { doc: find("documents.document"), msg: find("mail.message") };
}

async function findExistingRules(client) {
  const names = RULE_SPECS.map((s) => s.name);
  return await client.searchRead(
    "base.automation",
    [["name", "in", names]],
    ["id", "name", "action_server_ids"],
    { limit: 20 }
  );
}

async function installForTenant(task, opts) {
  const { dryRun, force, active } = opts;
  const result = { slug: task.slug, url: task.url, project: task.project, created: [], skipped: [], deleted: [], errors: [] };

  let client;
  try {
    client = new OdooClient({
      baseUrl: task.url,
      db: task.slug,
      login: task.login,
      password: task.apiKey
    });
    await client.authenticate();
  } catch (e) {
    result.errors.push(`auth: ${e.message}`);
    return result;
  }

  // Sanity check: required models must exist on this Odoo version.
  try {
    const needed = ["base.automation", "ir.actions.server", "documents.document", "mail.message"];
    const rows = await client.searchRead("ir.model", [["model", "in", needed]], ["model"], { limit: 10 });
    const got = new Set(rows.map((r) => r.model));
    const missing = needed.filter((m) => !got.has(m));
    if (missing.length) {
      result.errors.push(`unsupported odoo version — missing models: ${missing.join(", ")}`);
      return result;
    }
  } catch (e) {
    result.errors.push(`model check: ${e.message}`);
    return result;
  }

  let modelIds, fieldIds;
  try {
    modelIds = await discoverModelIds(client);
    fieldIds = await discoverFieldIds(client);
  } catch (e) {
    result.errors.push(`discovery: ${e.message}`);
    return result;
  }
  if (!modelIds.doc || !modelIds.msg) {
    result.errors.push(`missing models: doc=${modelIds.doc} msg=${modelIds.msg}`);
    return result;
  }

  let existing;
  try {
    existing = await findExistingRules(client);
  } catch (e) {
    result.errors.push(`list existing: ${e.message}`);
    return result;
  }
  const existingByName = new Map(existing.map((r) => [r.name, r]));

  for (const spec of RULE_SPECS) {
    const prior = existingByName.get(spec.name);
    if (prior && !force) {
      result.skipped.push(spec.name);
      continue;
    }
    if (prior && force) {
      if (!dryRun) {
        try {
          // Unlink the automation (cascades to action_server via constraints) — then unlink the action too.
          await client.executeKw("base.automation", "unlink", [[prior.id]]);
          const actionIds = Array.isArray(prior.action_server_ids) ? prior.action_server_ids : [];
          if (actionIds.length) {
            await client.executeKw("ir.actions.server", "unlink", [actionIds]);
          }
          result.deleted.push(spec.name);
        } catch (e) {
          result.errors.push(`delete ${spec.name}: ${e.message}`);
          continue;
        }
      }
    }

    const model_id = spec.model === "mail.message" ? modelIds.msg : modelIds.doc;
    const webhook_field_ids = spec.fields.map((k) => fieldIds[k]);
    const url = `${WORKER_BASE}/webhook/${spec.webhook_path}/${task.slug}`;

    if (dryRun) {
      result.created.push({ name: spec.name, url, active });
      continue;
    }

    try {
      const actionId = await client.create("ir.actions.server", {
        name: "Send Webhook Notification",
        state: "webhook",
        model_id,
        webhook_url: url,
        webhook_field_ids: [[6, 0, webhook_field_ids]]
      });
      const autoVals = {
        name: spec.name,
        model_id,
        trigger: spec.trigger,
        filter_domain: spec.filter_domain,
        active,
        action_server_ids: [[6, 0, [actionId]]]
      };
      if (spec.filter_pre_domain) autoVals.filter_pre_domain = spec.filter_pre_domain;
      const autoId = await client.create("base.automation", autoVals);
      result.created.push({ name: spec.name, url, active, autoId, actionId });
    } catch (e) {
      result.errors.push(`create ${spec.name}: ${e.message}`);
    }
  }

  return result;
}

function formatReport(results, opts) {
  console.log("");
  console.log("=".repeat(72));
  console.log(`SUMMARY  (dryRun=${opts.dryRun} force=${opts.force} active=${opts.active})`);
  console.log("=".repeat(72));
  for (const r of results) {
    const issues = r.errors.length ? `  ERR: ${r.errors.length}` : "";
    console.log(`\n[${r.slug}]  ${r.project}${issues}`);
    if (r.created.length)  console.log(`  created:  ${r.created.map((c) => c.name).join(", ")}`);
    if (r.skipped.length)  console.log(`  skipped:  ${r.skipped.join(", ")}  (already exist; use --force to recreate)`);
    if (r.deleted.length)  console.log(`  deleted:  ${r.deleted.join(", ")}`);
    if (r.errors.length)   for (const e of r.errors) console.log(`  error:    ${e}`);
  }
  console.log("");
  const ok  = results.filter((r) => r.errors.length === 0).length;
  const bad = results.length - ok;
  console.log(`DONE  ${ok} ok, ${bad} with errors, across ${results.length} tenants.`);
}

async function main() {
  const opts = parseArgs(process.argv);

  if (!process.env.SOURCE_LOGIN || !process.env.SOURCE_API_KEY) {
    console.error("Missing SOURCE_LOGIN or SOURCE_API_KEY in env.");
    process.exit(2);
  }

  const src = new OdooClient({
    baseUrl: SOURCE_URL,
    db: SOURCE_DB,
    login: process.env.SOURCE_LOGIN,
    password: process.env.SOURCE_API_KEY
  });
  await src.authenticate();

  const allTasks = await loadClientTasks(src);

  // Multi-company tenants surface as multiple project.task rows with the same
  // slug (different res.company). Automation rules are DB-wide, so dedupe.
  const bySlug = new Map();
  for (const t of allTasks) {
    if (!bySlug.has(t.slug)) bySlug.set(t.slug, t);
    else {
      const prior = bySlug.get(t.slug);
      prior._companies = (prior._companies || [prior.project]).concat([t.project]);
    }
  }
  const tasks = [...bySlug.values()];

  if (opts.list) {
    console.log(`Found ${tasks.length} unique client tenants (${allTasks.length} General Tasks incl multi-company):\n`);
    const col = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
    console.log(col("slug", 28), col("project", 40), col("enabled", 8), col("billW", 6), col("bsW", 6));
    console.log("-".repeat(90));
    for (const t of tasks) {
      const label = t._companies ? `${t.project} (+${t._companies.length - 1} more)` : t.project;
      console.log(col(t.slug, 28), col(label, 40), col(t.enabled, 8), col(t.billWorker, 6), col(t.bsWorker, 6));
    }
    return;
  }

  let targets = tasks;
  if (opts.slug) {
    const wanted = new Set(opts.slug.split(",").map((s) => s.trim()));
    targets = tasks.filter((t) => wanted.has(t.slug));
    const missing = [...wanted].filter((s) => !targets.some((t) => t.slug === s));
    if (missing.length) console.warn(`warning: slug(s) not found in source: ${missing.join(", ")}`);
  } else if (!opts.all) {
    console.error("Pass one of: --list, --slug <slug>, --all");
    process.exit(2);
  }

  if (!opts.includeSource) {
    targets = targets.filter((t) => t.slug !== SOURCE_DB);
  }

  if (targets.length === 0) {
    console.log("No matching targets. Use --list to see available tenants.");
    return;
  }

  console.log(`Targeting ${targets.length} tenant(s)${opts.dryRun ? " [DRY RUN]" : ""}: ${targets.map((t) => t.slug).join(", ")}\n`);

  const results = [];
  for (const task of targets) {
    process.stdout.write(`  ${task.slug} ... `);
    let r;
    try {
      r = await installForTenant(task, opts);
    } catch (e) {
      r = { slug: task.slug, url: task.url, project: task.project, created: [], skipped: [], deleted: [], errors: [`unhandled: ${e.message}`] };
    }
    const flag = r.errors.length ? "ERR" : (r.created.length ? "OK" : "SKIP");
    console.log(flag);
    results.push(r);
  }

  formatReport(results, opts);
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
