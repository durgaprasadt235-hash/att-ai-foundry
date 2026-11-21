# AT&T AI Foundry — Product Requirements Document (PRD)

**Product:** AT&T AI Foundry — Enterprise Task-Execution Agent Platform (prototype)
**Version:** 1.0 — 2026-11-21
**Author:** Durga Prasad Thoorpati
**Audience:** AJ DiLeo, AI Director @ AT&T, AI Foundry; the AI Foundry fulfilment team
**Repository:** https://github.com/durgaprasadt235-hash/att-ai-foundry
**Live demo:** https://att-ai-foundry.vercel.app/

> **Status of this document:** This PRD describes a working prototype that is
> production-ready in code structure, with clearly marked integration points.
> It is **not** connected to any real AT&T internal system. All demo data is
> synthetic. The fulfilment team onboards it by connecting the real systems
> listed in §11 — a configuration exercise, not a rebuild.

---

## 1. Executive summary

95% of enterprise AI pilots deliver no measurable return. This platform is
built for the 5% that does: **real enterprise task execution across the
entire customer journey** — not chatbots.

One LangGraph-style agent executes five end-to-end customer journeys
(billing disputes, provisioning, outage triage, plan changes, retention),
grounded in company policy through STAIR retrieval, gated by human approval,
verified after execution, and measured on every run. The data platform
underneath is a Medallion (Bronze / Silver / Gold) pipeline designed so a
single operator can run it at petabyte scale, fixing failures with a
GitHub Copilot prompt instead of a 5–6 person engineering team.

The director's decision after reading this PRD and running the demo should
be: *this is nailed — onboard it, connect the real systems, ship it.*

---

## 2. Problem

- Customer-facing work (billing disputes, provisioning, outages, plan
  changes, retention) is handled by humans reading policy documents and
  updating multiple systems by hand: ~38 minutes and ~$28.50 per case.
- AI pilots in this space are usually chatbots that answer questions but
  execute nothing, or demos that hallucinate policy and cannot be trusted
  with a customer's money.
- Data teams are fragmented across tools (code, CI/CD, deploys, secrets,
  databases, monitoring, analytics) — every small change costs a hop
  between systems, and every failure needs a team to triage.

## 3. Goals and non-goals

**Goals**

1. Execute real customer tasks end-to-end, with money-accurate outcomes.
2. Ground every decision in written policy, cited by section.
3. Keep a human in the loop on every consequential action.
4. Make every run measurable (cost, time, success, eval score).
5. Make the data platform operable by one person at petabyte scale.
6. Be onboardable by the fulfilment team with configuration only.

**Non-goals**

- No real AT&T internal API, CRM, or billing system is connected in this
  prototype (see §11 — that is the fulfilment team's step).
- No autonomous execution without approval. The agent proposes; a human
  approves; the system executes and verifies.
- No claim of measured petabyte-scale performance. Scale is architectural
  (partitioning, watermarks, idempotency), not benchmarked in the demo.

## 4. Users

| User | Needs |
|---|---|
| Customer-service agent / operator | Run a case, see the agent's reasoning and policy citation, approve or reject, see the verified result |
| AI Foundry director (AJ DiLeo) | See measurable outcomes, eval scores, and what is live vs what still needs connecting |
| Fulfilment team | Connect real APIs, keys, auth, and database; run the deployment |
| Data engineer / single operator | Run Medallion pipelines, clear quarantine, fix failures with Copilot |

## 5. The agent — one LangGraph-style workflow

Every journey runs the same workflow: find the customer first, then the
same eight agent steps. There is one agent, not five different ones.

```
plan → Customer 360 → STAIR grounding → validate → propose
     → HUMAN APPROVAL → execute → verify
```

| Step | What happens | Failure behaviour |
|---|---|---|
| **Find & confirm customer (step 0)** | Before the workflow starts, the operator finds and confirms the account with the fixed "Find & confirm customer" form (top of Dashboard and Customers view). Customers load A–Z by name at every load path; no customer is ever pre-selected and the intake picker starts empty. Step 1 identify by name, name + number, number, account, email or ID, with the match reason shown per result. Step 2 verify the way AT&T does today: name + phone, then the 6-digit account PIN the customer created; without the PIN, a one-time code is sent to the registered phone/email only after the customer confirms the registered email matches. Step 3 confirmed banner (method + time) — "Change customer" clears it and the next customer must be verified again. The confirmed customer becomes the context: their 360 opens and the intake form is pre-filled. "Simulate incoming call (611)" demonstrates the phone-first path. The lookup searches whatever dataset is loaded (seed or uploaded file); in production it runs against the CRM through the `att` adapter. Demo honesty: no PIN is stored and no real code is sent — verification is an operator attestation (method + timestamp), never presented as a cryptographic check. Verification is recorded, not enforced yet: the 360 shows "Verified via PIN at <time>" or "Not verified", and every action's audit entry carries the verification status. TODO (future): enforce verified-before-change — block billing/usage/service changes until the customer is verified in this session. | No match → empty result list, nothing invented; a 1,000-customer list caps at 50 rows with the total shown; OTP refused when the typed email does not match the registered email |
| Plan | Agent reads the case and selects the workflow (billing / provisioning / outage / plan / retention) | Unknown case type fails honestly: "no agent workflow for this type" |
| Customer 360 | Loads the customer, ledger, and usage from the data source — the same 360 the lookup opened | Unknown customer / missing record fails honestly |
| STAIR grounding | Retrieves the exact policy leaf from the structured policy tree, cited by full path (e.g. `Billing Policy > Credits > Duplicate Charges §4.2`) | No matching policy → "Not found in policy", no answer invented |
| Validate | Checks the business rules for the journey (duplicate detection, balance limits, churn-signal count, outage confirmation) | Rule failure → case fails with the exact reason, no action proposed |
| Propose | Produces the concrete action (credit amount, provisioning step, technician dispatch, price change, save offer) with the citation | — |
| Human approval | Operator approves or rejects in the UI. Nothing consequential happens before this step. | Rejection is logged; nothing executes |
| Execute | Applies the action to the ledger / customer state, idempotently (a repeat run returns the original result, never a second credit) | Execution errors are logged with a run ID |
| Verify | Re-reads state, confirms the outcome matches the proposal, records duration and cost | Mismatch is flagged, never hidden |

**Cost and time (per case, measured in the demo):** manual handling
38 minutes / $28.50; agent handling ~seconds / $0.85 (Groq inference
cost). Every run records its own duration and cost in the audit log.

## 6. The five customer journeys

Seed data: 20 customers, 66 ledger entries, 20 usage records, 12 cases.
All 20 customer balances reconcile to the cent. Exactly 3 duplicate
charges exist in the data. 8 of 12 cases succeed; 4 fail honestly.

| # | Journey | Example case | Outcome |
|---|---|---|---|
| 1 | Billing dispute — duplicate charge | CASE-1001, Maya Rodriguez, INV-2039 + INV-2041, $87.40 | $87.40 credit, cited Billing Policy §4.2 |
| 2 | Service provisioning — new line | CASE-1004 (suspended account) | **Fails honestly** — provisioning blocked for suspended accounts |
| 3 | Network outage triage | CASE-1007, Owen Vale | $25.00 outage credit (policy §5.1, only if network-confirmed > 4h) + technician dispatched |
| 4 | Plan change / upgrade | CASE-1008 Family Share → Premium = **−$10.60 credit**; CASE-1010 Starter → Premium = +$22.40 charge | Price table is plan-aware: Starter $65.00 / Premium $87.40 / Family Share $98.00 / Business Elite $112.00 |
| 5 | Retention — save offer | CASE-1011 | $25.00 save offer + reactivation (requires 2 churn signals; 1 signal fails honestly, CASE-1006) |

Full case-by-case outcomes (8 succeed, 4 fail):

- **Succeed:** CASE-1001 ($87.40 credit), 1002 ($65.00), 1003 ($112.00),
  1007 (outage $25 + technician), 1008 (plan change, −$10.60),
  1010 (upgrade +$22.40), 1011 (retention $25 + reactivation),
  1012 (outage $25).
- **Fail honestly:** CASE-1004 (provisioning, suspended), 1005
  (roaming dispute — no agent workflow exists), 1006 (retention, only
  1 churn signal, 2 required), 1009 (provisioning, balance $111.08
  exceeds the $100 limit).

## 7. STAIR retrieval (primary) — structure-aware, not chunk-and-embed

STAIR (STructure Aware Information Retriever, Kumar et al., arXiv
2609.03874) is the primary retrieval method. Policy documents are stored
as structured trees (table of contents → sections → leaves). A query plus
the full table of contents returns the exact leaf, intact, cited by its
full path. Selection is constrained by a trie/set allowlist of valid leaf
titles, so the agent cannot invent a section identifier.

- **No chunking, no embeddings, no vector database** for STAIR.
- Chunk RAG is kept only as a labelled baseline for comparison.
- Documents without a table of contents get a flagged auto-generated one.
- No match returns "Not found in policy" — the agent refuses rather than
  hallucinating.

**Measured accuracy:**

| Retriever | Recall@1 (paper) |
|---|---|
| STAIR | 82.6% |
| DSI | 76.9% |
| DPR | 68.7% |
| BM25 | 59.5% |

Measured in this app on the seed policy set: **STAIR Recall@1 90%
(9/10), invalid-section rate 0%**. The one miss is "charged twice same
amount" ("charged" does not stem to "charge") — left honest, not
over-tuned. The paper's "<0.05% hallucination" figure means generating an
invalid section identifier, not a factually wrong answer. No "65x
reduction" figure is claimed anywhere.

Policy leaves in the seed (11): BILL-CREDIT-DUP, BILL-CREDIT-GOODWILL,
BILL-CREDIT-OUTAGE, SVC-PROV-NEWLINE, SVC-PROV-DEVICE, SVC-NET-OUTAGE,
SVC-NET-TECH, PLAN-UPGRADE-PRICE, PLAN-CHANGE-EFFECTIVE, RET-SAVE-OFFER,
RET-CHURN-SIGNAL. Key rules: goodwill $25 / over $100 needs a supervisor;
outage $25 only if > 4h confirmed; provisioning balance ≤ $100.

## 8. Medallion data platform (Bronze / Silver / Gold)

End-to-end automation of all three Medallion layers, wired to the same
pipelines the agent reads from.

| Layer | Meaning | In this repo |
|---|---|---|
| Bronze | Raw immutable ingest — CRM, billing, usage exactly as received, with batch id, source, ingest timestamp, schema-on-read | `src/lib/medallion.ts`, `server/medallion.py` |
| Silver | Cleaned, validated, deduplicated, reconciled. Per-pipeline validators are the quality gates. Bad records go to **quarantine** (record id + reason), never silently dropped | `validatePipeline` / `validate_pipeline` |
| Gold | Business-ready aggregates, built only from Silver-passed records: Customer 360, reconciled ledger, usage rollups. Gold is never edited directly | Medallion view, `GET /medallion` |

**Measured counts on the seed (TS and Python agree exactly):**

- Bronze **106** (20 customers + 66 ledger + 20 usage)
  = Silver passed **101** + quarantined **5**
- Quarantine: CUST-1004, CUST-1011 (suspended with balance),
  LED-61/62/63 (duplicates INV-2041 $87.40, INV-2042 $65.00,
  INV-2043 $112.00)
- Gold: Customer 360 = 20; reconciled ledger = 63 entries totalling
  **$2,318.95**; usage rollup = 20 records (275.85 GB, 7,281 min,
  1,638 SMS)
- Lineage: every record carries Bronze batch → Silver check → Gold
  outcome (e.g. INV-2041 → Bronze passed → Silver quarantined as a
  duplicate of INV-2039 → Gold excluded, $87.40 credit noted)
- Incremental: 1st batch 106 new / 0 skipped; 2nd batch 0 new / 106
  skipped (watermark)

**Automation:** batch id + watermark (only new/changed records are
re-validated), one retry on a failed step, bad records quarantined
instead of failing the batch, every run recorded in pipeline runs and
the audit log. A Databricks/Spark reference job outline
(Auto Loader → Bronze, watermark-filtered Silver, Gold rebuilt from
Silver) is exposed at `GET /medallion/spark-job` — labelled reference,
not executed.

**Petabyte-scale design (honest):** partitioning (Bronze by ingest date
+ source, Silver by ingest date + customer, Gold by business date),
incremental watermark loads, deduplication by idempotency key, schema
evolution rules, quarantine instead of blocking. The demo exercises the
same code paths at small scale; petabyte performance is **not measured**
in this demo.

## 9. Single-operator model + Copilot fix flow

The platform is designed so **one operator** runs it — no 5–6 person
engineering team required for day-to-day operation.

- Every pipeline failure produces a structured failure card: what
  failed, the exact record/batch, the error, the file + function to fix,
  and a **ready-to-paste GitHub Copilot prompt**.
- The operator pastes the prompt into Copilot, applies the fix, re-runs
  the batch. Bad records are quarantined; the batch does not die.
- Full procedure in `docs/OPERATOR_RUNBOOK.md`: 10-minute daily loop,
  common failures and fixes, re-run procedure, never-do list (never edit
  Gold directly, never delete quarantined records, never paste keys into
  chat/Copilot).

## 10. Orchestration and monitoring

- **Pipelines view:** the three pipelines with per-source validation
  (PIPE-01 customers 20 processed / 2 failed; PIPE-02 ledger 66 / 3
  failed; PIPE-03 usage 20 / 0 failed) — each pipeline validates only
  its own source.
- **Medallion view:** Bronze / Silver / Gold counts, quarantine table,
  lineage lookup by invoice / ledger id / customer id, failure cards
  with Copilot prompts.
- **Observability view:** structured audit log with run IDs and
  durations; every run, approval, and failure is recorded.
- **Production readiness panel (home view):** live checklist — config
  present/missing, datasource mode, LLM status, last eval score,
  Medallion counts — so a director sees at a glance what is live vs
  what the fulfilment team still needs to connect.
- **Health endpoint:** `GET /api/health` reports engine / llm / db /
  datasource status truthfully (`llm: true` only when a live Groq call
  succeeds).

## 11. Requirements: needed vs already arranged

### Already arranged (in this repo)

| # | Requirement | Where |
|---|---|---|
| A1 | 5 end-to-end customer journeys with real state changes and idempotency | `src/lib/engine.ts`, `server/engine.py` |
| A2 | LangGraph-style agent workflow with human approval gate | `src/App.tsx`, `server/app.py` |
| A3 | STAIR retrieval + chunk-RAG baseline, with measured Recall@1 | `src/lib/stair.ts`, `server/stair_retriever.py` |
| A4 | Medallion Bronze/Silver/Gold automation, quarantine, lineage, incremental batches | `src/lib/medallion.ts`, `server/medallion.py` |
| A5 | Single-operator runbook + Copilot fix flow | `docs/OPERATOR_RUNBOOK.md` |
| A6 | Live LLM (Groq `openai/gpt-oss-120b`) with deterministic fallback | `src/lib/groq.ts`, `server/groq_client.py` |
| A7 | Evaluations with 85% release gate | Evals view, `EVAL_GATE_PCT = 85` |
| A8 | Structured audit log with run IDs and durations | Observability view |
| A9 | Data-source switch (`seed` vs `att`) + live adapter interface | `src/lib/datasource.ts`, `server/datasource.py` |
| A10 | Auth boundary placeholder (Entra/OAuth gate, disabled by default) | App + README |
| A11 | Config via env vars only; `.env.example` complete; no secrets in code | `.env.example` |
| A12 | CI (pytest + tsc + build on every push) | `.github/workflows/ci.yml` |
| A13 | Deployment runbook | `docs/DEPLOYMENT.md` |
| A14 | Production-readiness panel | Home view |
| A15 | Synthetic seed data, fully reconciled (20 customers, 66 ledger, 20 usage, 12 cases, 8 policy docs) | `src/lib/seed.ts`, `server/seed.json` |

### Needed from the fulfilment team / AT&T

| # | Requirement | Owner | Notes |
|---|---|---|---|
| N1 | Real AT&T CRM API endpoint + credentials | Fulfilment team | Adapter expects customer records mapped to the `Customer` type; see `src/lib/datasource.ts` |
| N2 | Real AT&T billing/ledger API endpoint + credentials | Fulfilment team | Maps to the `Ledger` type; duplicate-detection rules are already implemented |
| N3 | Real AT&T usage/telemetry API endpoint + credentials | Fulfilment team | Maps to the `Usage` type |
| N4 | Entra ID / OAuth configuration (tenant, client id, scopes) | Fulfilment team | Enables the auth gate; demo runs with it disabled |
| N5 | Production database (Neon/Postgres `DATABASE_URL`) | Fulfilment team | Replaces the in-memory/seed store; schema is the 40-table design in the repo |
| N6 | LLM key — Groq (`GROQ_API_KEY`) or Azure OpenAI | Fulfilment team | Free-tier Groq works for the demo; Azure OpenAI is the enterprise path |
| N7 | Vercel project env vars (Production + Preview) + redeploy | Fulfilment team | `GROQ_API_KEY`, `ATT_API_BASE_URL`, `ATT_API_KEY`, `DATABASE_URL`, `DATASOURCE=att`, `AUTH_ENABLED=true` |
| N8 | Policy documents in STAIR tree format | Fulfilment team | Real AT&T policy docs replace the 8 synthetic docs; each needs a table of contents |
| N9 | Fulfilment-team decisions: credit-approval thresholds, supervisor escalation, outage-confirmation source | AT&T business | Current values ($25 goodwill, >$100 supervisor, >4h outage, $100 provisioning cap) are seed defaults |
| N10 | Load / scale validation at production volume | Fulfilment team | Petabyte design is architectural; validate with real volume before full rollout |

**Onboarding is 3 steps:** (1) set the env vars in §11-N7; (2) point
`DATASOURCE=att` at the real APIs (N1–N3) and load real policy docs
(N8); (3) run the smoke checks in `docs/DEPLOYMENT.md`
(`/api/health`, CASE-1001 run, Medallion counts). No rebuild.

## 12. Security

- Secrets only via environment variables. No secret anywhere in code,
  chat, or the repo (verified by scan).
- Auth boundary: Entra/OAuth gate, disabled by default in demo, enabled
  by env flag. Production uses AT&T Entra ID. A login is never faked.
- Human approval gates every consequential action; approvals are
  single-use and logged.
- Idempotency: a repeat run returns the original result, never a second
  credit or charge.
- `att` datasource mode fails honestly when the endpoint is unreachable
  — it never silently falls back to synthetic data.
- Audit log records every run, approval, rejection, and failure with
  run ID and duration.
- **Staff accountability (backend only):** every audit entry and event
  carries the operator's login id (`operatorId`) — search, Customer 360
  views, case creates, agent runs, approvals, rejections, deletions,
  dataset loads, pipeline and Medallion runs — so any change to a
  customer or data can be traced to who made it. Every action's audit
  entry also carries the touched customer's verification status
  ("verified via PIN/OTP at <time>" or "not verified in this session"),
  and the Customer 360 shows it. The id is stored on
  the record for backend investigation and never rendered on any
  screen. Demo mode uses the single labelled id `demo-operator`;
  production resolves it from the signed-in operator's Entra ID
  subject, and the audit log is persisted to Postgres with
  `operatorId` indexed. Searches are audited with match type and
  count only — never the raw query, which may be a phone number or
  email.
- Known limits: no rate limiting beyond a demo-grade in-memory guard;
  no RBAC yet (single-operator model); the Python backend is a
  reference implementation — production hardening (WAF, secret rotation,
  VPC) is the fulfilment team's step.

## 13. Evaluations and release gate

- 8-check evaluation suite: duplicate detection, amount accuracy,
  non-duplicate discrimination, RAG grounding, RAG refusal, idempotency,
  and agent-plan correctness.
- **Release gate: 85%.** A release below 85% does not ship.
- The suite runs against live state — deleting a policy document makes
  dependent checks fail honestly.
- Eval score is shown live on the home production-readiness panel.

## 14. Deployment

- **Local:** `git clone`, `npm install`, `npm run dev`; Python backend
  optional (`server/app.py`). Runs on the synthetic seed with the
  deterministic engine; add `GROQ_API_KEY` for live LLM.
- **Vercel:** import the repo, set env vars (Production + Preview),
  deploy. SPA fallback explicitly excludes `/api/*`.
- **CI:** GitHub Actions runs pytest, `tsc` (both configs), and
  `npm run build` on every push.
- Full runbook: `docs/DEPLOYMENT.md` (smoke checks: `/api/health`,
  CASE-1001 run, Medallion counts).

## 15. Testing

- Python: pytest — engine, STAIR, Groq, Medallion suites (57 tests at
  last count before this PRD; see CI for the current number).
- TypeScript: `tsc --noEmit` (app) and `tsc -p tsconfig.api.json
  --noEmit` (serverless API).
- Build: `npm run build` + vite preview HTTP 200.
- Live E2E (verified 2026-11-21): CASE-1001 with real Groq — Groq
  picked leaf `BILL-CREDIT-DUP`, $87.40 credit, citation §4.2.
- Negative checks: invalid Groq key falls back deterministically;
  unreachable `att` endpoint fails honestly; deleted policy doc fails
  the eval suite.

## 16. Honest limits

- No real AT&T internal API is connected; all demo data is synthetic.
- Petabyte scale is architectural, not measured in this demo.
- `llama-3.1-8b-instant` is not available on Groq — use
  `openai/gpt-oss-120b` only.
- Groq free tier: 30 requests/min, 1,000 requests/day, 200K
  tokens/day (per Groq's published free tier).
- Messages are not yet real-time (polling, not WebSockets); the Python
  backend is a reference implementation.
- The live Groq key must be set as a Vercel env var or the deployed app
  runs deterministically and says so.

## 17. Success criteria (what "nailed it" looks like)

1. A director creates a new case on the Dashboard (or runs a case from the
   caseload) and sees the proposed credit, the §4.2 citation, and the
   verified result — in under a minute. There is no canned demo case: every
   run starts from a case the operator just created.
2. The System → Medallion reconciles to the record: Bronze 106 = Silver 101
   + quarantined 5; Gold ledger $2,318.95.
3. The production-readiness panel shows exactly what is live and
   exactly what the fulfilment team still needs to connect — no
   guessing.
4. The fulfilment team onboards it in 3 steps (§11) with no rebuild.
5. Eval score ≥ 85% on the release gate.
6. Every line of the Principal AI-Native Software Engineer job
   description is covered — see `docs/JD_COVERAGE.md` for the
   bullet-by-bullet mapping (file + how to verify each one).
7. **First call with a director's own data:** the director's team brings
   an anonymised sample file (JSON or CSVs), uploads it in the Data view,
   reads the validation report, and runs the agent on their own records
   in minutes — no live connection, nothing leaving the browser. The
   live connection is a separate, days-to-weeks step (§11, N1), never
   promised for the first call. See `docs/DATASET_GUIDE.md`.

## 18. First call — bring your own dataset (no live connection)

A director will not connect live company data into someone else's working
environment on a first call, and wiring a live connection takes days to
weeks (access, security review, mapping, testing). The first call
therefore runs on a sample file:

- **Upload:** Data view → select a `.json` file (same shape as
  `test-data.json`) or one `.csv` per table (`customers.csv`,
  `ledger.csv`, `usage.csv`, `cases.csv`, `tickets.csv` optional).
- **Validate:** rules D1–D12 (`src/lib/dataset.ts`, mirrored in
  `server/validate_dataset.py`): required tables, unique ids, enums,
  references resolving, balances reconciling to the cent. The report is
  a pre-check, not a gate — issues are listed with the exact record and
  rule; warnings (duplicate charges, unmatched case amounts) are shown,
  not hidden; auto-filled fields are listed, never silent.
- **Cleanse:** a file uploads anyway, raw or cleansed — that is the
  process. **Load raw & cleanse automatically** runs rules CL1–CL8
  (`src/lib/cleanse.ts`, mirrored in `server/cleanse.py`): duplicate ids
  keep the first occurrence, invalid records and dangling references are
  quarantined and listed, balances are recomputed from the ledger
  (ledger is the source of truth) with old → new recorded, duplicate
  charges / suspended-with-balance / zero-amount entries are kept and
  noted. The cleansed tables are re-validated (0 errors) before they
  load; if they still fail, the cleanse is refused with the remaining
  errors listed. Only a structurally unusable file (missing required
  table, unparseable CSV, no customers, over 5 MB) refuses a load.
- **Take the production-ready file:** the cleansing report offers
  **Download production-ready dataset (.json)** (same shape as
  `test-data.json`, ready for the fulfilment team or as a new seed) and
  per-table CSVs. The same cleanse runs on the command line:
  `python3 server/cleanse.py your-sample.json your-sample.cleansed.json`.
- **Test:** the loaded (cleansed) dataset replaces the working caseload in browser
  state (localStorage); Dashboard, Cases, Medallion and Pipelines all
  recompute from it. **Reset to original dataset** restores the built-in
  seed. The file never leaves the browser and never touches the seed
  files on disk, and the raw file is never modified.
- **Prepare:** `docs/DATASET_GUIDE.md` — what to export, how to
  anonymise names/phones/emails while keeping real amounts and
  relationships, what a good sample looks like (10–20 customers, a few
  known duplicates, 2–3 cases per journey), and the honest timeline to a
  live connection (sample in minutes → access in days to weeks →
  `att` adapter in days once access exists).

---

*End of PRD v1.0 — 2026-11-21.*
