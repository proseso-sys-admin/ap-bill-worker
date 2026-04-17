# Webhook Auth Hardening — callback-verification + tenant-slug

## Why

The `worker_secret=Papaya3562` query string on all 6 Odoo webhook rules lands in Cloud Run access logs and any intermediate proxy logs. Odoo SaaS 19.1's built-in `ir.actions.server` webhook action has no `webhook_headers`, no signature support, and no way to inject static values into the POST body. Code-state server actions on SaaS sandbox `requests`/`urllib`. Conclusion: **there is no way to keep a shared secret out of the URL** using SaaS-supported features.

Fix: switch the webhook auth model from "shared secret in URL" to "Odoo callback verification + tenant slug in URL path." The worker authenticates each webhook by re-reading the claimed record from the claimed tenant using its own stored XML-RPC credentials — the record existing is the auth proof.

## Scope

In scope:
- Worker (`src/server.js`, `src/worker.js`, `src/config.js`) — add new `/webhook/<type>/:slug` endpoints with callback auth, rate limit, and tenant routing by slug.
- Tests (`tests/`) — set up Vitest, write unit tests for callback auth + rate limiter (TDD).
- Odoo test DB (`proseso-accounting-test`) — update rules 1–6 to new URL form after worker ships.
- Secret Manager — rotate `worker-shared-secret` (still used by admin endpoints `/run`, `/run-one`, `/list-docs`, `/debug`, `/collect-feedback`).

Out of scope:
- Production Odoo (no prod tenants on this Cloud Run yet — confirmed by user).
- Changing admin-endpoint auth (keep `X-Worker-Secret` header or body field).
- Signature support (not offered by Odoo SaaS).

## Plan

### Phase 1 — Worker changes (TDD)

- [x] Step 1 — create `tests/` scaffold, add `vitest` to package.json, write failing tests for `verifyWebhookTenant(slug, _model, _id)`:
  - valid slug + record exists in that tenant → `{ok: true, target}`
  - slug unknown → `{ok: false, reason: "unknown_tenant"}`
  - slug known but record missing → `{ok: false, reason: "record_not_found"}`
  - Odoo call throws → `{ok: false, reason: "odoo_error"}`
- [x] Step 2 — write failing tests for in-memory token-bucket rate limiter:
  - first N requests pass, N+1 returns `429` with `Retry-After`
  - separate buckets per slug
  - bucket refills over time
- [x] Step 3 — implement `src/webhookAuth.js` with `verifyWebhookTenant` using `getTargets` + `OdooClient.read`. Implement `src/rateLimiter.js` token bucket (per-slug, in-memory, 60 req/min default, env var override).
- [x] Step 4 — add new routes in `src/server.js`:
  - `POST /webhook/document-upload/:slug`
  - `POST /webhook/document-delete/:slug`
  - `POST /webhook/chatter-message/:slug`
  - `POST /webhook/bs-document-upload/:slug`
  - `POST /webhook/bs-document-delete/:slug`
  - `POST /webhook/bs-chatter-message/:slug`
  Each reuses the existing handler body but auth path is `rateLimit(slug)` → `verifyWebhookTenant` → handler, with `target_key` derived from the resolved tenant instead of trusting the body. Old `/webhook/<type>` routes stay live during cutover.
- [x] Step 5 — slug = `target.targetCfg.db` (DB name); no new routing field needed.
- [x] Step 6 — integration tests via supertest in `tests/webhookRoutes.test.mjs`: 11 scenarios covering happy path, all 6 routes, unknown slug, missing record, 400 validation, rate limit, handler errors.
- [x] Step 7 — `npm test`: 22/22 green. PR-check (`cloudbuild-pr.yaml`) updated to run `npm run check && npm test`.

### Phase 2 — Deploy + cutover

- [ ] Step 8 — open PR, cloudbuild-pr runs, merge to master → Cloud Build deploys.
- [ ] Step 9 — smoke-test new endpoint from local with curl: `curl -X POST .../webhook/document-upload/proseso-accounting-test -d '{"_id": <known-doc>, "_model": "documents.document"}'`. Expect 200.
- [ ] Step 10 — update Odoo rules 1–6 to new URL form (via MCP):
  | Rule | New URL |
  |------|---------|
  | 479 (doc upload) | `https://ap-bill-ocr-worker-njiacix2yq-as.a.run.app/webhook/document-upload/proseso-accounting-test` |
  | 480 (doc delete) | `.../webhook/document-delete/proseso-accounting-test` |
  | 481 (AP chatter) | `.../webhook/chatter-message/proseso-accounting-test` |
  | 482 (BS upload) | `.../webhook/bs-document-upload/proseso-accounting-test` |
  | 483 (BS delete) | `.../webhook/bs-document-delete/proseso-accounting-test` |
  | 484 (BS chatter) | `.../webhook/bs-chatter-message/proseso-accounting-test` |
- [ ] Step 11 — trigger a real document upload in test DB; verify Cloud Run logs show `/webhook/document-upload/proseso-accounting-test` 200 and bill is created.
- [ ] Step 12 — verify `@bot` retry path still works: add `@bot` comment on a test bill, confirm chatter-message webhook fires and is authenticated.

### Phase 3 — Retire old path + rotate secret

- [ ] Step 13 — remove old `/webhook/<type>` routes from `src/server.js`. Keep admin routes (`/run`, `/run-one`, `/list-docs`, `/debug`, `/collect-feedback`) on `isAuthorized` header/body secret.
- [ ] Step 14 — rotate `worker-shared-secret` in Secret Manager: generate 48 random bytes → base64url → write as new version. Cloud Run picks up `latest` on next deploy.
- [ ] Step 15 — redeploy (git push to master). Verify new secret works for admin endpoints via smoke test.
- [ ] Step 16 — destroy old Papaya3562 version in Secret Manager.

## Decisions

- **Slug = DB name** (e.g. `proseso-accounting-test`). Rationale: already unique per tenant, no new custom field needed on General task, self-documenting in URLs. Alternative (short slug like `test`) was rejected — requires new field, risks collision across operators.
- **Rate limit = 60 req/min per slug.** Odoo's bulk operations can fire many webhooks quickly (e.g. uploading a batch of PDFs). 60/min tolerates a 1-per-second sustained rate with 60-burst. Override via `WEBHOOK_RATE_LIMIT_PER_MIN` env var.
- **Rate limiter is in-memory** (single Cloud Run instance). Rationale: current Cloud Run config is `--max-instances=1` (implied — not set) and traffic is low. If we ever scale out, revisit with Redis/Memorystore.
- **Callback verification does not check attachment presence or folder.** Only record existence. Existing handlers already validate folder membership (`resolveSubfolderIds`) before processing.
- **Old routes stay during cutover** so we can deploy worker without breaking existing rules. Old routes removed in Phase 3.

## Review

- Completed: <date>
- What went well:
- What to improve next time:
