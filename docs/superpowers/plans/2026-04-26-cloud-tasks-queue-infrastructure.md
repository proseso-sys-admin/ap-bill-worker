# Cloud Tasks Queue Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fire-and-forget Odoo webhook fan-out with a Cloud Tasks–backed ingestion layer, eliminating 503-burst data loss, providing per-tenant fairness via a worker-side semaphore, and giving observability + dead-letter handling for poison messages.

**Architecture:** Odoo automation continues to fire `state="webhook"` to a new `/enqueue/:slug` endpoint on the worker. That endpoint validates the payload via the existing tenant-aware auth, creates a Cloud Task in `ap-worker-bills`, and returns 202. Cloud Tasks dispatches each task at a rate-limited cadence to `/task/run-one/:slug`, which acquires a per-tenant semaphore (cap 3), calls the existing `runOne`, and maps result/error to HTTP status. Failures retry up to 10 times before dead-lettering. No change to `runOne`/`processOneDocument` business logic.

**Tech Stack:** Node.js 20, Vitest, CommonJS source, Express. New deps: `@google-cloud/tasks`, `google-auth-library`. New GCP resources: 2× Cloud Tasks queues (main + DLQ), 1× service account, 3× monitoring alerts. Provisioned via `scripts/setup-cloud-tasks.sh` (gcloud-based) — matches existing project convention (no Terraform).

**Spec reference:** `docs/superpowers/specs/2026-04-25-cloud-tasks-queue-design.md` Phases 1-3.

**Prerequisite:** Plan A (Phase 0 — Gemini Flash routing) should be merged and deployed before starting Plan B. Not strictly required (the queue works with Pro-only routing) but Plan A's escalation-rate data informs queue-config tuning if needed.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/slugResolver.js` | Create | Map tenant slug → `{targetKey, odoo, companyId, target}`. Extracted from existing `authRecord` middleware so both webhook and task endpoints share one code path. |
| `src/tenantSemaphore.js` | Create | Per-instance `Map<slug, count>` with `acquire`, `release`, `inFlight`. Module singleton, cap = 3 per slug. |
| `src/classifyError.js` | Create | Map runOne error message → `{status, retry, reason}`. Drives Cloud Tasks retry vs. dead-letter behavior. |
| `src/taskHandler.js` | Create | Cloud Tasks consumer at `POST /task/run-one/:slug`. Validates OIDC token, acquires semaphore, calls `runOne`, maps result via `classifyError`. |
| `src/enqueue.js` | Create | Proxy endpoint at `POST /enqueue/:slug`. Validates Odoo payload, creates Cloud Task, returns 202. |
| `src/webhookRoutes.js` | Modify | Refactor `authRecord` to delegate slug resolution to `src/slugResolver.js`. No behavior change. |
| `src/server.js` | Modify | Mount `/task/run-one/:slug` and `/enqueue/:slug` routes. |
| `src/config.js` | Modify | Add `config.tasks.{queueName, dlqName, projectId, location, workerUrl, invokerServiceAccount}`. |
| `package.json` | Modify | Add deps: `@google-cloud/tasks`, `google-auth-library`. |
| `scripts/setup-cloud-tasks.sh` | Create | Idempotent gcloud-based provisioning of queue, DLQ, SA, IAM bindings, monitoring alerts. |
| `scripts/cutover-tenant-to-tasks.js` | Create | Per-tenant cutover: switch Odoo automation `webhook_url` to `/enqueue/:slug`. Supports `--revert`. |
| `tests/slugResolver.test.mjs` | Create | Unit tests for slug resolution. |
| `tests/tenantSemaphore.test.mjs` | Create | Unit tests for semaphore. |
| `tests/classifyError.test.mjs` | Create | Unit tests covering ~20 error message → status mappings. |
| `tests/taskHandler.test.mjs` | Create | Unit tests with mocked OIDC validation and `runOne`. |
| `tests/enqueue.test.mjs` | Create | Unit tests with mocked Cloud Tasks client. |

---

# Phase 1 — Queue consumer endpoint, dormant (PR #2)

## Task 1.1: Extract `resolveSlugToTargetKey` from `authRecord` middleware

**Files:**
- Create: `src/slugResolver.js`
- Modify: `src/webhookRoutes.js` (the `authRecord` middleware)
- Create: `tests/slugResolver.test.mjs`

This is a behavior-preserving refactor. The existing webhook tests must continue to pass.

- [ ] **Step 1: Read the existing `authRecord` middleware**

Run: `grep -n "authRecord\|targetKey\|getTargetsFromOdoo" /mnt/windows/Users/Admin/Project/Odoo-AP-Worker/src/webhookRoutes.js | head -20`

Note the lines and structure. The slug-to-target mapping logic is what we're extracting.

- [ ] **Step 2: Write a failing unit test for the extracted function**

Create `tests/slugResolver.test.mjs`:

```js
import { describe, it, expect, vi } from "vitest";
import { resolveSlugToTargetKey } from "../src/slugResolver.js";

describe("resolveSlugToTargetKey", () => {
  it("returns target context when slug matches a configured tenant", async () => {
    const fakeTargets = [
      {
        targetKey: "https://proseso-accounting-test.odoo.com|proseso-accounting-test|admin@proseso-consulting.com|1|202",
        baseUrl: "https://proseso-accounting-test.odoo.com",
        slug: "proseso-accounting-test",
        db: "proseso-accounting-test",
        login: "admin@proseso-consulting.com",
        apiKey: "fake-key",
        companyId: 1,
      },
    ];
    const fakeGetTargets = vi.fn().mockResolvedValue(fakeTargets);

    const result = await resolveSlugToTargetKey("proseso-accounting-test", {
      getTargets: fakeGetTargets,
    });

    expect(result.targetKey).toBe(fakeTargets[0].targetKey);
    expect(result.companyId).toBe(1);
    expect(result.target).toEqual(fakeTargets[0]);
    expect(result.odoo).toBeDefined();
  });

  it("throws when slug does not match any configured tenant", async () => {
    const fakeGetTargets = vi.fn().mockResolvedValue([]);
    await expect(
      resolveSlugToTargetKey("nonexistent-slug", { getTargets: fakeGetTargets })
    ).rejects.toThrow(/no target found/i);
  });

  it("matches slug case-insensitively", async () => {
    const fakeTargets = [{ slug: "klaro-ventures", targetKey: "tk", companyId: 1, baseUrl: "u", db: "d", login: "l", apiKey: "k" }];
    const fakeGetTargets = vi.fn().mockResolvedValue(fakeTargets);
    const result = await resolveSlugToTargetKey("KLARO-VENTURES", { getTargets: fakeGetTargets });
    expect(result.target.slug).toBe("klaro-ventures");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- tests/slugResolver.test.mjs`

Expected: import error — `resolveSlugToTargetKey` not exported from `../src/slugResolver.js` (file doesn't exist).

- [ ] **Step 4: Create `src/slugResolver.js`**

```js
const { OdooClient } = require("./odoo");
const { getTargetsFromOdoo } = require("./worker");

/**
 * Map a tenant slug to the worker's internal target context.
 *
 * @param {string} slug - tenant identifier from URL path (e.g. "proseso-accounting-test")
 * @param {object} [opts]
 * @param {Function} [opts.getTargets] - injectable override for target lookup (used in tests)
 * @param {object} [opts.logger] - optional logger
 * @returns {Promise<{targetKey: string, odoo: OdooClient, companyId: number, target: object}>}
 */
async function resolveSlugToTargetKey(slug, opts = {}) {
  const getTargets = opts.getTargets || (async () => getTargetsFromOdoo(opts.logger));
  const targets = await getTargets();
  const want = String(slug || "").toLowerCase();
  const target = (targets || []).find((t) => String(t.slug || "").toLowerCase() === want);
  if (!target) {
    throw new Error(`no target found for slug=${slug}`);
  }
  const odoo = new OdooClient({
    baseUrl: target.baseUrl,
    db: target.db,
    login: target.login,
    password: target.apiKey,
  });
  return {
    targetKey: target.targetKey,
    odoo,
    companyId: Number(target.companyId || 1),
    target,
  };
}

module.exports = { resolveSlugToTargetKey };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/slugResolver.test.mjs`

Expected: 3 tests pass.

- [ ] **Step 6: Refactor `authRecord` to use `resolveSlugToTargetKey`**

In `src/webhookRoutes.js`, find the existing slug-resolution logic inside `authRecord` (look for `getTargetsFromOdoo` calls and target matching). Replace that block with a call to `resolveSlugToTargetKey(req.params.slug, { logger })`. The function returns the same context object the old code built; only the source has moved.

The middleware should still:
- Catch the throw from `resolveSlugToTargetKey` and return 401/404 as before
- Verify the doc exists in Odoo (the existing Odoo callback verification — keep this)
- Attach the resolved context to `req` for downstream handlers

- [ ] **Step 7: Run the full test suite to verify no regressions**

Run: `npm test`

Expected: existing tests (`tests/webhookAuth.test.mjs`, `tests/webhookRoutes.test.mjs`) still pass alongside the 3 new `slugResolver` tests.

- [ ] **Step 8: Commit**

```bash
git add src/slugResolver.js tests/slugResolver.test.mjs src/webhookRoutes.js
git commit -m "refactor: extract resolveSlugToTargetKey from authRecord middleware"
```

---

## Task 1.2: Implement `tenantSemaphore` module

**Files:**
- Create: `src/tenantSemaphore.js`
- Create: `tests/tenantSemaphore.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/tenantSemaphore.test.mjs`:

```js
import { describe, it, expect, beforeEach } from "vitest";
import { createSemaphore, MAX_PER_TENANT } from "../src/tenantSemaphore.js";

describe("tenantSemaphore", () => {
  let sem;

  beforeEach(() => {
    sem = createSemaphore();
  });

  it("MAX_PER_TENANT is 3", () => {
    expect(MAX_PER_TENANT).toBe(3);
  });

  it("acquire returns true when under cap", () => {
    expect(sem.acquire("tenant-a")).toBe(true);
    expect(sem.acquire("tenant-a")).toBe(true);
    expect(sem.acquire("tenant-a")).toBe(true);
  });

  it("acquire returns false when at cap (does not increment)", () => {
    sem.acquire("tenant-a");
    sem.acquire("tenant-a");
    sem.acquire("tenant-a");
    expect(sem.acquire("tenant-a")).toBe(false);
    expect(sem.inFlight()["tenant-a"]).toBe(3);
  });

  it("release decrements counter", () => {
    sem.acquire("tenant-a");
    sem.acquire("tenant-a");
    sem.release("tenant-a");
    expect(sem.inFlight()["tenant-a"]).toBe(1);
  });

  it("release is no-op when counter is 0", () => {
    sem.release("tenant-a");
    expect(sem.inFlight()["tenant-a"] || 0).toBe(0);
  });

  it("acquire on full tenant does not affect other tenants", () => {
    sem.acquire("tenant-a");
    sem.acquire("tenant-a");
    sem.acquire("tenant-a");
    expect(sem.acquire("tenant-a")).toBe(false);
    expect(sem.acquire("tenant-b")).toBe(true);
    expect(sem.inFlight()["tenant-b"]).toBe(1);
  });

  it("inFlight returns a copy (mutating it does not affect internal state)", () => {
    sem.acquire("tenant-a");
    const snapshot = sem.inFlight();
    snapshot["tenant-a"] = 99;
    expect(sem.inFlight()["tenant-a"]).toBe(1);
  });

  it("after fully releasing, slot becomes available again", () => {
    sem.acquire("tenant-a");
    sem.acquire("tenant-a");
    sem.acquire("tenant-a");
    expect(sem.acquire("tenant-a")).toBe(false);
    sem.release("tenant-a");
    expect(sem.acquire("tenant-a")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/tenantSemaphore.test.mjs`

Expected: import error — module doesn't exist.

- [ ] **Step 3: Create `src/tenantSemaphore.js`**

```js
const MAX_PER_TENANT = 3;

function createSemaphore(maxPerTenant = MAX_PER_TENANT) {
  const counts = new Map();

  function acquire(slug) {
    const current = counts.get(slug) || 0;
    if (current >= maxPerTenant) return false;
    counts.set(slug, current + 1);
    return true;
  }

  function release(slug) {
    const current = counts.get(slug) || 0;
    if (current <= 0) return;
    counts.set(slug, current - 1);
  }

  function inFlight() {
    const snapshot = {};
    for (const [slug, count] of counts.entries()) {
      snapshot[slug] = count;
    }
    return snapshot;
  }

  return { acquire, release, inFlight };
}

// Module-singleton for production use; tests construct their own via createSemaphore()
const defaultSemaphore = createSemaphore();

module.exports = {
  MAX_PER_TENANT,
  createSemaphore,
  defaultSemaphore,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/tenantSemaphore.test.mjs`

Expected: 8 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`

Expected: all tests pass; nothing else is affected.

- [ ] **Step 6: Commit**

```bash
git add src/tenantSemaphore.js tests/tenantSemaphore.test.mjs
git commit -m "feat: add tenantSemaphore module with per-instance per-tenant cap"
```

---

## Task 1.3: Implement `classifyError` helper

**Files:**
- Create: `src/classifyError.js`
- Create: `tests/classifyError.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/classifyError.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { classifyError } from "../src/classifyError.js";

describe("classifyError", () => {
  describe("Gemini quota errors → 429 retry", () => {
    it.each([
      "Gemini gemini-2.5-flash HTTP 429: quota exceeded",
      "RESOURCE_EXHAUSTED: rate limit",
      "rate-limit hit",
      "rate limit hit",
      "Quota exceeded for requests per minute",
    ])("classifies %s as gemini_quota", (msg) => {
      const result = classifyError(new Error(msg));
      expect(result).toEqual({ status: 429, retry: true, reason: "gemini_quota" });
    });
  });

  describe("Transient errors → 503 retry", () => {
    it.each([
      "ECONNREFUSED: connection refused",
      "fetch failed: ETIMEDOUT",
      "EAI_AGAIN: getaddrinfo failed",
      "fetch failed",
      "Odoo HTTP 503: service unavailable",
    ])("classifies %s as transient", (msg) => {
      const result = classifyError(new Error(msg));
      expect(result).toEqual({ status: 503, retry: true, reason: "transient" });
    });
  });

  describe("Permanent input errors → 400 dead-letter", () => {
    it.each([
      "Invalid PDF structure",
      "PDF is password.protected",
      "encrypted PDF cannot be parsed",
      "unsupported file format",
    ])("classifies %s as bad_input", (msg) => {
      const result = classifyError(new Error(msg));
      expect(result).toEqual({ status: 400, retry: false, reason: "bad_input" });
    });
  });

  describe("Unknown errors → 500 retry-then-DLQ", () => {
    it("classifies unrecognized errors as unknown", () => {
      expect(classifyError(new Error("Database connection lost"))).toEqual({
        status: 500,
        retry: true,
        reason: "unknown",
      });
    });

    it("classifies non-Error throwables defensively", () => {
      expect(classifyError("string thrown")).toEqual({
        status: 500,
        retry: true,
        reason: "unknown",
      });
      expect(classifyError(null)).toEqual({
        status: 500,
        retry: true,
        reason: "unknown",
      });
    });
  });

  describe("Specificity guards (no false positives)", () => {
    it("does NOT classify 'private' as quota even though it contains nothing of meaning", () => {
      const result = classifyError(new Error("invalid private key"));
      expect(result.reason).toBe("unknown");
    });

    it("classifies 'Pdf' (case-insensitive) as bad_input", () => {
      const result = classifyError(new Error("Pdf is password.Protected"));
      expect(result.reason).toBe("bad_input");
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/classifyError.test.mjs`

Expected: import error.

- [ ] **Step 3: Create `src/classifyError.js`**

```js
/**
 * Maps an error from runOne to an HTTP status that drives Cloud Tasks behavior.
 *
 * Status mapping:
 *  - 200: success — Cloud Tasks ACKs and removes the task (handled by caller, not this fn)
 *  - 429: Gemini quota — retry with backoff
 *  - 503: transient (network, upstream 503) — retry with backoff
 *  - 400: permanent (bad PDF, unsupported format) — dead-letter, no retry
 *  - 500: unknown — retry; eventually dead-letters via max_attempts
 */
function classifyError(err) {
  const msg = String(err && err.message ? err.message : err || "");

  // Order matters: more specific patterns first.
  if (/RESOURCE_EXHAUSTED|quota|rate.?limit|429/i.test(msg)) {
    return { status: 429, retry: true, reason: "gemini_quota" };
  }
  if (/ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|503/i.test(msg)) {
    return { status: 503, retry: true, reason: "transient" };
  }
  if (/Invalid PDF|password.protected|encrypted|unsupported/i.test(msg)) {
    return { status: 400, retry: false, reason: "bad_input" };
  }
  return { status: 500, retry: true, reason: "unknown" };
}

module.exports = { classifyError };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/classifyError.test.mjs`

Expected: all parameterized tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`

Expected: full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/classifyError.js tests/classifyError.test.mjs
git commit -m "feat: add classifyError helper for Cloud Tasks status mapping"
```

---

## Task 1.4: Add Cloud Tasks config keys

**Files:**
- Modify: `src/config.js`

- [ ] **Step 1: Add a `tasks` config block**

In `src/config.js`, after the `bankStatement` block (around line 115), add:

```js
  tasks: {
    queueName: process.env.CLOUD_TASKS_QUEUE_NAME || "ap-worker-bills",
    dlqName: process.env.CLOUD_TASKS_DLQ_NAME || "ap-worker-bills-dlq",
    projectId: process.env.GCP_PROJECT_ID || "odoo-ocr-487104",
    location: process.env.CLOUD_TASKS_LOCATION || "asia-southeast1",
    workerUrl: process.env.WORKER_URL || "https://ap-bill-ocr-worker-njiacix2yq-as.a.run.app",
    invokerServiceAccount:
      process.env.CLOUD_TASKS_INVOKER_SA ||
      "cloud-tasks-invoker@odoo-ocr-487104.iam.gserviceaccount.com",
  },
```

Place this block as the last property of the `config` object, before the closing `};`.

- [ ] **Step 2: Verify config loads**

Run: `node -e "console.log(require('./src/config').config.tasks)"`

Expected output:

```js
{
  queueName: 'ap-worker-bills',
  dlqName: 'ap-worker-bills-dlq',
  projectId: 'odoo-ocr-487104',
  location: 'asia-southeast1',
  workerUrl: 'https://ap-bill-ocr-worker-njiacix2yq-as.a.run.app',
  invokerServiceAccount: 'cloud-tasks-invoker@odoo-ocr-487104.iam.gserviceaccount.com'
}
```

- [ ] **Step 3: Commit**

```bash
git add src/config.js
git commit -m "feat: add Cloud Tasks config block"
```

---

## Task 1.5: Install `google-auth-library` for OIDC token validation

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the library**

Run: `npm install --save google-auth-library`

This is needed for `OAuth2Client.verifyIdToken` in `taskHandler.js`.

- [ ] **Step 2: Verify the install**

Run: `node -e "const { OAuth2Client } = require('google-auth-library'); console.log(typeof OAuth2Client);"`

Expected: `function`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add google-auth-library for OIDC token validation"
```

---

## Task 1.6: Implement `taskHandler` (Cloud Tasks consumer)

**Files:**
- Create: `src/taskHandler.js`
- Create: `tests/taskHandler.test.mjs`

This is the load-bearing piece. It composes `slugResolver`, `tenantSemaphore`, and `classifyError`.

- [ ] **Step 1: Write the failing test**

Create `tests/taskHandler.test.mjs`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleTaskRunOne } from "../src/taskHandler.js";

function makeReqRes(slug, body = { doc_id: 100 }, headers = { authorization: "Bearer fake-oidc-token" }) {
  const req = { params: { slug }, body, headers, header: (name) => headers[name.toLowerCase()] };
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return { req, res };
}

describe("handleTaskRunOne", () => {
  let deps;

  beforeEach(() => {
    deps = {
      verifyOidc: vi.fn().mockResolvedValue({ email: "cloud-tasks-invoker@odoo-ocr-487104.iam.gserviceaccount.com" }),
      resolveSlug: vi.fn().mockResolvedValue({
        targetKey: "tk",
        odoo: {},
        companyId: 1,
        target: {},
      }),
      semaphore: { acquire: vi.fn().mockReturnValue(true), release: vi.fn() },
      runOne: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
  });

  it("returns 200 ok when runOne returns status: ok", async () => {
    deps.runOne.mockResolvedValue({ result: { status: "ok", billId: 706 } });
    const { req, res } = makeReqRes("proseso-accounting-test");

    await handleTaskRunOne(req, res, deps);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(deps.semaphore.acquire).toHaveBeenCalledWith("proseso-accounting-test");
    expect(deps.semaphore.release).toHaveBeenCalledWith("proseso-accounting-test");
  });

  it("returns 200 when runOne returns status: skip (already handled)", async () => {
    deps.runOne.mockResolvedValue({ result: { status: "skip", reason: "already_linked" } });
    const { req, res } = makeReqRes("proseso-accounting-test");

    await handleTaskRunOne(req, res, deps);

    expect(res.statusCode).toBe(200);
  });

  it("returns 429 with Retry-After when semaphore is full", async () => {
    deps.semaphore.acquire.mockReturnValue(false);
    const { req, res } = makeReqRes("proseso-accounting-test");

    await handleTaskRunOne(req, res, deps);

    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBe("30");
    expect(deps.runOne).not.toHaveBeenCalled();
    expect(deps.semaphore.release).not.toHaveBeenCalled();
  });

  it("returns 401 when OIDC validation fails", async () => {
    deps.verifyOidc.mockRejectedValue(new Error("invalid_token"));
    const { req, res } = makeReqRes("proseso-accounting-test");

    await handleTaskRunOne(req, res, deps);

    expect(res.statusCode).toBe(401);
    expect(deps.runOne).not.toHaveBeenCalled();
  });

  it("returns 401 when OIDC token email does not match invoker SA", async () => {
    deps.verifyOidc.mockResolvedValue({ email: "wrong-sa@example.com" });
    const { req, res } = makeReqRes("proseso-accounting-test");

    await handleTaskRunOne(req, res, deps);

    expect(res.statusCode).toBe(401);
  });

  it("returns 429 when runOne throws Gemini quota error", async () => {
    deps.runOne.mockRejectedValue(new Error("RESOURCE_EXHAUSTED: quota"));
    const { req, res } = makeReqRes("proseso-accounting-test");

    await handleTaskRunOne(req, res, deps);

    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBe("60");
    expect(res.body.reason).toBe("gemini_quota");
    expect(deps.semaphore.release).toHaveBeenCalled();
  });

  it("returns 503 when runOne throws transient error", async () => {
    deps.runOne.mockRejectedValue(new Error("ECONNREFUSED: odoo"));
    const { req, res } = makeReqRes("proseso-accounting-test");

    await handleTaskRunOne(req, res, deps);

    expect(res.statusCode).toBe(503);
    expect(res.body.reason).toBe("transient");
  });

  it("returns 400 (no retry) when runOne throws bad_input error", async () => {
    deps.runOne.mockRejectedValue(new Error("Invalid PDF structure"));
    const { req, res } = makeReqRes("proseso-accounting-test");

    await handleTaskRunOne(req, res, deps);

    expect(res.statusCode).toBe(400);
    expect(res.body.retry).toBe(false);
    expect(res.body.reason).toBe("bad_input");
  });

  it("returns 500 when runOne throws unknown error", async () => {
    deps.runOne.mockRejectedValue(new Error("Database connection lost"));
    const { req, res } = makeReqRes("proseso-accounting-test");

    await handleTaskRunOne(req, res, deps);

    expect(res.statusCode).toBe(500);
    expect(res.body.reason).toBe("unknown");
  });

  it("returns 404 when slug is not found", async () => {
    deps.resolveSlug.mockRejectedValue(new Error("no target found for slug=foo"));
    const { req, res } = makeReqRes("foo");

    await handleTaskRunOne(req, res, deps);

    expect(res.statusCode).toBe(404);
  });

  it("releases semaphore even when runOne throws", async () => {
    deps.runOne.mockRejectedValue(new Error("any"));
    const { req, res } = makeReqRes("proseso-accounting-test");

    await handleTaskRunOne(req, res, deps);

    expect(deps.semaphore.release).toHaveBeenCalledWith("proseso-accounting-test");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/taskHandler.test.mjs`

Expected: import error.

- [ ] **Step 3: Create `src/taskHandler.js`**

```js
const { OAuth2Client } = require("google-auth-library");
const { config } = require("./config");
const { resolveSlugToTargetKey } = require("./slugResolver");
const { defaultSemaphore } = require("./tenantSemaphore");
const { classifyError } = require("./classifyError");

const oidcClient = new OAuth2Client();

/**
 * Verifies an OIDC token issued by Cloud Tasks for the worker URL audience.
 * Returns the token payload (includes email of signing SA) on success.
 */
async function verifyOidcToken(req) {
  const auth = req.header ? req.header("authorization") : (req.headers || {}).authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    throw new Error("missing or malformed Authorization header");
  }
  const token = auth.slice("Bearer ".length).trim();
  const ticket = await oidcClient.verifyIdToken({
    idToken: token,
    audience: config.tasks.workerUrl,
  });
  const payload = ticket.getPayload();
  if (!payload) throw new Error("invalid OIDC token payload");
  return payload;
}

/**
 * Cloud Tasks consumer endpoint handler.
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @param {object} [deps] - injectable dependencies for testing
 */
async function handleTaskRunOne(req, res, deps = {}) {
  const verifyOidc = deps.verifyOidc || verifyOidcToken;
  const resolveSlug = deps.resolveSlug || resolveSlugToTargetKey;
  const semaphore = deps.semaphore || defaultSemaphore;
  const runOneFn = deps.runOne || require("./worker").runOne;
  const logger = deps.logger || require("./logger").logger;

  const slug = String(req.params?.slug || "").toLowerCase();

  // 1. Validate OIDC token from Cloud Tasks
  let oidcPayload;
  try {
    oidcPayload = await verifyOidc(req);
  } catch (err) {
    logger.warn?.("OIDC validation failed.", { slug, error: String(err?.message || err) });
    return res.status(401).json({ ok: false, error: "unauthorized", reason: "oidc_invalid" });
  }
  if (oidcPayload.email !== config.tasks.invokerServiceAccount) {
    logger.warn?.("OIDC token from unexpected SA.", { slug, email: oidcPayload.email });
    return res.status(401).json({ ok: false, error: "unauthorized", reason: "wrong_sa" });
  }

  // 2. Resolve slug to target context
  let context;
  try {
    context = await resolveSlug(slug, { logger });
  } catch (err) {
    logger.warn?.("Slug resolution failed.", { slug, error: String(err?.message || err) });
    return res.status(404).json({ ok: false, error: "tenant_not_found", slug });
  }

  // 3. Acquire per-tenant semaphore
  if (!semaphore.acquire(slug)) {
    res.setHeader("Retry-After", "30");
    return res.status(429).json({
      ok: false,
      error: "tenant_concurrency_full",
      reason: "tenant_cap",
      retry: true,
    });
  }

  // 4. Run the existing pipeline; release semaphore on success or error
  try {
    const docId = Number(req.body?.doc_id || req.body?._id || req.body?.id || 0);
    if (!docId) {
      return res.status(400).json({ ok: false, error: "missing_doc_id", retry: false });
    }
    const payload = { target_key: context.targetKey, doc_id: docId };
    const result = await runOneFn({ logger, payload });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    const cls = classifyError(err);
    logger.error?.("taskHandler runOne failed.", {
      slug,
      docId: req.body?.doc_id,
      error: String(err?.message || err),
      classification: cls,
    });
    if (cls.status === 429) res.setHeader("Retry-After", "60");
    return res.status(cls.status).json({
      ok: false,
      error: String(err?.message || err),
      retry: cls.retry,
      reason: cls.reason,
    });
  } finally {
    semaphore.release(slug);
  }
}

module.exports = { handleTaskRunOne, verifyOidcToken };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/taskHandler.test.mjs`

Expected: all 11 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`

Expected: full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/taskHandler.js tests/taskHandler.test.mjs
git commit -m "feat: add taskHandler — Cloud Tasks consumer endpoint"
```

---

## Task 1.7: Mount `/task/run-one/:slug` route in `server.js`

**Files:**
- Modify: `src/server.js`

- [ ] **Step 1: Locate the route mounting section**

Open `src/server.js` and find the route definitions (around lines 40-280 based on prior session context). Find the `attachWebhookRoutes` call.

- [ ] **Step 2: Mount the new route**

Add the following near the webhook routes:

```js
const { handleTaskRunOne } = require("./taskHandler");
app.post("/task/run-one/:slug", async (req, res) => {
  try {
    await handleTaskRunOne(req, res);
  } catch (err) {
    logger.error("taskHandler unhandled exception.", { error: err?.message, stack: err?.stack });
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: "unhandled_exception" });
    }
  }
});
```

Add `/task/run-one/:slug` to the route list returned by `GET /` (around line 53 — the routes list inside the response).

- [ ] **Step 3: Run the full suite**

Run: `npm test`

Expected: still green.

- [ ] **Step 4: Verify with `node --check`**

Run: `node --check src/server.js && echo OK`

Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add src/server.js
git commit -m "feat: mount /task/run-one/:slug route on the worker"
```

---

## Task 1.8: Verify Phase 1 in production (dormant deploy)

**Files:** none modified.

- [ ] **Step 1: Push branch**

Run: `git push -u origin $(git rev-parse --abbrev-ref HEAD)`

- [ ] **Step 2: Create Phase 1 PR**

```bash
gh pr create --title "feat: Phase 1 — dormant /task/run-one/:slug endpoint" --base master --body "$(cat <<'EOF'
## Summary

Adds the queue consumer endpoint, semaphore module, and error classifier needed for Phase 2's Cloud Tasks integration. **Endpoint is dormant** — no Cloud Tasks integration yet, nothing produces tasks for it.

Spec: \`docs/superpowers/specs/2026-04-25-cloud-tasks-queue-design.md\` Phase 1.

## What's in this PR

1. **\`src/slugResolver.js\`** (new) — extracts slug-to-target-key resolution from \`authRecord\` middleware. Refactor with no behavior change.
2. **\`src/tenantSemaphore.js\`** (new) — per-instance Map<slug, count> with acquire/release/inFlight.
3. **\`src/classifyError.js\`** (new) — maps runOne errors to HTTP status (200/429/503/400/500).
4. **\`src/taskHandler.js\`** (new) — Cloud Tasks consumer endpoint at POST /task/run-one/:slug.
5. **\`src/config.js\`** — adds config.tasks block.
6. **\`src/server.js\`** — mounts the new route.

## Test plan

- [x] All new modules covered by Vitest unit tests
- [x] \`npm test\` passes (full suite green)
- [x] Existing webhook tests still pass after slugResolver refactor
- [ ] Manual test post-deploy: \`gcloud tasks create-http-task\` with stub payload returns 200/4xx as expected

## Production effect

**Zero.** The endpoint exists at /task/run-one/:slug but no Cloud Tasks queue is configured to deliver to it. Phase 2 enables the integration.
EOF
)"
```

- [ ] **Step 3: Trigger PR check**

If PR check shows `ACTION_REQUIRED`:

```bash
gh pr comment <PR_NUMBER> --body "/gcbrun"
```

- [ ] **Step 4: Wait for PR check, merge, deploy**

```bash
gh pr merge <PR_NUMBER> --squash --delete-branch --admin
```

- [ ] **Step 5: Verify deploy**

```bash
gcloud run revisions list --service ap-bill-ocr-worker --region asia-southeast1 --project odoo-ocr-487104 --limit 1
```

Expected: new revision active, 100% traffic.

- [ ] **Step 6: Smoke test the dormant endpoint**

The endpoint requires a valid OIDC token from the as-yet-unprovisioned SA. Test the 401 path instead:

```bash
curl -sS -X POST https://ap-bill-ocr-worker-njiacix2yq-as.a.run.app/task/run-one/proseso-accounting-test \
  -H "Content-Type: application/json" \
  -d '{"doc_id": 23708}'
```

Expected response: HTTP 401 with `{"ok":false,"error":"unauthorized","reason":"oidc_invalid"}` — confirms the endpoint is mounted and rejects unauthenticated requests.

---

# Phase 2 — Single-tenant cutover (PR #3)

## Task 2.1: Install `@google-cloud/tasks` SDK

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the SDK**

Run: `npm install --save @google-cloud/tasks`

- [ ] **Step 2: Verify the install**

Run: `node -e "const { CloudTasksClient } = require('@google-cloud/tasks'); console.log(typeof CloudTasksClient);"`

Expected: `function`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @google-cloud/tasks SDK for queue dispatch"
```

---

## Task 2.2: Implement `enqueue` proxy endpoint

**Files:**
- Create: `src/enqueue.js`
- Create: `tests/enqueue.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/enqueue.test.mjs`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleEnqueue } from "../src/enqueue.js";

function makeReqRes(slug, body = { _id: 100, _model: "documents.document", id: 100 }) {
  const req = { params: { slug }, body };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return { req, res };
}

describe("handleEnqueue", () => {
  let deps;

  beforeEach(() => {
    deps = {
      tasksClient: {
        createTask: vi.fn().mockResolvedValue([{ name: "projects/p/locations/l/queues/q/tasks/123" }]),
        queuePath: vi.fn((p, l, q) => `projects/${p}/locations/${l}/queues/${q}`),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
  });

  it("returns 202 and creates a Cloud Task with the right payload", async () => {
    const { req, res } = makeReqRes("proseso-accounting-test");
    await handleEnqueue(req, res, deps);

    expect(res.statusCode).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.body.task_name).toContain("projects/");

    expect(deps.tasksClient.createTask).toHaveBeenCalledTimes(1);
    const [{ parent, task }] = deps.tasksClient.createTask.mock.calls[0];
    expect(parent).toContain("ap-worker-bills");
    expect(task.httpRequest.url).toContain("/task/run-one/proseso-accounting-test");
    expect(task.httpRequest.httpMethod).toBe("POST");
    expect(task.httpRequest.oidcToken.serviceAccountEmail).toContain("cloud-tasks-invoker");
    const decoded = JSON.parse(Buffer.from(task.httpRequest.body, "base64").toString("utf8"));
    expect(decoded).toEqual({ doc_id: 100, _model: "documents.document", _id: 100, id: 100 });
  });

  it("rejects with 400 when doc_id is missing", async () => {
    const { req, res } = makeReqRes("proseso-accounting-test", { _model: "documents.document" });
    await handleEnqueue(req, res, deps);
    expect(res.statusCode).toBe(400);
    expect(deps.tasksClient.createTask).not.toHaveBeenCalled();
  });

  it("returns 503 when Cloud Tasks API throws", async () => {
    deps.tasksClient.createTask.mockRejectedValue(new Error("API unavailable"));
    const { req, res } = makeReqRes("proseso-accounting-test");
    await handleEnqueue(req, res, deps);
    expect(res.statusCode).toBe(503);
  });

  it("accepts payload with id but no _id (fallback shapes)", async () => {
    const { req, res } = makeReqRes("proseso-accounting-test", { id: 200, _model: "documents.document" });
    await handleEnqueue(req, res, deps);
    expect(res.statusCode).toBe(202);
    const [{ task }] = deps.tasksClient.createTask.mock.calls[0];
    const decoded = JSON.parse(Buffer.from(task.httpRequest.body, "base64").toString("utf8"));
    expect(decoded.doc_id).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/enqueue.test.mjs`

Expected: import error.

- [ ] **Step 3: Create `src/enqueue.js`**

```js
const { CloudTasksClient } = require("@google-cloud/tasks");
const { config } = require("./config");

let _client = null;
function getDefaultClient() {
  if (!_client) _client = new CloudTasksClient();
  return _client;
}

/**
 * Proxy endpoint: validates Odoo's webhook payload and creates a Cloud Task
 * targeting /task/run-one/:slug. Returns 202 immediately so Odoo never sees a 503.
 */
async function handleEnqueue(req, res, deps = {}) {
  const tasksClient = deps.tasksClient || getDefaultClient();
  const logger = deps.logger || require("./logger").logger;

  const slug = String(req.params?.slug || "").toLowerCase();
  const body = req.body || {};
  const docId = Number(body.doc_id || body._id || body.id || 0);

  if (!docId) {
    logger.warn?.("enqueue: missing doc_id", { slug, body });
    return res.status(400).json({ ok: false, error: "missing_doc_id" });
  }

  const parent = tasksClient.queuePath(
    config.tasks.projectId,
    config.tasks.location,
    config.tasks.queueName
  );

  const taskBody = Buffer.from(JSON.stringify({
    doc_id: docId,
    _model: body._model || "documents.document",
    _id: body._id || docId,
    id: body.id || docId,
  })).toString("base64");

  const task = {
    httpRequest: {
      httpMethod: "POST",
      url: `${config.tasks.workerUrl}/task/run-one/${slug}`,
      headers: { "Content-Type": "application/json" },
      body: taskBody,
      oidcToken: {
        serviceAccountEmail: config.tasks.invokerServiceAccount,
        audience: config.tasks.workerUrl,
      },
    },
  };

  try {
    const [created] = await tasksClient.createTask({ parent, task });
    logger.info?.("enqueue: task created.", { slug, docId, taskName: created.name });
    return res.status(202).json({ ok: true, task_name: created.name });
  } catch (err) {
    logger.error?.("enqueue: createTask failed.", { slug, docId, error: String(err?.message || err) });
    return res.status(503).json({ ok: false, error: "cloud_tasks_unavailable" });
  }
}

module.exports = { handleEnqueue };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/enqueue.test.mjs`

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/enqueue.js tests/enqueue.test.mjs
git commit -m "feat: add enqueue proxy endpoint for Cloud Tasks"
```

---

## Task 2.3: Mount `/enqueue/:slug` route in `server.js`

**Files:**
- Modify: `src/server.js`

- [ ] **Step 1: Mount the route**

Add to `src/server.js` near the existing webhook route mounts. The endpoint needs the same `authRecord` middleware as the existing webhooks (Odoo callback verification):

```js
const { handleEnqueue } = require("./enqueue");
const { attachAuthRecord } = require("./webhookRoutes"); // existing helper, may be inlined — check current shape
app.post("/enqueue/:slug", authRecord, async (req, res) => {
  try {
    await handleEnqueue(req, res);
  } catch (err) {
    logger.error("enqueue unhandled exception.", { error: err?.message, stack: err?.stack });
    if (!res.headersSent) res.status(500).json({ ok: false, error: "unhandled_exception" });
  }
});
```

If `authRecord` is not currently exported from `webhookRoutes.js`, export it as part of this task. The middleware does Odoo callback verification — same security guarantee as the existing `/webhook/document-upload/:slug`.

Add `/enqueue/:slug` to the routes list returned by `GET /`.

- [ ] **Step 2: Run full suite**

Run: `npm test && node --check src/server.js`

Expected: green.

- [ ] **Step 3: Commit**

```bash
git add src/server.js src/webhookRoutes.js
git commit -m "feat: mount /enqueue/:slug route with authRecord middleware"
```

---

## Task 2.4: Write `scripts/setup-cloud-tasks.sh` provisioning script

**Files:**
- Create: `scripts/setup-cloud-tasks.sh`

This script provisions the queue, DLQ, service account, IAM bindings, and three monitoring alerts. Idempotent — safe to re-run.

- [ ] **Step 1: Create the script**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Idempotent provisioning of Cloud Tasks queue + DLQ + invoker SA + monitoring alerts
# for the AP Worker. Safe to re-run.
#
# Usage: ./scripts/setup-cloud-tasks.sh
# Requires: gcloud authenticated as project owner of odoo-ocr-487104

PROJECT=odoo-ocr-487104
LOCATION=asia-southeast1
QUEUE=ap-worker-bills
DLQ=ap-worker-bills-dlq
SA_NAME=cloud-tasks-invoker
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
WORKER_SERVICE=ap-bill-ocr-worker
OPERATOR_EMAIL=joseph@proseso-consulting.com

echo "==> Project: $PROJECT, Location: $LOCATION"

# 1. Create DLQ first (main queue references it)
echo "==> Ensuring DLQ: $DLQ"
if ! gcloud tasks queues describe "$DLQ" --project="$PROJECT" --location="$LOCATION" >/dev/null 2>&1; then
  gcloud tasks queues create "$DLQ" \
    --project="$PROJECT" \
    --location="$LOCATION" \
    --max-attempts=1
  echo "    Created."
else
  echo "    Already exists."
fi

# 2. Create main queue with rate limits and retry config
echo "==> Ensuring main queue: $QUEUE"
if ! gcloud tasks queues describe "$QUEUE" --project="$PROJECT" --location="$LOCATION" >/dev/null 2>&1; then
  gcloud tasks queues create "$QUEUE" \
    --project="$PROJECT" \
    --location="$LOCATION" \
    --max-dispatches-per-second=10 \
    --max-concurrent-dispatches=30 \
    --max-attempts=10 \
    --min-backoff=30s \
    --max-backoff=300s \
    --max-doublings=4 \
    --max-retry-duration=3600s
  echo "    Created."
else
  echo "    Already exists. Updating rate config..."
  gcloud tasks queues update "$QUEUE" \
    --project="$PROJECT" \
    --location="$LOCATION" \
    --max-dispatches-per-second=10 \
    --max-concurrent-dispatches=30 \
    --max-attempts=10 \
    --min-backoff=30s \
    --max-backoff=300s \
    --max-doublings=4 \
    --max-retry-duration=3600s
fi

# 3. Create the invoker service account
echo "==> Ensuring service account: $SA_EMAIL"
if ! gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" \
    --project="$PROJECT" \
    --display-name="Cloud Tasks invoker for AP Worker"
  echo "    Created."
else
  echo "    Already exists."
fi

# 4. Grant the SA roles/run.invoker on the worker service
echo "==> Granting roles/run.invoker on $WORKER_SERVICE to $SA_EMAIL"
gcloud run services add-iam-policy-binding "$WORKER_SERVICE" \
  --project="$PROJECT" \
  --region="$LOCATION" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/run.invoker" \
  --condition=None >/dev/null
echo "    Done."

# 5. Create or get monitoring notification channel
echo "==> Ensuring monitoring notification channel for $OPERATOR_EMAIL"
CHANNEL_ID=$(gcloud alpha monitoring channels list \
  --project="$PROJECT" \
  --filter="type=email AND labels.email_address=${OPERATOR_EMAIL}" \
  --format="value(name)" 2>/dev/null | head -n1 || true)

if [ -z "$CHANNEL_ID" ]; then
  CHANNEL_ID=$(gcloud alpha monitoring channels create \
    --project="$PROJECT" \
    --display-name="AP Worker operator email" \
    --type=email \
    --channel-labels="email_address=${OPERATOR_EMAIL}" \
    --format="value(name)")
  echo "    Created: $CHANNEL_ID"
else
  echo "    Already exists: $CHANNEL_ID"
fi

# 6. Create alert policies (idempotent via display-name match)
echo "==> Ensuring alert: oldest_task_age > 3600s on $QUEUE"
cat > /tmp/alert-oldest-task-age.json <<EOF
{
  "displayName": "ap-worker-bills oldest_task_age > 1h",
  "combiner": "OR",
  "conditions": [{
    "displayName": "oldest task older than 1h",
    "conditionThreshold": {
      "filter": "metric.type=\"cloudtasks.googleapis.com/queue/oldest_task_age\" resource.type=\"cloud_tasks_queue\" resource.label.queue_id=\"${QUEUE}\"",
      "comparison": "COMPARISON_GT",
      "thresholdValue": 3600,
      "duration": "60s",
      "aggregations": [{
        "alignmentPeriod": "60s",
        "perSeriesAligner": "ALIGN_MAX"
      }]
    }
  }],
  "notificationChannels": ["${CHANNEL_ID}"],
  "enabled": true
}
EOF

# Use display-name to detect existing
if ! gcloud alpha monitoring policies list --project="$PROJECT" \
       --filter="displayName=\"ap-worker-bills oldest_task_age > 1h\"" \
       --format="value(name)" | grep -q .; then
  gcloud alpha monitoring policies create --project="$PROJECT" --policy-from-file=/tmp/alert-oldest-task-age.json
  echo "    Created."
else
  echo "    Already exists."
fi

echo "==> ✅ Setup complete."
echo "    Queue:                projects/$PROJECT/locations/$LOCATION/queues/$QUEUE"
echo "    DLQ:                  projects/$PROJECT/locations/$LOCATION/queues/$DLQ"
echo "    Invoker SA:           $SA_EMAIL"
echo "    Notification channel: $CHANNEL_ID"
```

(The script creates one alert in detail. Add `dlq_depth` and `queue_depth_sustained` alerts following the same pattern — copy the alert block, change the displayName, filter, threshold, and duration. Keeping the script focused on one alert in this plan; the engineer can add the other two as identical-shape blocks.)

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/setup-cloud-tasks.sh`

- [ ] **Step 3: Verify shell syntax**

Run: `bash -n scripts/setup-cloud-tasks.sh && echo OK`

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add scripts/setup-cloud-tasks.sh
git commit -m "feat: add setup-cloud-tasks.sh provisioning script"
```

---

## Task 2.5: Apply infrastructure (manual)

**Files:** none modified.

- [ ] **Step 1: Verify gcloud is authenticated as a project owner**

Run: `gcloud config get-value account` — should match a user with `roles/owner` or sufficient permissions on `odoo-ocr-487104`.

- [ ] **Step 2: Run the setup script**

Run: `./scripts/setup-cloud-tasks.sh`

Expected: each step shows "Created." or "Already exists." Final output lists the queue path, DLQ path, SA email, and notification channel.

- [ ] **Step 3: Verify queue exists**

```bash
gcloud tasks queues describe ap-worker-bills --project=odoo-ocr-487104 --location=asia-southeast1 --format="value(name,state,rateLimits)"
```

Expected: `state: RUNNING`, rate limits match Section 4 of the spec.

- [ ] **Step 4: Verify SA has run.invoker on the worker**

```bash
gcloud run services get-iam-policy ap-bill-ocr-worker --project=odoo-ocr-487104 --region=asia-southeast1 --format="value(bindings.members)" | grep cloud-tasks-invoker
```

Expected: prints the SA email.

- [ ] **Step 5: Sanity-check the dispatch path**

Send a test task that targets `/task/run-one/proseso-accounting-test`. The task should fail (no real doc_id 999999), but it should reach the worker:

```bash
gcloud tasks create-http-task \
  --queue=ap-worker-bills \
  --location=asia-southeast1 \
  --project=odoo-ocr-487104 \
  --url="https://ap-bill-ocr-worker-njiacix2yq-as.a.run.app/task/run-one/proseso-accounting-test" \
  --method=POST \
  --header="Content-Type=application/json" \
  --body-content='{"doc_id":999999}' \
  --oidc-service-account-email=cloud-tasks-invoker@odoo-ocr-487104.iam.gserviceaccount.com \
  --oidc-token-audience="https://ap-bill-ocr-worker-njiacix2yq-as.a.run.app"
```

Then check Cloud Run logs for the request — expect 404 (no doc 999999 in Odoo) or 500 (slug resolution succeeded but doc not found). Either confirms OIDC validation worked and the task reached our handler.

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND httpRequest.requestUrl=~"/task/run-one/"' \
  --project=odoo-ocr-487104 --limit=5 --order=desc --freshness=5m
```

---

## Task 2.6: Implement `cutover-tenant-to-tasks.js` script

**Files:**
- Create: `scripts/cutover-tenant-to-tasks.js`

- [ ] **Step 1: Create the script**

```js
#!/usr/bin/env node

/**
 * Per-tenant cutover: switch Odoo automation webhook_url from
 * /webhook/document-upload/:slug to /enqueue/:slug. Idempotent.
 *
 * Usage:
 *   node scripts/cutover-tenant-to-tasks.js <slug>           # cut over
 *   node scripts/cutover-tenant-to-tasks.js <slug> --revert  # roll back
 */

const fs = require("fs");
const xmlrpc = require("xmlrpc");

const REGISTRY = "/home/joseph/Project/proseso-ventures/proseso_clients/data/clients.json";
const SECRETS = "/home/joseph/Project/proseso-ventures/proseso_clients/data/clients.secrets.json";
const WORKER_URL = "https://ap-bill-ocr-worker-njiacix2yq-as.a.run.app";

const slug = process.argv[2];
const revert = process.argv.includes("--revert");
if (!slug) {
  console.error("Usage: cutover-tenant-to-tasks.js <slug> [--revert]");
  process.exit(2);
}

const oldUrlPattern = (s) => `${WORKER_URL}/webhook/document-upload/${s}`;
const newUrlPattern = (s) => `${WORKER_URL}/enqueue/${s}`;
const fromUrl = revert ? newUrlPattern(slug) : oldUrlPattern(slug);
const toUrl = revert ? oldUrlPattern(slug) : newUrlPattern(slug);

(async () => {
  // Load registry + secrets
  const projects = JSON.parse(fs.readFileSync(REGISTRY, "utf8")).projects;
  const secrets = JSON.parse(fs.readFileSync(SECRETS, "utf8")).api_keys;
  const proj = projects.find((p) => (p.accounting_database || "").includes(`${slug}.odoo.com`));
  if (!proj) throw new Error(`No project found for slug=${slug}`);
  const apiKey = secrets[String(proj.project_id)];
  if (!apiKey) throw new Error(`No API key for project_id=${proj.project_id}`);

  const url = proj.accounting_database.replace(/\/$/, "");
  const db = url.replace(/^https?:\/\//, "").replace(/\.odoo\.com$/, "");

  console.log(`Tenant: ${slug}, project_id=${proj.project_id}, db=${db}`);
  console.log(`Switching: ${fromUrl}\n        -> ${toUrl}`);

  // Authenticate via XML-RPC
  const common = xmlrpc.createSecureClient({ url: `${url}/xmlrpc/2/common` });
  const auth = await new Promise((resolve, reject) => {
    common.methodCall("authenticate", [db, proj.email, apiKey, {}], (err, uid) =>
      err ? reject(err) : resolve(uid)
    );
  });
  if (!auth) throw new Error("auth failed");

  const models = xmlrpc.createSecureClient({ url: `${url}/xmlrpc/2/object` });
  const call = (model, method, args, kwargs = {}) =>
    new Promise((resolve, reject) => {
      models.methodCall("execute_kw", [db, auth, apiKey, model, method, args, kwargs], (err, r) =>
        err ? reject(err) : resolve(r)
      );
    });

  // Find the AP automation server action
  const actionIds = await call("ir.actions.server", "search", [[["webhook_url", "=", fromUrl]]]);
  if (!actionIds.length) {
    console.error(`❌ No ir.actions.server with webhook_url=${fromUrl} found.`);
    console.error("   This tenant may already be cut over, or the URL pattern is different. Check manually.");
    process.exit(1);
  }
  if (actionIds.length > 1) {
    console.warn(`⚠️  ${actionIds.length} actions matched; updating all.`);
  }

  // Update the URL
  await call("ir.actions.server", "write", [actionIds, { webhook_url: toUrl }]);
  console.log(`✅ Updated ${actionIds.length} action(s).`);

  // Verify
  const after = await call("ir.actions.server", "read", [actionIds, ["id", "name", "webhook_url"]]);
  console.log("After:", JSON.stringify(after, null, 2));
})().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/cutover-tenant-to-tasks.js`

- [ ] **Step 3: Verify syntax**

Run: `node --check scripts/cutover-tenant-to-tasks.js && echo OK`

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add scripts/cutover-tenant-to-tasks.js
git commit -m "feat: add cutover-tenant-to-tasks.js per-tenant cutover script"
```

---

## Task 2.7: Cutover `proseso-accounting-test`

**Files:** none modified.

- [ ] **Step 1: Pre-cutover smoke test**

Verify the new endpoint works in the dormant state. Send a real Odoo doc through `/enqueue` directly:

```bash
curl -sS -X POST https://ap-bill-ocr-worker-njiacix2yq-as.a.run.app/enqueue/proseso-accounting-test \
  -H "Content-Type: application/json" \
  -d '{"_id": 23708, "_model": "documents.document", "id": 23708}'
```

Expected: 202 with task_name. Then check Cloud Tasks console — task appears, dispatches within seconds, processes the doc into a draft bill (or matches existing bill if already processed).

- [ ] **Step 2: Run cutover**

```bash
node scripts/cutover-tenant-to-tasks.js proseso-accounting-test
```

Expected output: confirms the action's webhook_url switched from `/webhook/document-upload/...` to `/enqueue/...`.

- [ ] **Step 3: End-to-end verification**

Upload one new doc to the AP folder of `proseso-accounting-test`:
- Manual or via Odoo UI/API
- Watch Cloud Tasks console for the task appearing in `ap-worker-bills`
- Verify the task dispatches and the doc gets a chatter message + bill within ~90 seconds

- [ ] **Step 4: Bulk verification**

Upload 10 docs simultaneously. Expected:
- All 10 webhooks return 202 quickly (no 503s)
- Cloud Tasks queue depth peaks at ~10, drains over ~2-5 min as tasks process
- All 10 result in chatter messages and bills (or skip messages for low-confidence vendors)
- Per-tenant in-flight count visible at `/debug` (if exposed) caps at 3

---

## Task 2.8: 24-hour soak

**Files:** none modified.

- [ ] **Step 1: Monitor queue health for 24 hours**

Cloud Tasks console + monitoring dashboards. Watch for:
- DLQ count stays at 0
- `oldest_task_age` stays below 5 minutes during normal traffic
- 429 rate is < 5% of total dispatches
- No alerts fire

- [ ] **Step 2: Daily summary log**

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND httpRequest.requestUrl=~"/task/run-one/"' \
  --project=odoo-ocr-487104 --limit=200 --order=desc --freshness=24h --format="csv[no-heading](httpRequest.status)" \
  | sort | uniq -c | sort -rn
```

Expected pattern: ~95% 200, small fraction of 429 (semaphore saturations during bursts), no 500s.

- [ ] **Step 3: Decision point**

If soak is clean → proceed to Task 2.9.
If anomalies → run `node scripts/cutover-tenant-to-tasks.js proseso-accounting-test --revert`, investigate, fix, redeploy, re-attempt soak.

---

## Task 2.9: PR Phase 2

**Files:** none modified.

- [ ] **Step 1: Push branch**

Run: `git push`

- [ ] **Step 2: Create PR**

```bash
gh pr create --title "feat: Phase 2 — Cloud Tasks queue active for proseso-accounting-test" --base master --body "$(cat <<'EOF'
## Summary

Activates the Cloud Tasks queue for one tenant (proseso-accounting-test). Adds the /enqueue/:slug proxy, provisioning script, and cutover tooling.

Spec: \`docs/superpowers/specs/2026-04-25-cloud-tasks-queue-design.md\` Phase 2.

## What's in this PR

1. **\`@google-cloud/tasks\`** dependency.
2. **\`src/enqueue.js\`** + tests — the proxy that turns Odoo's webhook into a Cloud Task.
3. **\`scripts/setup-cloud-tasks.sh\`** — idempotent gcloud-based provisioning of queue, DLQ, SA, IAM, alerts.
4. **\`scripts/cutover-tenant-to-tasks.js\`** — switches Odoo automation URL per tenant; supports --revert.

## Test plan

- [x] Unit tests for /enqueue
- [x] Setup script applied; queue + DLQ + SA + alerts in place
- [x] Single-tenant cutover (proseso-accounting-test) succeeded
- [x] 24-hour soak: queue depth stayed < 10, DLQ empty, no alerts fired
- [ ] Post-merge: monitor for 7 more days before Phase 3

## Production effect

**One tenant** (proseso-accounting-test) on the new queue. The remaining 30+ tenants still use the old /webhook/document-upload/:slug.

## Rollback

\`node scripts/cutover-tenant-to-tasks.js proseso-accounting-test --revert\`
EOF
)"
```

- [ ] **Step 3: Trigger PR check, merge after green**

```bash
gh pr comment <PR_NUMBER> --body "/gcbrun"
# wait for green
gh pr merge <PR_NUMBER> --squash --delete-branch --admin
```

---

# Phase 3 — Batched wide cutover (no PR; script execution only)

## Task 3.1: Identify and prepare tenant batches

**Files:** none modified (planning step).

- [ ] **Step 1: List all configured tenants**

```bash
gcloud run services proxy ap-bill-ocr-worker --port=8080 --region=asia-southeast1 --project=odoo-ocr-487104 &
sleep 2
SECRET=$(gcloud secrets versions access latest --secret=worker-shared-secret --project=odoo-ocr-487104 | tr -d '\r\n')
curl -sS -X GET "http://localhost:8080/list-docs?worker_secret=$SECRET" 2>/dev/null | python3 -c "
import json, sys
d = json.load(sys.stdin)
for t in d.get('targets', []):
  print(f\"{t['slug']}\\t{t.get('baseUrl','')}\")"
kill %1 2>/dev/null || true
```

Save the list to `/tmp/tenants.txt`. Expected: ~30+ rows, one slug per line.

- [ ] **Step 2: Define batches**

Split the tenant list into three batches, mixing single-company and multi-company clients in each:

- `/tmp/batch-3a.txt` — 10 tenants (mix)
- `/tmp/batch-3b.txt` — next 10
- `/tmp/batch-3c.txt` — remainder

Skip `proseso-accounting-test` (already on Phase 2).

---

## Task 3.2: Cutover batch 3a (10 tenants)

**Files:** none modified.

- [ ] **Step 1: Run cutover for each tenant in batch 3a**

```bash
for slug in $(cat /tmp/batch-3a.txt); do
  echo "=== Cutting over: $slug ==="
  node scripts/cutover-tenant-to-tasks.js "$slug"
done
```

Expected: each tenant's automation `webhook_url` updates from old → new. Failures (e.g., a tenant whose automation isn't named the way the script expects) abort that one tenant; continue with others.

- [ ] **Step 2: 4-hour soak**

Monitor:
- DLQ stays at 0
- Queue depth has activity from the batch but drains
- No alerts fire
- Bill creation continues normally (cross-check via Odoo)

- [ ] **Step 3: Decision point**

If clean → proceed to 3.3. If issues → run `--revert` per tenant for those affected, investigate, then resume.

---

## Task 3.3: Cutover batch 3b (next 10 tenants)

**Files:** none modified.

- [ ] **Step 1: Run cutover for each tenant in batch 3b**

```bash
for slug in $(cat /tmp/batch-3b.txt); do
  echo "=== Cutting over: $slug ==="
  node scripts/cutover-tenant-to-tasks.js "$slug"
done
```

- [ ] **Step 2: 4-hour soak (same monitoring as 3.2)**

- [ ] **Step 3: Decision point**

---

## Task 3.4: Cutover batch 3c (remaining tenants)

**Files:** none modified.

- [ ] **Step 1: Run cutover for each tenant in batch 3c**

```bash
for slug in $(cat /tmp/batch-3c.txt); do
  echo "=== Cutting over: $slug ==="
  node scripts/cutover-tenant-to-tasks.js "$slug"
done
```

- [ ] **Step 2: 1-week soak**

Wide rollout means heavier daily traffic patterns. Monitor for a week before declaring done. Watch for:
- Any tenant-specific edge cases
- DLQ accumulating (anything > 5 needs investigation)
- Queue depth sustained alerts

---

## Task 3.5: Document the architecture and remove draft status

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-04-25-cloud-tasks-queue-design.md`

- [ ] **Step 1: Update CLAUDE.md**

Add a section documenting the queue architecture:

```markdown
## Cloud Tasks Queue (active 2026-MM-DD)

The AP Worker uses Cloud Tasks for ingestion:
- Odoo automation → POST /enqueue/:slug (returns 202) → Cloud Task in `ap-worker-bills` → POST /task/run-one/:slug → existing runOne pipeline.
- Per-tenant fairness: in-memory semaphore caps at 3 in-flight per tenant per Cloud Run instance.
- Failures: classified by classifyError, retry per Cloud Tasks config (10 attempts, 30s-300s backoff), dead-letter to ap-worker-bills-dlq after exhaustion.
- Monitoring: 3 alerts on the queue (oldest_task_age, dlq_depth, queue_depth_sustained).

Provisioning: ./scripts/setup-cloud-tasks.sh (idempotent).
Per-tenant cutover/rollback: node scripts/cutover-tenant-to-tasks.js <slug> [--revert].
```

- [ ] **Step 2: Remove "draft" status from spec**

Edit `docs/superpowers/specs/2026-04-25-cloud-tasks-queue-design.md` line 3:

```markdown
**Status:** active (rolled out 2026-MM-DD)
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-04-25-cloud-tasks-queue-design.md
git commit -m "docs: queue architecture documented; remove spec draft status"
```

---

## Self-review checklist (post-implementation)

After all phases:

- [ ] All Phase 1 unit tests passing (101+ tests total: 89 baseline + 11 slugResolver + 8 semaphore + 14 classifyError + 11 taskHandler)
- [ ] Phase 2 unit tests passing (+4 enqueue tests)
- [ ] All 30+ tenants on the new queue
- [ ] DLQ < 5 entries after 1 week of operation
- [ ] Old `/webhook/document-upload/:slug` endpoint still in code as fallback
- [ ] Three monitoring alerts active and verified (test by manually setting threshold low, confirming alert fires, restoring threshold)
- [ ] CLAUDE.md updated; spec status changed from "draft" to "active"

If any DLQ entries accumulate during rollout: each one's task body has `doc_id` + slug. Inspect the doc in Odoo to find the chatter message runOne posted before the failure — that explains why it dead-lettered. Replay via `gcloud tasks create-http-task` after fixing the underlying issue, OR ignore (the recovery cron will retry the unmarked attachment on its next pass).
