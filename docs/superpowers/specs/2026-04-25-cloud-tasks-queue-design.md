# Cloud Tasks queue for AP Worker bulk uploads

**Status:** draft, pending implementation
**Author:** brainstormed 2026-04-25
**Related incident:** 2026-04-25 bulk-upload 503 burst (15 of 20 docs lost on direct webhook fan-out)

---

## 1. Problem

The AP Worker today exposes per-document webhooks (`POST /webhook/document-upload/:slug`) that Odoo's automation rules call directly when a document is created in an Account Payables folder. The Odoo automation is `state="webhook"` — fire-and-forget HTTP POST with no retry on non-2xx.

When a user bulk-uploads N invoices simultaneously, Odoo fans out N parallel webhook calls in <100 ms. Cloud Run cannot scale instances fast enough; the load balancer returns 503 for any request that can't be routed to a ready instance. Today's incident: 20 docs uploaded → 5 processed → 13 returned 503 at the gateway → 2 lost in the shuffle. The 13 that 503'd never reached the worker, never got a chatter message, and have no `ir.attachment.description` marker — they sit invisibly stuck until the recovery cron picks them up (today ~15 min later, sometimes longer).

**Failure mode summary:**
- Odoo's webhook action does not retry on non-2xx
- Cloud Run rejects with 503 when its concurrency budget is exceeded
- The recovery cron (`/run` at `*/15 * * * *`) is the only safety net, and it locks the worker via a global `isRunning` mutex while it scans every configured tenant
- No per-doc visibility on what failed and why

## 2. Goals

- **No 503s reach Odoo.** The ingestion endpoint must always return 2xx for valid payloads, even under burst.
- **No docs are silently lost.** Every accepted doc either becomes a draft `account.move`, posts a chatter explaining why it can't, or lands in a dead-letter queue with operator visibility.
- **Loose fairness across tenants.** A single tenant's 100-doc bulk upload should not starve a different tenant's 5-doc upload.
- **Visible early progress under bulk.** With a 100-doc upload, the operator should see bills appearing in chatter as they're processed — no minutes-long stalls where nothing seems to be happening. Per-doc latency varies with invoice complexity; that's acceptable.
- **Survive deploys mid-batch.** A deploy in the middle of a 100-doc batch should not lose any in-flight docs.
- **Reduce Gemini Pro RPM pressure.** Route docs to Flash by default and escalate to Pro only when Flash returns low-confidence output; this multiplies effective throughput and gives headroom for traffic growth.

## 3. Non-goals

- **No queue-per-tenant.** Loose fairness via worker-side semaphores is sufficient; we explicitly chose not to provision 30+ Cloud Tasks queues.
- **No global semaphore via Redis/Memorystore.** Per-instance fairness is good enough; standing up Memorystore is not justified by current scale.
- **No automated DLQ replay.** Poison messages need human review before re-dispatch.
- **No change to `runOne` or `processOneDocument`'s bill-creation logic.** The queue layer wraps existing logic; the only edit inside `processOneDocument` is the Flash → Pro escalation in the Gemini-call path.
- **No retirement of `/webhook/document-upload/:slug` in this scope.** It stays as a fallback during and after cutover.
- **No per-doc real-time SLA.** Eventual consistency is acceptable; processing time scales with invoice complexity.

## 4. Architecture

```
Odoo automation (state="webhook", URL changed per-tenant)
        ↓
        POST /enqueue/:slug
        ├─ authRecord middleware verifies tenant + doc via Odoo callback
        ├─ build Cloud Tasks payload {slug, doc_id, _model, _id}
        └─ create task in queue ap-worker-bills
        ↓ (returns 202 to Odoo immediately)
Cloud Tasks queue ap-worker-bills
  - max_dispatches_per_second: 10
  - max_concurrent_dispatches: 30
  - max_burst_size: 5
  - retry: 10 attempts, 30s→300s backoff, max_doublings=4, 1h max duration
  - dead-letter: ap-worker-bills-dlq
        ↓ (rate-limited dispatch with OIDC token from cloud-tasks-invoker SA)
        POST /task/run-one/:slug
        ├─ verify OIDC token (Google-issued, GCP-native validation)
        ├─ acquire per-tenant semaphore (Map<slug, count>, max 3 per slug)
        │  └─ if cap hit: return 429 + Retry-After: 30 → Cloud Tasks retries
        ├─ runOne({ doc_id, target_key })  ← existing function, unchanged
        ├─ release semaphore in finally
        └─ map runOne result/error to HTTP status (see §6)
```

**Per-tenant semaphore is per-Cloud-Run-instance, not global.** With `maxScale=10` and `cap=3`, the global per-tenant ceiling is 30 in-flight — well within Cloud Run's `runOneMaxConcurrency=5` × 10 instances = 50 total budget.

**The existing `/webhook/document-upload/:slug` endpoint stays.** Cutover happens per-tenant by changing the Odoo automation's `webhook_url`. Reverting a tenant is a one-field Odoo write.

## 5. Components

### 5.1 `src/enqueue.js` — proxy endpoint

**Responsibility:** validate Odoo webhook payload, create Cloud Task, return 202.

**Interface:** Express handler `enqueueDocumentUpload(req, res)`, mounted at `POST /enqueue/:slug` via `attachWebhookRoutes` extension.

**Dependencies:** `@google-cloud/tasks` SDK, existing `authRecord` middleware, `config.tasks.{queueName, projectId, location, workerUrl, invokerServiceAccount}`.

**Failure mode:** if Cloud Tasks `createTask` API fails (extremely rare; Google's published SLA is 99.99%), return 503. The Odoo automation has no retry, so the doc relies on the `/run` recovery cron as the eventual safety net.

### 5.2 `src/taskHandler.js` — Cloud Tasks consumer

**Responsibility:** validate OIDC token, resolve `:slug` to a `target_key`, acquire per-tenant semaphore, call existing `runOne`, map result/error to HTTP status.

**Interface:** Express handler `handleTaskRunOne(req, res)`, mounted at `POST /task/run-one/:slug`.

**Dependencies:** `google-auth-library` (`OAuth2Client.verifyIdToken`), `runOne` from `worker.js` (unchanged), `tenantSemaphore` module (§5.3), `classifyError` helper (§6.1), the existing slug-to-target-key resolver used by `attachWebhookRoutes` today (so the routing source of truth stays in one place).

**Status mapping (load-bearing):**

| `runOne` outcome | HTTP | Cloud Tasks effect |
|---|---|---|
| `result.status === "ok"` | 200 | ACK, remove from queue |
| `result.status === "skip"` (any reason) | 200 | ACK; chatter posted by `runOne` already |
| Throws, error matches Gemini quota signature | 429 + `Retry-After: 60` | Retry with backoff |
| Throws, error matches transient (`ECONNREFUSED`, `ETIMEDOUT`, `503` upstream) | 503 | Retry with backoff |
| Throws, error matches permanent (`Invalid PDF`, `password.protected`) | 400 | Move to DLQ, no retry |
| Throws, anything else | 500 | Retry; eventually DLQ at `max_attempts=10` |

### 5.3 `src/tenantSemaphore.js` — per-instance concurrency map

**Responsibility:** track in-flight count per tenant slug; reject when cap reached.

**Interface:** module-singleton with three methods:
- `acquire(slug: string): boolean` — increments counter if below cap, returns `true`; otherwise returns `false` without incrementing
- `release(slug: string): void` — decrements counter; no-op if already at zero
- `inFlight(): Record<string, number>` — snapshot for `/debug` endpoint

**Configuration:** `MAX_PER_TENANT = 3`, hardcoded for now (config-promotable later if needed).

**Dependencies:** none. Pure in-memory `Map<string, number>`.

### 5.4 `terraform/cloud_tasks.tf` — infrastructure

Resources:
- `google_cloud_tasks_queue.ap_worker_bills` — main queue with rate config from §4
- `google_cloud_tasks_queue.ap_worker_bills_dlq` — dead-letter queue
- `google_service_account.cloud_tasks_invoker` — service account whose OIDC token signs requests to the worker
- `google_cloud_run_service_iam_member` — grants `cloud_tasks_invoker` the `roles/run.invoker` role on the worker service

The DLQ is a separate Cloud Tasks queue. Tasks are routed there automatically when `max_attempts` is reached on the main queue.

### 5.5 `scripts/cutover-tenant-to-tasks.js` — per-tenant cutover

**Responsibility:** verify and switch one Odoo tenant from `/webhook/document-upload/:slug` to `/enqueue/:slug`.

**Steps (idempotent):**
1. Connect to the tenant's Odoo via `proseso_clients` registry credentials
2. Find `ir.actions.server` for AP automation (model=`documents.document`, name contains "AP Worker")
3. Verify the worker's `/enqueue/:slug` endpoint responds 200 to a smoke probe
4. Update `webhook_url` to `https://ap-bill-ocr-worker-...run.app/enqueue/:slug`
5. Print before/after for confirmation

**Rollback:** the same script with `--revert` flag swaps the URL back.

### 5.6 `src/gemini.js` — Flash-first model routing (additive, in-place)

**Responsibility:** call Gemini Flash for the first extraction pass; if Flash returns low confidence or specific failure shapes, escalate the same payload to Gemini Pro.

**Surface area:** modifies the existing `extractInvoiceWithGemini` function to consult two env vars already wired through `config`:
- `GEMINI_MODEL` → primary model, defaulted to `gemini-2.5-flash` (was Pro)
- `GEMINI_FALLBACK_MODEL` → escalation model, defaulted to `gemini-3-pro-preview`

**Escalation triggers (any one):**
1. Flash response missing required schema fields (e.g., `vendor.name` empty, `invoice.grand_total` empty)
2. Any field's `confidence` < `ESCALATE_CONFIDENCE_THRESHOLD` (default 0.7)
3. Flash returned a 4xx/5xx error other than 429 (treat as model-incompatible, not transient)

**On 429 from Flash:** do NOT escalate to Pro (that just shifts pressure between quotas). Instead, throw a quota error so `taskHandler.classifyError` returns 429 → Cloud Tasks retries with backoff.

**Logging:** emit a structured log entry per call indicating which model produced the final result and whether escalation happened. This becomes the rate-of-escalation metric — if escalation rises above ~20%, the threshold is too aggressive.

**Configuration:** all thresholds and model names go through `config.js`, no hardcoded values. Each tenant uses the same defaults; per-tenant overrides are out of scope for v1.

**Why this is in scope despite being orthogonal to the queue:** it's the *quota* answer to the same problem the queue addresses (handling load). Building the queue without Flash routing leaves Gemini Pro RPM as the silent ceiling under sustained load. With Flash-first, the queue's `max_concurrent_dispatches=30` doesn't bump into Gemini quota until ~5x the current ceiling.

## 6. Error handling & observability

### 6.1 `classifyError` helper

A single function in `src/taskHandler.js` (or its own module if it grows). Maps an error message to `{status: number, retry: boolean, reason: string}`:

```js
function classifyError(err) {
  const msg = String(err?.message || err);
  if (/RESOURCE_EXHAUSTED|quota|rate.?limit|429/i.test(msg))
    return { status: 429, retry: true,  reason: "gemini_quota" };
  if (/ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|503/i.test(msg))
    return { status: 503, retry: true,  reason: "transient" };
  if (/Invalid PDF|password.protected|encrypted|unsupported/i.test(msg))
    return { status: 400, retry: false, reason: "bad_input" };
  return { status: 500, retry: true, reason: "unknown" };
}
```

Regex specificity matters — false positives in either direction lose docs or burn quota. Each pattern is covered by a dedicated test row (§7.1).

### 6.2 Observability surfaces

| Signal | Source | Tells us |
|---|---|---|
| Queue depth | Cloud Tasks console; metric `cloudtasks.googleapis.com/queue/depth` | Are we falling behind? |
| Oldest task age | Metric `cloudtasks.googleapis.com/queue/oldest_task_age` | Anything stuck? |
| DLQ count | `gcloud tasks queues describe ap-worker-bills-dlq` | Human-attention items |
| 429 response rate | Cloud Run logs filtered by `httpRequest.status=429` | Gemini quota pressure |
| Per-tenant in-flight | Worker `/debug` endpoint (extends existing) | One tenant monopolizing |

**Day-one alert:** Cloud Monitoring alert on `oldest_task_age > 3600s` → email operator. That's the single signal that says "ingestion is broken".

### 6.3 DLQ workflow

Tasks land in `ap-worker-bills-dlq` either because (a) `runOne` returned a permanent failure (400 from `classifyError`), or (b) retry budget exhausted (10 attempts at 30s-300s backoff = up to ~1 hour of attempts before DLQ).

Operator runbook:
1. Notice via Cloud Monitoring alert or Cloud Tasks console
2. Inspect task body to find `doc_id` + tenant slug
3. Open the doc in Odoo; runOne posts a human-readable error to chatter before throwing for permanent failures
4. Decide: re-upload the doc, fix the underlying issue manually, or replay the task via `gcloud tasks create-http-task --queue=ap-worker-bills`

No automated DLQ-replay. Replay is intentional — poison messages need human eyes first.

## 7. Testing

### 7.1 Unit tests (Vitest, mocked dependencies)

- **`tests/enqueue.test.mjs`**: posts to `/enqueue/:slug` with valid and invalid payloads. Mocks `@google-cloud/tasks` client. Asserts 202 on happy path, payload structure passed to `createTask`, 503 when SDK throws.
- **`tests/taskHandler.test.mjs`**: posts to `/task/run-one/:slug` with mocked OIDC validation. Mocks `runOne` to return each result class (`ok`, `skip`, throws). Asserts the status mapping table from §5.2.
- **`tests/tenantSemaphore.test.mjs`**: pure-function tests on acquire/release/inFlight. Covers cap behavior, release-without-acquire, slug isolation, snapshot consistency.
- **`tests/classifyError.test.mjs`**: ~20 realistic error message strings → expected `{status, retry, reason}`. Regression-defense for regex specificity.
- **`tests/geminiRouting.test.mjs`**: mocks Flash and Pro responses to cover §5.6 escalation triggers — Flash returns full schema (no escalation), Flash returns missing field (escalates), Flash returns low-confidence (escalates), Flash returns 429 (does NOT escalate, throws quota error). Asserts the structured log entry includes which model produced the final result.

Coverage target: ≥90% on the new and modified modules. The existing `worker.js` test suite stays green because `runOne` and `processOneDocument` are unchanged outside of the Gemini call.

### 7.2 Integration test (Cloud Tasks emulator)

`tests/integration/cloudTasks.test.mjs` runs Google's [Cloud Tasks emulator](https://cloud.google.com/tasks/docs/local-development) in Docker. Exercises full path:
1. Start emulator + worker on local ports
2. POST to `/enqueue/proseso-accounting-test` with stub payload
3. Assert: 202 returned, task appears in emulator queue
4. Wait for emulator dispatch
5. Assert: `runOne` mock called with correct payload
6. Assert: 200 response causes ACK; queue depth returns to 0

Skipped in standard CI (`INTEGRATION` env flag opts in). Requires Docker locally.

### 7.3 Production verification (cutover playbook)

Before each per-tenant cutover:
1. Trigger one doc via direct `curl POST /enqueue/:slug` — verify a Cloud Task is created and processed end-to-end
2. Update Odoo automation URL using `scripts/cutover-tenant-to-tasks.js`
3. Upload 1 doc in Odoo → verify chatter "✅ Vendor matched / Bill created" within ~90 seconds
4. Upload 5 docs in Odoo → verify all 5 bills appear, queue depth went 5 → 0
5. Soak 24 hours before next tenant

Rollback: `scripts/cutover-tenant-to-tasks.js --revert <slug>` reverts the Odoo URL.

## 8. Migration & rollout

Phasing = how we split the work into independently shippable PRs. After each phase, the system is in a working state — pausing between phases leaves nothing broken. PR-level boundaries:

**Phase 0 (PR #1) — Gemini Flash-first routing.** Modify `extractInvoiceWithGemini` (§5.6) to call Flash by default and escalate to Pro on low confidence. Self-contained; lands before queue work. Rollback is a one-line env-var change. Production effect: per-doc latency drops on simple bills (Flash is faster), Pro RPM pressure drops by ~5x on aggregate.

**Phase 1 (PR #2) — Queue consumer endpoint, dormant.** Add `/task/run-one/:slug` endpoint with OIDC validation, `tenantSemaphore` module, `classifyError` helper, all unit tests. **No Cloud Tasks integration yet** — endpoint is callable but nothing produces tasks. Tested via `gcloud tasks create-http-task --queue=ap-worker-bills`. Production effect: zero (endpoint is dormant).

**Phase 2 (PR #3) — Single-tenant cutover.** Add `/enqueue/:slug` proxy endpoint, Terraform for queue + DLQ + invoker SA, `cutover-tenant-to-tasks.js` script, integration test. Cut over **proseso-accounting-test only**. Other 30 tenants stay on `/webhook/document-upload/:slug`. Soak 24 hours. Rollback: `cutover-tenant-to-tasks.js --revert proseso-accounting-test`.

**Phase 3 (PR #4) — Wide cutover.** After 24-hour soak with no anomalies, run the cutover script for all remaining 30+ tenants. Monitor queue depth and DLQ for 1 week. After clean operation, document the architecture in CLAUDE.md and remove this spec's "draft" status.

**Phase 4 (deferred, separate spec) — Retire `/webhook/document-upload/:slug`.** After 30 days of clean operation. Not in this spec.

Each phase is independently shippable and independently revertible. Phases 0 and 1 are risk-free (additive, no behavior change for existing traffic). Phase 2 affects one test client. Phase 3 is the wide cutover with explicit per-tenant rollback.

## 9. Open questions / known limitations

- **Per-instance semaphore drift.** Loose fairness means one tenant's worst-case in-flight is `MAX_PER_TENANT × maxScale = 3 × 10 = 30`. If Gemini quota becomes pressure-limiting at this number, we may need a stricter global cap — punt to Memorystore-backed semaphore at that point. Not solving today.
- **Cold-start latency.** First task after a quiet period waits for Cloud Run cold start (5-10s). Acceptable per goals but worth monitoring as queue dispatch rate grows.
- **`/debug` endpoint exposure.** `tenantSemaphore.inFlight()` reveals tenant slugs. The endpoint must keep its existing `isAuthorized` guard.
- **No DLQ replay automation.** Operator burden grows linearly with poison message volume. Acceptable today (~0 expected per week) but worth revisiting if it spikes.
- **Cloud Tasks regional locality.** The queue is in `asia-southeast1`, same region as the worker. Cross-region dispatch would add latency; we're not doing that.
- **Flash → Pro escalation rate is unknown a priori.** §5.6 sets `ESCALATE_CONFIDENCE_THRESHOLD = 0.7` as a guess. Real escalation rate will only be visible after Phase 0 ships. If escalation > 40% on real traffic, Flash isn't pulling its weight and we should revisit (either tune the threshold, switch back to Pro-default, or improve prompts).
- **Per-tenant Flash/Pro override is out of scope.** All tenants use the same defaults. If a specific client's invoice quality consistently produces low-confidence Flash results, manual config is the workaround until per-tenant routing is added.

## 10. References

- Cloud Tasks rate limit semantics: https://cloud.google.com/tasks/docs/configuring-queues
- OIDC token validation for Cloud Run from Cloud Tasks: https://cloud.google.com/run/docs/triggering/using-tasks
- Cloud Tasks emulator for local testing: https://cloud.google.com/tasks/docs/local-development
- Today's incident timeline (in-session diagnostics): bills 701-716, docs 23708-23725
- Existing recovery layer: `ap-bill-ocr-every-5m` Cloud Scheduler (now `*/15 * * * *`, deadline 1800s)
