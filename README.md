# AT&T AI Foundry — Enterprise Customer & Operational Data Platform

Director-grade working prototype for **AJ DiLeo, AI Director @ AT&T, AI Foundry**.
Built by Durga Prasad Thoorpati (Sr. Software Engineer) from the AT&T project:
*Enterprise Customer & Operational Data Platform with GenAI Integration*.

## What it is

One agent, five customer journeys, end to end — with receipts. The agent
retrieves Customer 360, grounds itself in policy with STAIR, validates
against the real ledger, and proposes a resolution. Then it **stops for
human approval**. Nothing is credited, activated, or changed until a person
approves it, and every step is traced to a ledger record or a cited policy
section. The numbers on the Dashboard are computed live from real runs —
"— / No runs yet" when zero runs exist, never a fake 100%.

**Live inside this prototype:** frontend ↔ serverless API ↔ agent engine ↔
data store are connected; the LangGraph-style agent is real Python in
`server/` (and the same deterministic engine in TypeScript); RAG/STAIR
retrieval is real over seeded policy docs; every state change (credit,
plan, order, ticket) is a real record change you can inspect; the 85%
eval gate **blocks** a release when the suite fails.

**Live LLM (Groq, when configured):** when `GROQ_API_KEY` is set, Groq
(`openai/gpt-oss-120b`, free tier) picks each STAIR leaf from the TOC
allowlist and drafts the customer-facing summary. The allowlist still
blocks invented sections, deterministic validation still decides every
amount and eligibility check, and human approval still gates every credit
and plan change. When the key is missing, revoked, or Groq is unavailable
(rate limit, timeout, invalid pick), the run completes on the deterministic
engine and the trace says so — it never fakes a Groq answer. After 3
consecutive Groq failures the circuit breaker opens for 60s and the app
serves deterministic fallback without calling Groq at all. `/api/health`
reports `llm_live: true` **only** when a live Groq call actually succeeded
— a configured key alone is reported as configured, not live.

**Not live:** there is **no real AT&T internal API, and all demo data is
synthetic** (invented names, accounts, invoices). That honesty is deliberate:
a demo that pretends to be production is exactly the kind of pilot that
delivers no measurable return. The **Production readiness panel** on the
Dashboard shows, live, what is connected and what the fulfilment team
still needs to connect. `docs/JD_COVERAGE.md` maps every line of the
Principal AI-Native Software Engineer JD to the file that implements it
and how to verify it.

## The five customer journeys (one agent, one approval gate)

All five use the same explicit agent state machine
(`INTAKE → RETRIEVE_360 → GROUND → VALIDATE → PROPOSE → AWAITING_APPROVAL → EXECUTE → VERIFY → DONE`,
in `src/lib/agent.ts` / `server/agent.py` — the run view shows the trace
and whether every transition was legal), the same Customer 360, the same
audit trail, and the same measured ROI.

| # | Case | What the agent does | State change on approval |
|---|------|---------------------|--------------------------|
| 1 | Billing dispute — double charge $87.40 (CASE-1001) | Validates the duplicate in the ledger, grounds in Billing Policy §4.2 | Credit $87.40 posted, balance updated, customer notified |
| 2 | Service provisioning — new line (CASE-1004) | Eligibility check, order, provisioning, activation | **Fails honestly:** account is suspended, so no order is created — the run reports the reason instead of fake success |
| 3 | Network outage triage (CASE-1007) | Diagnoses from network status, schedules technician, checks outage credit | $25 credit posted, technician visit scheduled (case amount $18.45 is the reported device installment, not the credit) |
| 4 | Plan change (CASE-1008, CASE-1010) | Eligibility, price comparison from the customer's actual plan, policy grounding | CASE-1008: Family Share $98.00 → Premium $87.40, **$10.60 credit** posted. CASE-1010: Starter $65.00 → Premium $87.40, $22.40 charge posted |
| 5 | Retention / save offer (CASE-1011) | Churn-risk signals, eligible save offer from policy | $25 goodwill credit, account reactivated |

**Four more cases fail honestly** (the agent refuses rather than guessing):
CASE-1005 (roaming dispute — no agent workflow exists for that type),
CASE-1006 (retention — only 1 churn-risk signal, 2 required),
CASE-1009 (provisioning — balance $111.08 is above the $100 limit).
CASE-1002 ($65.00) and CASE-1003 ($112.00) are two more duplicate-charge
cases that resolve like CASE-1001; CASE-1012 is a second outage case
($25 credit). 8 of the 12 seeded cases succeed, 4 fail with a reason.

Every case **fails honestly** if validation fails (no duplicate found, account
not active, already on Premium, not enough churn signals) — the run reports
`failed` with a reason instead of fake success. A credit can never be posted
twice: the idempotency key makes a repeat run return the original run, and
the server-side `POST /cases/{id}/execute` enforces it twice (seen key +
already-posted credit check).

**Plan prices and outage credits are computed, not hardcoded.** Plan prices
come from one price table (Starter $65.00, Premium $87.40, Family Share
$98.00, Business Elite $112.00): a plan change computes target − current from
the customer's actual plan, so a cheaper target posts a credit (CASE-1008:
Family Share → Premium = $10.60 credit, not a $22.40 charge). The $25 outage
credit (POL-006 §5.1) applies only for a network-confirmed outage over 4
hours, and the trace names both the case amount and the policy credit
(CASE-1007: the $18.45 case amount is the reported device installment; the
credit is $25.00).

**Run it in under 2 minutes:** open the app → Dashboard → **Find a customer**
(search by name, phone, account number, email or customer ID — or press
**Simulate incoming call (611)** to see the calling line identify the account)
→ open Customer 360 → **Create a case** → **Create case & run agent** →
approve the proposed credit → watch the balance change, the notification
appear, and the ROI numbers move. Every case is a real record you just
created — there is no canned demo case. The 12 seeded cases in the
Cases view are the existing caseload, each runnable from its own row.

## Find a customer — where every call starts

The agent's first step is Customer 360, and before that someone has to
find the account. The Customers view is that lookup:

- **One search box**, matched across name (partial, case-insensitive),
  phone number (digits only — `2015550142`, `(201) 555-0142` and
  `555-0142` all match the same line), account number (`ACC-…`),
  email, and customer ID (`CUST-…`). Every result shows *why* it
  matched ("matched phone", "matched account"). Empty query lists the
  caseload, capped at 50 rows with the total shown.
- **Customer 360** for the selected person — plan, balance, status,
  since, city, ledger, usage, open cases — the same 360 the agent
  builds in its `RETRIEVE_360` step. From there: **Create case for this
  customer** (intake form pre-filled) or **Run agent** on an open case.
- **Simulate incoming call (611)** — picks a customer and pre-fills the
  search with their phone number, the way dialling 611 identifies the
  calling line before the agent speaks. Clearly labelled as a simulation.
- **How AT&T finds a customer today** — documented below: the real
  channels (611, 1-800-331-0500 wireless, 1-800-288-2020 internet/home
  phone, 1-800-901-9878 prepaid, 1-800-321-2000 business, myAT&T app,
  live chat, stores) and the identifiers (calling phone number first,
  then account number, then name + phone, verified with the 6-digit
  account PIN the customer created — or, if they don't have it, a
  one-time code sent to the registered phone/email after the customer
  confirms the registered email matches). This is documentation, not a
  working-screen panel — the Customers view stays a working screen.
  In this prototype the lookup runs against the loaded dataset (seed or
  uploaded file); in production it runs against the CRM through the
  `att` datasource adapter.

The search runs on whatever is in state — an uploaded dataset is
searchable the same way as the seed. Verified by the smoke check in
`tmp/smoke-search.ts` (esbuild-bundled, run with node): "maya",
"2015550142", "ACC-884120" and "CUST-1001" each find Maya Rodriguez,
"zzz-no-match" finds nobody, and a 1,000-customer list caps at 50 rows.

## Staff accountability (backend only)

A staff member can look up any customer by name or number while
working — so if anyone messes with a customer or data, their login
must be linked to every piece of work they do. Every action is written
to the append-only audit log tagged with the operator's login id
(`operatorId` on every audit entry and event): search, viewing a
Customer 360, creating a case, running the agent, approving or
rejecting, deleting a customer, loading a dataset, pipeline and
Medallion runs. Any change to a customer or data can be traced to who
did it.

- **Backend only, never on the front:** the operator id is stored on
  the audit record for investigation. It is never shown on any screen —
  the Observability audit feed shows action, detail and timestamp only.
- **Search is audited without the query:** the search itself is logged
  when submitted (never per keystroke) with the match type and count
  only — the raw query may be a phone number or email, which must never
  reach the audit log. Opening a Customer 360 is logged with the
  customer id only.
- **Operator identity:** demo mode uses the single labelled id
  `demo-operator` (a role label, never a real person's identity); in
  production the id comes from the signed-in operator's Entra ID
  subject (`src/lib/auth.ts`, `getCurrentOperatorId()`), and the audit
  log is persisted to Postgres with `operatorId` indexed.

## Bring your own dataset — the first call

A director will not connect live company data into someone else's working
environment on a first call, and a live connection takes days to weeks
anyway. So the first call runs on a **sample file the director's team
brings**: open the **Data** view, upload a `.json` file (same shape as
`test-data.json`) or one `.csv` per table (`customers.csv`, `ledger.csv`,
`usage.csv`, `cases.csv`, `tickets.csv` optional), read the validation
report, and test the agent on *your* records in minutes.

- **Validated, then cleansed — a file uploads anyway:** record counts, duplicate ids, unknown
  customer references, and balances that don't reconcile to the cent are all reported in the
  validation report — which is a pre-check, not a gate. A raw file is accepted and cleansed
  automatically on load (rules CL1–CL8, `src/lib/cleanse.ts` / `server/cleanse.py`): balances
  recomputed from the ledger, unfixable records quarantined and listed, never guessed. The
  cleansed dataset is what loads, and it can be downloaded as the production-ready file
  (`dataset-production-ready.json`, plus per-table CSVs) — it passes validation with 0 errors.
  Warnings (duplicate charges found, a case amount with no matching ledger entry) are shown,
  not hidden, and kept in the cleansed file.
- **Private by design:** files are read in the browser only — nothing is
  uploaded to any server, the dataset never leaves the device, and the
  built-in seed files are never touched. **Reset to original dataset**
  restores the built-in seed at any time.
- **Templates included:** download `dataset-template.json` or the CSV
  templates from the Data view; `docs/DATASET_GUIDE.md` tells the
  director's team how to export and anonymise a sample (10–20 customers,
  a few known duplicates, 2–3 cases per journey) and what happens next.
- **The same rules on the command line:** `python3 server/validate_dataset.py
  your-sample.json` (or `--csv-dir`) implements the same D1–D12 rules as
  the browser validator (`src/lib/dataset.ts`).

**The honest timeline:** sample file on the first call (minutes) →
security review and access (days to weeks, fulfilment team) → live
adapter via `DATASOURCE=att` (days once access exists, no agent code
changes). The sample is how the director decides whether the live
connection is worth doing at all — it is not a shortcut past it.

## Medallion architecture — Bronze → Silver → Gold (one operator)

**The operator story:** a single person runs this whole data platform.
When a pipeline fails, that one person fixes it with help from GitHub
Copilot — no 5–6 person engineer team. Every failure produces a
structured card with what failed, the exact record and batch, the error,
and a ready-to-paste Copilot prompt naming the file and function to fix.
The full 1-person guide is `docs/OPERATOR_RUNBOOK.md`.

- **Bronze — raw, immutable, schema-on-read.** CRM + billing + usage
  exactly as received, every record kept with batch id, ingest timestamp
  and source. Nothing is ever deleted or edited in Bronze.
- **Silver — cleaned, validated, deduplicated, reconciled.** The Silver
  quality gates are the per-pipeline validators (`validatePipeline` /
  `validate_pipeline`): duplicates, unknown customers, zero amounts,
  suspended accounts with a balance, negative usage. A record that fails
  a gate goes to **quarantine** — listed with its reason, never silently
  dropped, and never blocking the rest of the batch.
- **Gold — business-ready aggregates, built only from Silver-passed
  records.** Customer 360, reconciled ledger, usage rollups, dashboard
  ROI. Gold is never edited directly — fix Bronze/Silver and re-run.

**Measured on the seed (batch B-2026-11-21):** Bronze 106 records
(20 customers + 66 ledger + 20 usage) = Silver passed 101 + quarantined
5 (2 suspended-with-balance customers, 3 duplicate ledger charges).
Gold: Customer 360 = 20 customers, reconciled ledger = 63 entries
totalling $2,318.95, usage rollup = 20 records (275.85 GB, 7,281 min,
1,638 SMS). Lineage is shown in the Medallion tab — e.g. INV-2041:
Bronze raw → Silver quarantined as a duplicate of INV-2039 → Gold
excluded from the reconciled ledger, while the agent's $87.40 credit
(CASE-1001) is what reaches Gold.

**Automation:** batches are incremental by watermark — only records not
seen before are re-validated (run it twice: first run 106 new, second
run 0 new, 106 skipped) — and **bounded** (at most 1000 new records per
batch; the rest are deferred to the next batch, never dropped). A failed
step is retried once, then the bad records are quarantined and the batch
completes anyway. Every run is recorded in pipeline runs + the audit log.

**Petabyte scale, honestly:** the demo runs on 106 synthetic records.
Petabyte scale is architectural, not measured here — partitioning by
ingest date + customer, incremental watermark loads, dedup by
idempotency key, schema evolution rules, quarantine instead of blocking.
The same code paths run at both scales, and the production Spark shape
is outlined in `server/medallion.py:spark_job_reference` (Databricks,
Auto Loader → Bronze, watermark-filtered Silver, Gold rebuilt from
Silver) and `GET /medallion/spark-job`. **No petabyte performance was
measured in this demo — do not claim it was.**

## STAIR — STructure Aware Information Retriever (IBM Research)

Primary retrieval is **STAIR** (Kumar et al., IBM Research, arXiv 2609.03874),
not chunk-based RAG:

- **No chunking, no embeddings, no vector database.** Policy docs are stored
  as structured trees: Table of Contents → sections → leaf nodes.
- Retrieval is given the **full TOC** and navigates to the exact leaf section.
  The leaf is returned **intact** and the answer comes only from it, cited by
  its full section path (e.g. `Billing Policy > Credits > Duplicate Charges §4.2`).
- **Constrained selection:** the retriever may only return a leaf title that
  exists in the TOC (a trie allowlist in `server/stair_retriever.py`, a Set
  in `src/lib/stair.ts`). It cannot invent a section.
- Docs without a TOC get an **auto-generated TOC** (flagged as such); if no
  section matches, the answer is **“not found in policy”**, not a guess.
- Chunk RAG is kept only as a **labelled baseline** for comparison — the
  STAIR view shows, per query, what STAIR got and what the baseline got on
  the same 10 questions.
- **No vector DB by design:** STAIR needs none — it navigates a TOC, it does
  not search an embedding space. The adapter interface where embeddings would
  plug in, if the fulfilment team ever wants them, is `stairRetrieve()` /
  `retrieve()`: replace its token-overlap scoring with an embedding lookup
  over the same leaf titles, keep the trie allowlist, and the contract (only
  a TOC leaf may be returned) is unchanged.

**Numbers, honestly:**
- Paper (SearchTome, Recall@1): STAIR **82.6%**, DSI 76.9%, DPR 68.7%, BM25 59.5%.
- Paper hallucination **< 0.05%** means generating an **invalid section
  identifier** — not “the answer was factually right”.
- **No “65x reduction” figure is claimed** anywhere in this project.
- Our own measured Recall@1 / invalid-section rate on the seeded 10-query
  eval set is computed live in the app (STAIR view) and by
  `pytest server/test_stair.py` — that is the number that matters here.

## Architecture (text diagram)

```
Sources (CRM, billing, usage — synthetic seed, or live AT&T adapter)
        │  ETL pipelines (validate + ingest, exceptions listed)
        ▼
Customer 360 (customers + ledger + usage + tickets + cases)
        │
        ▼
FastAPI reference backend (server/)  ──►  Vercel serverless API (api/)
  LangGraph-style agent engine            same deterministic engine, TS port
  (plan → tools → validate → propose)     POST /api/run-case, /api/rag, /api/stair
        │  STAIR retriever (trees, TOC, trie allowlist)
        ▼
Human approval gate (in-page approve / reject — no browser dialogs)
        │  POST /cases/{id}/execute (idempotent, server-side)
        ▼
Execute → ledger / order / plan / ticket changes → notify → verify
        │  (every change emits a structured event to the feed)
        ▼
Measured outcomes (Dashboard) + per-run traces + audit log (Observability)
```

## Configuration — one surface, env vars only

Every secret and mode flag comes from environment variables, read in
`src/lib/config.ts` / `server/config.py` and nowhere else. No secret is in
code, in git, or in a request body. See `.env.example` (every variable,
with required-vs-optional and where to get it) and `docs/DEPLOYMENT.md`.

| Variable | Required when | Default |
|----------|---------------|---------|
| `GROQ_API_KEY` | live-LLM mode | — (deterministic engine) |
| `ATT_API_BASE_URL` | `DATASOURCE=att` | — |
| `ATT_API_KEY` | `DATASOURCE=att` | — |
| `DATABASE_URL` | reserved (not read yet) | — |
| `DATASOURCE` | — | `seed` |
| `AUTH_ENABLED` | — | `false` |
| `AUTH_PROVIDER` / `AUTH_CLIENT_ID` / `AUTH_ISSUER_URL` | `AUTH_ENABLED=true` | `entra-id` / — / — |
| `RATE_LIMIT_PER_MINUTE` | — | `120` (demo guard) |

Demo mode needs **nothing**: it runs on the synthetic seed + deterministic
engine and says so. Startup fails loudly with a clear message naming every
missing REQUIRED variable for the selected mode instead of running
half-configured.

**Data-source switch** (`src/lib/datasource.ts`, `server/datasource.py`):
`seed` (default, synthetic demo data) or `att` (live AT&T adapter: Bearer
auth, 10s timeout, retry once, maps CRM/billing/usage payloads onto the
existing record types). `att` mode **fails honestly** — an unreachable or
bad AT&T API is reported, never silently replaced with seed data. Mode is
selected by `DATASOURCE` and shown in `/api/health` and the Production
readiness panel.

**Auth boundary** (`src/lib/auth.ts`, `server/auth.py`): a Google/Entra
OAuth login gate, **disabled by default**. Production uses AT&T Entra ID.
Enabled without config it shows an honest "auth not configured" state —
never a fake login. The OAuth callback is not yet implemented, so the
configured gate is a clearly-labelled placeholder (disabled sign-in button).

## How to run

```bash
# Frontend (Vite + React + TypeScript)
npm install
npm run dev          # http://localhost:5173
npm run build        # tsc + vite build
npm run preview      # serves dist/ on http://localhost:4173 (proxies /api to localhost:8000)

# Python reference backend (FastAPI + LangGraph-style engine)
cd server
python3 -m venv ../.venv && ../.venv/bin/pip install -r requirements.txt
../.venv/bin/python -m pytest ../server -q        # from the repo root: python -m pytest server/ -q
../.venv/bin/uvicorn app:app --reload --port 8000   # docs at http://localhost:8000/docs

# Live Groq mode (optional, local): export GROQ_API_KEY=<redacted>
# and pass live_llm: true to /cases/{id}/plan or /api/run-case.
# Without the key the engine runs deterministically and says so.

# Whole stack with one command (needs Docker; see docs/DEPLOYMENT.md):
docker compose up    # API :8000, web :4173 (proxies /api to the API)
```

## Deploy (Vercel)

Full runbook: `docs/DEPLOYMENT.md` (Vercel import, env vars, redeploy,
smoke checks: `/api/health`, CASE-1001 run, Medallion counts).

```bash
git init && git add . && git commit -m "AT&T AI Foundry prototype"
# Create the repo on GitHub (user: durgaprasadt235-hash), push, then import in Vercel.
# vercel.json: SPA fallback excludes /api/* — the fallback cannot swallow API routes.
# After import, set GROQ_API_KEY as a Vercel project environment variable
# (Production + Preview) to enable live Groq mode; without it the deployed
# app runs deterministically and says so. Never put the key in code or git.
```

## API contract

Every endpoint in `api/` (Vercel serverless) has a FastAPI mirror in
`server/`; every handler returns proper JSON errors (no 500 HTML, no
`FUNCTION_INVOCATION_FAILED` class of bug) and enforces the demo-grade
rate-limit guard (60 requests/min per caller in the contract; the guard
defaults to 120/min so a demo session never trips it — production rate
limiting belongs at the edge).

| Endpoint | Method | Body | Returns |
|----------|--------|------|---------|
| `/api/health` ↔ `GET /health` | GET | — | `{ ok, engine, llm, llm_configured, llm_live, llm_circuit, llmModel, datasource, db, auth, realAttSystems, demoData }` — `llm_live` is true only when a live Groq call succeeded |
| `/api/run-case` ↔ `POST /cases/{id}/plan` | POST | `{ case, customers, ledger, usage, tickets, docs, live_llm? }` | plan steps, proposed credit/action, agent state-machine trace, `runId`, `traceId`, `durationMs`, structured audit entry, `liveLlm` status, `liveSummary`, or honest failure |
| `POST /cases/{id}/execute` (FastAPI) | POST | `{ state, idempotencyKey, runId? }` | updated state + outcome; **idempotent** — a repeated key or an already-posted credit returns the original outcome, never a second credit |
| `/api/rag` ↔ `POST /rag/search` | POST | `{ query, docs }` | grounded answer + citations, or refusal (baseline only) |
| `/api/stair` ↔ `POST /stair/retrieve` | POST | `{ query, trees, live_llm? }` | intact leaf + full path citation, or “not found in policy” |
| `GET /stair/eval` | GET | — | STAIR Recall@1 + chunk-RAG baseline on the same 10 questions, per query |
| `POST /evals/run` | POST | `{ state }` | eval results + score vs the 85% gate |
| `POST /evals/release-gate` | POST | `{ state }` | `{ released, scorePct, failures }` — the gate **blocks** the release when the suite fails |
| `GET /medallion`, `GET /medallion/spark-job` | GET | — | Bronze → Silver → Gold snapshot; Databricks/Spark job outline |
| `POST /pipelines/validate` | POST | `{ state, pipeline_id }` | per-pipeline validation (that pipeline's source only) |
| `GET /datasource/status` | GET | — | datasource probe (in `att` mode this really calls the AT&T API) |
| `GET /metrics` | GET | — | record counts per layer + endpoint counters |
| `GET /events` | GET | — | append-only event feed (newest first) |
| `GET /tools` | GET | — | per-tool contracts (input schema, timeout, retry, idempotency) |

All planning endpoints are **stateless**: the caller posts its current state;
no server-side persistence in the demo (browser state persists in localStorage).
Validation errors return 400/409/422 with a reason; wrong method returns 405;
rate-limit returns 429 with `Retry-After`.

## Agent tool contracts

Per-tool contracts live in code (`src/lib/tool-contracts.ts`,
`server/tool_contracts.py`) and at `GET /tools`. Summary:

| Tool | Input schema | Guarantees |
|------|--------------|-----------|
| `validate_case` | `{ caseId, idempotencyKey }` | 400 if case/customer missing; duplicate key returns the original run; never retried |
| `get_customer_360` | `{ customerId }` | read-only; returns customer + ledger + usage + tickets |
| `stair_retrieve` | `{ query }` | only a TOC leaf title may be returned; refusal when no match |
| `search_knowledge` (baseline) | `{ query }` | grounded answer or refusal; never invents |
| `validate_duplicate` | `{ customerId }` | duplicate = same service + amount, different invoices, ≤ 7 days |
| `propose_credit` / `propose_*` | `{ amount, reason, citation }` | proposal only — execution requires human approval |
| `execute_approved` | `{ runId, approval, idempotencyKey }` | **the one mutating tool** — idempotent: a posted credit is never posted twice |
| `groq_chat` | `{ query, allowlist }` | 20s timeout, retry once, circuit breaker after 3 failures |

Retries: tool calls retry once on transient failure and record the retry
count in the run trace. Rate limits: the demo-grade in-memory guard
(60/min per caller in the contract; production at the edge) with 429 +
`Retry-After`. Errors are structured `{ error, reason }`, never a
silent success. Access control: the demo runs open on synthetic data
with the auth gate off by default; production calls go through the Entra
ID gate and the AT&T API key.

## Observability

- **Structured JSON logging** (`server/observability.py`): one JSON line per
  significant action (timestamp, event, run id, trace id, duration) to
  stdout — parseable by any log aggregator, no regexes needed.
- **Trace IDs:** one `TRC-…` per run, carried through the plan, the audit
  entry, the events, and the UI run view — the same id links every hop.
- **Run IDs + durations:** every run and every audit entry carries them
  (frontend audit log, `api/run-case.ts`, `POST /cases/{id}/plan`).
- **Metrics:** `GET /metrics` — record counts per pipeline/layer
  (Bronze / Silver / Gold) + endpoint counters.
- **Dashboards:** the app's own views (Dashboard, Observability, Medallion).
- **Alerting:** Medallion failure cards with ready-to-paste Copilot prompts;
  quarantine counts and blocked releases are the alerts.
- **Incident troubleshooting:** `docs/OPERATOR_RUNBOOK.md` (1-person guide:
  daily loop, common failures + Copilot prompts, never-do list).
- **PII-aware logging:** phone numbers and email addresses are masked at
  every log/audit/event sink (`src/lib/redact.ts`, `server/redact.py`).
  Demo customer data is synthetic; names and account numbers are product
  data (Customer 360 shows them by design) and are not masked.

## Event-driven

Every state change emits a structured event (`case_created`,
`credit_proposed`, `credit_approved`, `credit_executed`, `plan_proposed`,
`plan_approved`, `plan_executed`, `pipeline_run`, `pipeline_failed`,
`run_failed`, `eval_run`, `release_approved`, `release_blocked`) to an
append-only feed — in-app (Observability → Event feed) and server-side
(`GET /events`). The feed is the seam where a real event bus plugs in:
replace the append with a publish to Kafka / SNS / EventBridge and
subscribers get the same event types and fields. The in-app feed is
per-browser / per-instance and in-memory: it proves the event contract,
it is **not** a durable bus.

## Resilience

- **Deterministic fallback everywhere:** any Groq failure (missing key,
  429, timeout, invalid pick, circuit open) completes the run on the
  deterministic engine and the trace says so. The UI always says which
  mode a run used.
- **Circuit breaker** (`src/lib/groq.ts`, `server/groq_client.py`): after 3
  consecutive Groq failures the breaker opens for 60s — no Groq call is
  attempted, fallback is served; after the cooldown one trial call is
  allowed (half-open). Reported in `/api/health` as `llm_circuit`.
- **Timeouts:** Groq 20s, AT&T adapter 10s, deterministic tools 5s.
- **Retries:** once, on transient failures only — never on validation errors.
- **Backpressure:** Medallion batches are bounded (1000 new records max;
  the rest are deferred to the next batch, never dropped).
- **Graceful degradation:** the demo runs fully on seed + deterministic
  engine with no keys, no network, and no database — and says so.

## Evaluation criteria

- **Agent eval suite** (Evaluations view, 8 checks, **85% release gate**):
  duplicate detection, amount, non-duplicate discrimination, RAG grounding,
  RAG refusal, idempotency, agent plan. Runs against live state — delete
  POL-001 and it fails. The **Request release** button (and
  `POST /evals/release-gate`) **blocks** the release when the gate fails
  and names the failed checks.
- **STAIR eval** (STAIR view, 10 queries): measured Recall@1 and
  invalid-section rate, plus the chunk-RAG baseline on the same queries,
  per query.
- **ROI** (Dashboard): cases resolved, success rate, median agent time
  (measured per run, vs the 38-minute manual baseline in POL-005), cost per
  case ($28.50 manual vs $0.85 agent — stated assumptions, labelled in the
  footer), credits issued, orders activated, technician visits scheduled.
  All computed from real records; **“— / No runs yet”** when zero runs exist.

## Testing, CI, Docker

```bash
python -m pytest server/ -q     # FastAPI backend: engine, STAIR, Groq (mocked),
                                 # Medallion, config, datasource, auth, agent state
                                 # machine, execute/idempotency, release gate,
                                 # events, observability, circuit breaker
npx tsc --noEmit                 # frontend + lib typecheck
npx tsc -p tsconfig.api.json --noEmit   # serverless API typecheck
npm run build                    # tsc + vite build
```

GitHub Actions (`.github/workflows/ci.yml`) runs all three on every push:
Node (typecheck ×2 + build), Python (pytest), Docker (`docker build`
the backend image + `docker compose config` validation).

```bash
docker build -t att-ai-foundry-api ./server   # backend image
docker compose up                              # whole stack: API :8000, web :4173
docker compose --profile with-db up            # also starts Postgres (reserved)
```

Docker was **not** run in this VM (no Docker binary here) — the Dockerfile
and compose file were verified by inspection + YAML parse; the CI Docker
job runs the real build on every push. See `docs/DEPLOYMENT.md`.

## How this was built — AI-assisted engineering, disclosed

This prototype was built with AI-assisted engineering: Muse (agentic
coding, with the deterministic engine and the test suite as the check on
every step) and GitHub Copilot-style fix prompts (the Medallion failure
cards carry ready-to-paste prompts naming the file and function to fix).
The discipline is the same one the JD asks for: the AI proposes, the
deterministic tests verify, and a human approves every consequential
step — credits, plan changes, and releases all pause for human approval,
and nothing is presented as done until the verification package (tests,
typecheck, build, live smoke checks) is delivered. AI assistance is a
tool in the loop, not a substitute for the loop.

## Honest limits

- Live Groq mode needs `GROQ_API_KEY` set (Vercel env var in production,
  or exported locally). Without it the agent is deterministic code, not a
  model — and it says so in every run trace. Groq never executes anything:
  it only picks a STAIR leaf from the allowlist and drafts a summary.
- No API key, no real AT&T APIs, no real customer data. The `att`
  datasource mode and the Entra ID gate are the two fulfilment-team
  connections still needed — both are built, both fail honestly until
  connected, and `docs/DEPLOYMENT.md` lists the exact steps.
- No live database yet: `DATABASE_URL` is reserved; demo state lives in
  the browser (localStorage) and the seed file.
- Serverless demo state lives in the browser (localStorage); the Python
  backend is a reference implementation, not the deployed demo backend —
  except that `docker compose up` runs it as the real API behind the web
  container.
- Agent runs use real measured timing (each step is awaited and timed), but
  the “agent” is deterministic code, not a model.
- Manual baseline (38 min, $28.50/case) and agent cost ($0.85/run) are
  stated assumptions from POL-005 / the footer, not measured cloud bills.
- No canned demo case — create a case and run it: the Dashboard intake form
  creates a real case record (new id, unique idempotency key, created now)
  and runs the agent on it. The 12 seeded cases are the existing caseload,
  each runnable from its own row in the Cases view.
- Medallion petabyte scale is architectural, not measured: the demo seed
  is 106 records (20 customers, 66 ledger, 20 usage). Partitioning,
  watermarks and idempotency-key dedup are designed for petabyte volume,
  but no petabyte run was performed or timed in this prototype.
- The in-app event feed and the in-memory idempotency store are
  per-instance, not durable — production wires Kafka/SNS and a DB unique
  constraint at those seams.
- The frontend is React + TypeScript. The JD names Angular as an example
  modern framework: React/TS implements the same end-to-end contract here,
  and the API is framework-agnostic — an Angular client can consume it
  unchanged (see `docs/JD_COVERAGE.md`).

## Files

```
src/lib/engine.ts      deterministic agent engine (TS) — plan by case type
src/lib/agent.ts       explicit agent state machine (states, transitions, trace check)
src/lib/tool-contracts.ts  per-tool contracts (input schema, timeout, retry, idempotency)
src/lib/groq.ts        live Groq client (TS) — leaf pick + summary, User-Agent att-ai-foundry/1.0, circuit breaker
src/lib/medallion.ts   Medallion Bronze → Silver → Gold (TS) — snapshot, lineage, failure cards, incremental bounded batches
src/lib/stair.ts       STAIR retriever (TS) + eval set + measured recall (STAIR + chunk baseline, per query)
src/lib/seed.ts        synthetic seed: 20 customers, 12 cases, 8 docs, 3 trees
src/lib/types.ts       record types (incl. Medallion snapshot / quarantine / failure card, AuditEntry, AgentRun)
src/lib/config.ts      single config surface — env vars only, required-vs-optional, fail loudly
src/lib/datasource.ts  data-source switch: seed | att (live AT&T adapter, fails honestly)
src/lib/auth.ts        auth boundary — Entra ID gate, disabled by default, honest "not configured"
src/lib/redact.ts      PII redaction — masks phone/email in logs, traces, audit, events
src/lib/events.ts      event feed types — the Kafka/SNS seam
src/lib/api-utils.ts   API helpers — JSON errors + demo-grade rate-limit guard
src/lib/dataset.ts     bring-your-own-dataset: JSON + CSV validation (rules D1–D12), CSV parser, templates, datasetToState
src/components/DataView.tsx  Data view: upload, validation report, templates, reset to original dataset
src/lib/case-intake.ts   case intake — create a real case (no canned demo case)
src/lib/customer-search.ts  Find a customer — name / phone (digits only) / account / email / customer ID, match reasons, 50-row cap
src/components/CreateCaseForm.tsx  case-intake form (Dashboard, Cases, Customer 360 pre-filled)
src/App.tsx            Dashboard (Production readiness panel), Data, Customers, Cases, Pipelines, Medallion, RAG, STAIR, Evals (release gate), Observability (audit + event feed)
api/                   Vercel serverless: health, run-case, rag, stair
docs/OPERATOR_RUNBOOK.md  1-person operations: daily loop, common failures + Copilot prompts, never-do list
docs/DATASET_GUIDE.md  bring-your-own-dataset guide for the director's team: export, anonymise, first-call sample, honest live-connection timeline
docs/DEPLOYMENT.md     deployment runbook: Vercel import, env vars, redeploy, smoke checks, Docker, fulfilment onboarding
docs/JD_COVERAGE.md    every JD bullet → file + how to verify it
server/engine.py       Python port of the agent engine (live_llm mode included) + execute_approved
server/agent.py        explicit agent state machine (Python mirror)
server/tool_contracts.py  per-tool contracts (Python mirror)
server/groq_client.py  live Groq client (Python) — leaf pick + summary, User-Agent att-ai-foundry/1.0, circuit breaker
server/medallion.py    Medallion Bronze → Silver → Gold (Python) + Databricks/Spark job reference
server/stair_retriever.py  STAIR (Python) with trie allowlist + chunk baseline eval
server/config.py       single config surface (Python mirror)
server/datasource.py   data-source switch (Python mirror)
server/auth.py         auth boundary (Python mirror)
server/redact.py       PII redaction (Python mirror)
server/events.py       event feed (Python mirror) — the Kafka/SNS seam
server/observability.py  structured JSON logging, trace ids, metrics
server/app.py          FastAPI reference backend (plan, execute, evals, release gate, medallion, metrics, events, tools)
server/validate_dataset.py  BYOD validator (Python mirror of D1–D12) + CLI: python3 server/validate_dataset.py file.json [--csv-dir DIR]
server/test_*.py       pytest: engine, STAIR, Groq (+ breaker), Medallion (+ bounded batches), config, datasource, auth, agent, tool contracts, redact, events, observability, execute/idempotency, release gate, health, validate_dataset
server/seed.json       seed state shared with the Python backend
server/Dockerfile      backend image (python:3.12-slim + uvicorn)
docker-compose.yml     whole stack: api :8000, web :4173, db (profile with-db, reserved)
.github/workflows/ci.yml  CI: Node typecheck+build, Python pytest, Docker build+compose validation
vercel.json            SPA fallback excludes /api/* (do not change this)
```
