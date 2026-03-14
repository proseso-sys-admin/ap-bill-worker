

---# AP Bill OCR Worker (Cloud Run)

This service moves the heavy AP bill OCR flow out of Google Apps Script to avoid Apps Script quotas.

## What this implements

- Cloud Run worker with `GET/POST /run` HTTP endpoint.
- Routing from **Odoo** (General task on source Odoo) or from **Google Sheets** (`ProjectRouting`) via Sheets API.
- Full worker (`/run`) can process multiple target databases **in parallel** (configurable via `RUN_WORKER_TARGETS_PARALLEL`; default 1 = sequential).
- Odoo XML-RPC execution (`authenticate`, `execute_kw`, `search_read`, `create`, `write`).
- OCR path:
  - image files -> Vision `images:annotate`
  - PDF files -> Vision async OCR through GCS staging
- Gemini structured extraction for invoice fields.
- Vendor lookup, duplicate check, bill create, and processed markers.
- Optional cursor state storage in GCS per target key.
- **Webhooks:** `POST /webhook/document-upload` and `POST /webhook/document-delete` so Odoo can trigger bill creation on upload and draft bill deletion on document delete (see [Webhooks: configuring Odoo](#webhooks-configuring-odoo-to-call-the-worker)).
- Thin Apps Script trigger option (`apps_script_thin_trigger.gs`) for hybrid mode.

## Folder layout

- `src/server.js` - HTTP server and run lock.
- `src/worker.js` - orchestration and business flow.
- `src/odoo.js` - XML-RPC client wrapper for Odoo.
- `src/vision.js` - Vision OCR helpers.
- `src/gemini.js` - Gemini structured extraction call.
- `src/sheets.js` - routing loader from Google Sheets.
- `src/state.js` - state load/save from GCS object.
- `apps_script_thin_trigger.gs` - optional minimal Apps Script trigger.
- `deploy_cloud_run.ps1` - build and deploy helper.
- `cloudbuild.yaml` - Cloud Build config for CI (build + deploy to Cloud Run).
- `create_scheduler_job.ps1` - Cloud Scheduler helper.

## Environment variables

**Where to set them:**

- **Local:** Copy `.env.example` to `.env` in the project root and edit. The app loads `.env` on startup (see `src/config.js`).
- **Cloud Run:** Set env vars in the Cloud Run service (Console → Edit & deploy new revision → Variables & secrets, or `gcloud run deploy ... --set-env-vars "KEY=value,..."`).

Copy `.env.example` to `.env` and fill values.

Required:

- `SHEETS_SPREADSHEET_ID`
- `GEMINI_API_KEY`
- `GCS_BUCKET`

Strongly recommended:

- `WORKER_SHARED_SECRET` (required if endpoint is exposed)
- `STATE_BUCKET` (for cross-run cursor state)
- `DEFAULT_EXPENSE_ACCOUNT_ID` (fallback account for invoice line)
- `RUN_ONE_MAX_CONCURRENCY` (default 5) – max concurrent run-one / webhook document-upload jobs; excess get 503 and should retry
- `RUN_WORKER_TARGETS_PARALLEL` (default 1) – when running the full worker (`/run`), how many target databases to process at the same time; 1 = one after another, 2+ = that many in parallel
- `ROUTING_ODOO_TASKS_LIMIT` (default 500) – when routing from Odoo, max number of General tasks to load; increase if you have more enabled targets

**Odoo field names:** Core General task field names (which Odoo fields to read for db, industry, enabled, bill worker, email, api key, stage, multi-company, company id) come from **.env** only (`SOURCE_GENERAL_TASK_*`). Accounting/extra field names (ap folder, purchase journal, VAT goods/services/generic) come from **GCS**: if `STATE_BUCKET` or `GCS_BUCKET` is set, the worker loads `{STATE_PREFIX}/odoo_field_names.json` and uses keys `sourceGeneralTaskApFolderField`, `sourceGeneralTaskPurchaseJournalField`, `sourceGeneralTaskVatGoodsField`, `sourceGeneralTaskVatServicesField`, `sourceGeneralTaskVatGenericField` from that file (fallback to config if missing).

## Security

**Never commit real credentials.** Use `.env` for local secrets (gitignored). `.env.example` contains placeholders only.

**If an API key was exposed** (e.g. in a public repo):

1. **Regenerate the Gemini API key** in [Google AI Studio](https://aistudio.google.com/apikey) or [GCP Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. In Credentials, find the key → Edit → **Regenerate key**.
3. Update your local `.env`, Cloud Run secrets, and any deployment scripts with the new key.
4. Restrict the new key: Edit → Application restrictions (e.g. IP, referrer) and API restrictions (limit to Gemini/Vision APIs you use).

## Local run

1. Install Node.js 20+.
2. Install dependencies:
   - `npm install`
3. Start:
   - `npm start`
4. Health check:
   - `GET http://localhost:8080/healthz`
5. Trigger run:
   - `POST http://localhost:8080/run` with header `x-worker-secret`.

## gcloud project (per workspace)

gcloud’s active project is **global**, not per folder. To use the right GCP project when working in this repo:

**Option A – Script (recommended)**  
1. In `.env` set `GCP_PROJECT_ID=` to the project where Cloud Run / Cloud Build live.  
2. When you open this workspace, run:
   ```powershell
   .\set_gcloud_project.ps1
   ```
   Then `gcloud run services describe ...` and other commands use that project.

**Option B – Named gcloud config**  
Create a config for this repo and switch when you work here:
   ```powershell
   gcloud config configurations create odoo-ap-worker
   gcloud config set project YOUR_PROJECT_ID
   # When opening this workspace:
   gcloud config configurations activate odoo-ap-worker
   ```

## Deploy to Cloud Run

Use `deploy_cloud_run.ps1`:

```powershell
.\deploy_cloud_run.ps1 -ProjectId "<project-id>" -Region "<region>" -ServiceName "ap-bill-ocr-worker" -ServiceAccount "<sa>@<project>.iam.gserviceaccount.com"
```

Then create scheduler:

```powershell
.\create_scheduler_job.ps1 -ProjectId "<project-id>" -Region "<region>" -WorkerUrl "https://<service-url>" -WorkerSecret "<secret>"
```

## Redeploy on git push (GitHub + Cloud Build)

1. **Connect GitHub**
   - Open [Cloud Build → Repositories](https://console.cloud.google.com/cloud-build/repositories) (project `odoo-ocr-487104`).
   - Select the **1st gen** tab → **Connect repository**.
   - Source: **GitHub (Cloud Build GitHub App)** → Continue.
   - Sign in to GitHub if needed; install **Google Cloud Build** on your account/org and choose **Only select repositories** → pick this repo → Install.
   - Back in GCP: choose the repo, accept the disclaimer → **Connect**.

2. **Create trigger**
   - Go to [Cloud Build → Triggers](https://console.cloud.google.com/cloud-build/triggers).
   - **Create trigger**.
   - Name: e.g. `ap-bill-ocr-worker-deploy`.
   - Event: **Push to a branch**; pick the repo you connected; branch `^master$` (or your main branch).
   - Configuration: **Cloud Build configuration file**; path `cloudbuild.yaml` (leave default).
   - (Optional) Substitution variables: `_REGION` = `asia-southeast1`, `_SERVICE_NAME` = `ap-bill-ocr-worker` (defaults are already in `cloudbuild.yaml`).
   - **Create**.

3. **IAM**
   - Cloud Build’s service account needs to deploy to Cloud Run and push to Artifact Registry. In project **IAM**, find `PROJECT_NUMBER@cloudbuild.gserviceaccount.com` and ensure it has **Cloud Run Admin** and **Artifact Registry Writer** (or **Storage Admin** if using GCR). If you used the same project and ran `gcloud builds submit` before, this is usually already set.

After this, every push to the selected branch will build the image and redeploy `ap-bill-ocr-worker` to Cloud Run in `asia-southeast1`.

## GCS and Secret Manager checklist (before deploy)

**GCS buckets**

- The app does **not** create buckets; they must exist and the Cloud Run service account must have access.
- **GCS_BUCKET** (e.g. `proseso-ap-ocr`): used for OCR (Vision API input/output under `GCS_INPUT_PREFIX` / `GCS_OUTPUT_PREFIX`). Create the bucket if needed; the worker will create objects under the prefixes.
- **STATE_BUCKET** (e.g. same as GCS_BUCKET or `proseso-ap-ocr-state`): used for:
  - `{STATE_PREFIX}/odoo_field_names.json` — Odoo field name overrides (optional; upload if you use GCS for those).
  - `{STATE_PREFIX}/{targetKey}.json` — cursor state per target.
  - `{ACCOUNTING_CONFIG_PREFIX}/{targetKey}.json` — accounting config cache.
  - `{DOC_BILL_MAPPING_PREFIX}/mapping.json` — doc→bill mapping for document-delete webhook.
  - `{FEEDBACK_PREFIX}/feedback.json` — feedback corrections (self-learning).
  - `{VENDOR_MEMORY_PREFIX}/vendor_memory.json` — vendor account memory.
- Grant the **Cloud Run service account** (e.g. `PROJECT_NUMBER-compute@developer.gserviceaccount.com` or your custom SA) **Storage Object Admin** (or at least read/write) on both buckets.

**Secret Manager (optional)**

- The app does **not** call Secret Manager; it only reads **environment variables**. To avoid putting secrets in plain env vars on Cloud Run, create secrets in Secret Manager and reference them when deploying:
  1. **Secret Manager** → Create secret: e.g. `worker-shared-secret`, `gemini-api-key` (and optionally source Odoo password).
  2. **Cloud Run** → Edit the service → Variables & secrets → **Reference a secret** (e.g. `WORKER_SHARED_SECRET` → `worker-shared-secret:latest`, `GEMINI_API_KEY` → `gemini-api-key:latest`).
  3. Or deploy with: `gcloud run deploy ... --update-secrets "WORKER_SHARED_SECRET=worker-shared-secret:latest,GEMINI_API_KEY=gemini-api-key:latest"`.
- Ensure the Cloud Run service account has **Secret Manager Secret Accessor** on those secrets.
- If you do **not** use Secret Manager, set `WORKER_SHARED_SECRET` and `GEMINI_API_KEY` (and any other secrets) as plain env vars in Cloud Run; avoid committing them.

**Required env vars on Cloud Run (if not using Secret Manager for them)**

- `WORKER_SHARED_SECRET`, `GEMINI_API_KEY`, `GCS_BUCKET`, `STATE_BUCKET` (or same as GCS_BUCKET), and for Odoo routing: `ROUTING_SOURCE=odoo`, `SOURCE_BASE_URL`, `SOURCE_DB`, `SOURCE_LOGIN`, `SOURCE_PASSWORD`, plus any `SOURCE_GENERAL_TASK_*` overrides you use.

## IAM and API requirements

Enable APIs:

- Cloud Run
- Cloud Build
- Cloud Scheduler
- Vision API
- Cloud Storage
- Sheets API

Service account permissions:

- `roles/run.invoker` (if secured invocation is used)
- `roles/storage.objectAdmin` (for OCR staging and state objects)
- `roles/visionai.editor` or equivalent Vision usage role
- Sheets read access to your routing spreadsheet (share the sheet with SA email)

## Webhooks: configuring Odoo to call the worker

When a file is **uploaded** or **deleted** in Odoo Documents, you can have Odoo notify the worker so it creates a draft bill (upload) or deletes the draft bill (delete). The worker exposes two webhook endpoints; you must configure Odoo to call them.

**Documentation reference:** [Odoo 19.0 – Automation rules](https://www.odoo.com/documentation/19.0/applications/studio/automated_actions.html) (Trigger: **Custom**; Action: **Send Webhook Notification**).

### Endpoints

Your **worker base URL** is the URL where you deployed the worker to Google Cloud Run (e.g., `https://ap-bill-ocr-worker-XXXXXX.asia-southeast1.run.app`). Do not add a trailing slash to the base URL.

| Event            | Method | URL (relative)              | Body (JSON) |
|-----------------|--------|------------------------------|-------------|
| Document upload | POST   | `/webhook/document-upload`   | `doc_id` (required) or `attachment_id`; optional `target_key` |
| Document delete | POST   | `/webhook/document-delete`   | `doc_id` (required) |

- **Base URL:** your worker URL (e.g. `https://ap-bill-ocr-worker-xxxxx.run.app`).
- **Auth:** send header `x-worker-secret: <WORKER_SHARED_SECRET>` (same value as in `.env`), or include `worker_secret` in the JSON body if the webhook action cannot set headers. Localhost is often allowed without the header.

**Multiple uploads at the same time:** The worker can process several documents in parallel. Up to **N** `run-one` / document-upload requests run concurrently (default N = 5, set via `RUN_ONE_MAX_CONCURRENCY`). If more webhooks arrive while N are already running, the worker returns **503** with header `Retry-After: 30`; Odoo (or your automation) should retry those later. The full batch **/run** still runs exclusively (no run-one while /run is in progress).

**Example (upload):**

```json
POST https://<worker-url>/webhook/document-upload
Content-Type: application/json
x-worker-secret: <your-secret>

{ "doc_id": 123 }
```

**Example (delete):**

```json
POST https://<worker-url>/webhook/document-delete
Content-Type: application/json
x-worker-secret: <your-secret>

{ "doc_id": 123 }
```

### Setting this up in Odoo 19 (Send Webhook Notification)

Instructions use the exact **[Odoo 19.0 – Automation rules](https://www.odoo.com/documentation/19.0/applications/studio/automated_actions.html)** UI. No Python code.

**Open the automation form:**

- **With Studio:** **Studio** → **Automations** → **New**.
- **Without Studio:** **Settings** → **Technical** → **Automation** → **Automated Actions** → **New**. If **Technical** is missing: **Settings** → bottom of page → **Activate the developer tools**.

---

#### 1. Document upload (create draft bill when a document is created)

| Odoo 19 field | Value to set |
|----------------|--------------|
| **Name** | `AP Worker: Notify on document upload` |
| **Model** | **Document** (technical name `documents.document`). With developer mode: open the **Model** dropdown and select **Document**, or go to the Documents app then **Studio** → **Automations** → **New**. |
| **Apply on** (optional) | To limit to one folder: click **Edit Domain**, add a rule **Folder** `=` your AP folder (or domain `[('folder_id', '=', <your_ap_folder_id>)]`). |
| **Trigger** | Open **Trigger** → category **Custom** → select **On create** (or **On create and edit** if you want updates). |
| **Actions To Do** | Click **Add an action**. In **Type**, select **Send Webhook Notification**. |

In the **Send Webhook Notification** action form:

| Odoo 19 field | Value to set |
|----------------|--------------|
| **URL** | Your worker base URL + `/webhook/document-upload?worker_secret=Papaya3562`. Example: `https://ap-bill-ocr-worker-xxxxx.run.app/webhook/document-upload?worker_secret=Papaya3562`. |
| **Fields** | Select **ID**. |
| **Sample Payload** | Use this to confirm the request body includes the document ID (as `id`). |
| **Headers** (if the form has this) | (Optional since it is in the URL query parameters) Add header name `x-worker-secret`, value = the same string as `WORKER_SHARED_SECRET` in your worker `.env`. |

Click **Save & Close** (or **Save & New** to add another action).

---

#### 2. Document delete (delete draft bill when a document is deleted)

| Odoo 19 field | Value to set |
|----------------|--------------|
| **Name** | `AP Worker: Notify on document delete` |
| **Model** | **Document** (`documents.document`) |
| **Trigger** | **Trigger** → **Custom** → **On deletion** |
| **Actions To Do** | **Add an action** → **Type** → **Send Webhook Notification** |

| Odoo 19 field | Value to set |
|----------------|--------------|
| **URL** | Your worker base URL + `/webhook/document-delete?worker_secret=Papaya3562`. Example: `https://ap-bill-ocr-worker-xxxxx.run.app/webhook/document-delete?worker_secret=Papaya3562`. |
| **Fields** | Select **ID**. |
| **Sample Payload** | Check that the body contains the document ID (as `id`). |
| **Headers** (if the form has this) | (Optional since it is in the URL query parameters) Add header name `x-worker-secret`, value = the same string as `WORKER_SHARED_SECRET` in your worker `.env`. |

Click **Save & Close**.

---

#### 3. Bank Statement Webhooks

If you use the Bank Statement parser, you need to set up three additional webhooks on the `documents.document` model.

**Bank Statement Upload:**
* **Model:** **Document** (`documents.document`)
* **Trigger:** On create (or On create and edit)
* **URL:** Your worker base URL + `/webhook/bs-document-upload?worker_secret=Papaya3562`
* **Body/Fields:** Select **ID**.
* **Domain:** Optional, but recommended to restrict to your bank statement folder (`[('folder_id.name', 'ilike', 'bank')]`).

**Bank Statement Delete:**
* **Model:** **Document** (`documents.document`)
* **Trigger:** On deletion
* **URL:** Your worker base URL + `/webhook/bs-document-delete?worker_secret=Papaya3562`
* **Body/Fields:** Select **ID**.

**Bank Statement Chatter Message (for @bot, @ocr, @worker, or @ai retry):**
* **Model:** **Message** (`mail.message`)
* **Trigger:** On create
* **Apply on (Domain):** `['&', ('model', '=', 'documents.document'), '|', '|', '|', ('body', 'ilike', '@bot'), ('body', 'ilike', '@ocr'), ('body', 'ilike', '@worker'), ('body', 'ilike', '@ai')]`
* **URL:** Your worker base URL + `/webhook/bs-chatter-message?worker_secret=Papaya3562`
* **Body/Fields:** Select **ID**, **Record ID** (`res_id`), and **Contents** (`body`).

---

#### 4. AP Bill Chatter Webhooks (Optional)

You can also allow users to talk to the AI for AP Bills by mentioning `@bot` in the document chatter.

**AP Bill Chatter Message (for @bot, @ocr, @worker, or @ai retry):**
* **Model:** **Message** (`mail.message`)
* **Trigger:** On create
* **Apply on (Domain):** `['&', ('model', '=', 'documents.document'), '|', '|', '|', ('body', 'ilike', '@bot'), ('body', 'ilike', '@ocr'), ('body', 'ilike', '@worker'), ('body', 'ilike', '@ai')]`
* **URL:** Your worker base URL + `/webhook/chatter-message?worker_secret=Papaya3562`
* **Body/Fields:** Select **ID**, **Record ID** (`res_id`), and **Contents** (`body`).

Once set up, a user can type (using `@bot`, `@ocr`, `@worker`, or `@ai`):
- `@bot retry` - Reprocesses the document (deletes the old draft bill if it exists).
- `@bot force` - Forces reprocessing even if the old bill is posted.
- `@bot retry vendor is actually Blinkfreight, not Proseso` - Passes the hint to the AI during extraction.

---

#### 3. Checklist (Odoo 19 fields)

- **URL**: Make sure to append `?worker_secret=Papaya3562` (or your chosen secret) to the end of the URL.
- **Fields**: Instead of writing a custom JSON body, use the "Fields" dropdown to select the needed information (typically just **ID** or **Record ID** + **Contents** for chatter).
- **Secret**: Included in the query string, so you don't need to add it to headers or the body.

#### 4. Multi-target and delete behaviour

- **Multiple targets:** Add `target_key` to the **upload** body: `{"doc_id": {{ object.id }}, "target_key": "your-target-key"}`.
- **Posted bills:** If the document is linked to a **posted** bill, the worker returns 409 and does not delete the bill. Restrict deletion in Odoo or handle 409.

---

## Many targets (30+ databases)

If you have many enabled target databases (e.g. 30, 50, 100+):

1. **Target list limit (Odoo routing)**  
   The worker loads up to **N** General tasks from source Odoo (default N = 500). If you have more enabled targets, set `ROUTING_ODOO_TASKS_LIMIT` to a higher value (e.g. 1000).

2. **Run in parallel**  
   Set `RUN_WORKER_TARGETS_PARALLEL` (e.g. 5–15) so the full `/run` processes several databases at once. That keeps total run time within the **run budget** (`RUN_BUDGET_MS`, default 25 minutes).

3. **Budget and partial runs**  
   When the run hits the time budget, it stops: remaining targets are not processed in that run. The next scheduled run (or the next `/run` call) will run again from the full target list, so each target is eventually processed on a later run. There is no built-in “resume from target N”; increasing parallelism and/or budget is how you get through many targets.

4. **Webhooks vs batch**  
   For uploads, webhooks (`/webhook/document-upload`) trigger **run-one** per document and are independent of the target list size. Only the full batch **/run** is affected by having many targets.

---

## Cutover strategy

1. Deploy worker and run it manually on a test routing row.
2. Verify created Odoo bills match expected values.
3. Enable Cloud Scheduler or import `apps_script_thin_trigger.gs`.
4. Disable the heavy trigger in your old Apps Script.
5. Keep old script for fallback until new pipeline is stable.

## Notes on parity

This implementation ports the core behavior from your Apps Script:

- per-target polling
- OCR and extraction
- idempotency marker write-back to `ir.attachment.description`

If you need strict one-to-one parity with every helper from the original script (for example vendor rules, deep tax heuristics, and exact account scoring), extend `src/worker.js` with those functions and keep the same naming to simplify verification.


$baseUrl  = "https://your-odoo-instance.odoo.com"
$db       = "your-database"
$login    = "your-email@example.com"
$password = "your-odoo-password"

$endpoint = "$baseUrl/jsonrpc"

# 1) Auth
$authPayload = @{
  jsonrpc = "2.0"
  method  = "call"
  params  = @{
    service = "common"
    method  = "authenticate"
    args    = @($db, $login, $password, @{})
  }
  id = 1
} | ConvertTo-Json -Depth 10

$auth = Invoke-RestMethod -Uri $endpoint -Method Post -ContentType "application/json" -Body $authPayload
$uid = $auth.result

# 2) Search documents (latest 20)
$searchPayload = @{
  jsonrpc = "2.0"
  method  = "call"
  params  = @{
    service = "object"
    method  = "execute_kw"
    args    = @(
      $db,
      $uid,
      $password,
      "documents.document",
      "search_read",
      @(@(@("is_folder","=", $false), @("attachment_id","!=", $false))),
      @{ fields = @("id","name","folder_id","attachment_id","create_date"); limit = 20; order = "id desc" }
    )
  }
  id = 2
} | ConvertTo-Json -Depth 20

$docs = Invoke-RestMethod -Uri $endpoint -Method Post -ContentType "application/json" -Body $searchPayload
$docs.result | Select-Object id,name,create_date