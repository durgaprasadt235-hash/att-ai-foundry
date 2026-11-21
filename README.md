# AT&T AI Foundry — Enterprise Customer & Operational Data Platform

Director-grade working prototype for **AJ DiLeo, AI Director @ AT&T, AI Foundry**.
Built by Durga Prasad Thoorpati (Sr. Software Engineer) from the AT&T project:
*Enterprise Customer & Operational Data Platform with GenAI Integration*.

## What this is — and what it is not

**Live inside this prototype:** frontend ↔ serverless API ↔ agent engine ↔
data store are connected; analytics are computed live from real runs; the
LangGraph-style agent code is real Python in `server/`; RAG/STAIR retrieval
is real over seeded policy docs; every state change (credit, plan, order,
ticket) is a real record change you can inspect.

**Live LLM (Groq, when configured):** when `GROQ_API_KEY` is set, the agent
runs in live mode — Groq (`openai/gpt-oss-120b`, free tier) picks each STAIR
leaf from the TOC allowlist and drafts the customer-facing summary. The
allowlist still blocks invented sections, deterministic validation still
decides every amount and eligibility check, and human approval still gates
every credit and plan change. When the key is missing or Groq is
unavailable (rate limit, timeout, invalid pick), the run completes on the
deterministic engine and the trace says so — it never fakes a Groq answer.
Set the key as a Vercel project environment variable after deploy; see
`.env.example`. Without the key, the prototype is fully deterministic.

**Not live:** there is **no real AT&T internal API, and all demo data is
synthetic** (invented names, accounts, invoices). That honesty is deliberate:
a demo that pretends to be production is exactly the kind of pilot that
delivers no measurable return.

## The five customer journeys (one agent, one approval gate)

All five use the same LangGraph-style agent (plan → retrieve → ground →
validate → propose → **human approval** → execute → verify), the same
Customer 360, the same audit trail, and the same measured ROI.

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
twice: the idempotency key makes a repeat run return the original run.

**Plan prices and outage credits are computed, not hardcoded.** Plan prices
come from one price table (Starter $65.00, Premium $87.40, Family Share
$98.00, Business Elite $112.00): a plan change computes target − current from
the customer's actual plan, so a cheaper target posts a credit (CASE-1008:
Family Share → Premium = $10.60 credit, not a $22.40 charge). The $25 outage
credit (POL-006 §5.1) applies only for a network-confirmed outage over 4
hours, and the trace names both the case amount and the policy credit
(CASE-1007: the $18.45 case amount is the reported device installment; the
credit is $25.00).

**Run it in under 2 minutes:** open the app → Dashboard → **Run demo case**
(CASE-1001) → approve the $87.40 credit → watch the balance change, the
notification appear, and the ROI numbers move. Then run any of the other
four cases from the Cases view.

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
- Chunk RAG is kept only as a **labelled baseline** for comparison.

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
Sources (CRM, billing, usage — synthetic seed)
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
        │
        ▼
Execute → ledger / order / plan / ticket changes → notify → verify
        │
        ▼
Measured outcomes (Dashboard) + per-run traces + audit log (Observability)
```

## How to run

```bash
# Frontend (Vite + React + TypeScript)
npm install
npm run dev          # http://localhost:5173
npm run build        # tsc + vite build
npm run preview      # serves dist/ on http://localhost:4173

# Python reference backend (FastAPI + LangGraph-style engine)
cd server
python3 -m venv ../.venv && ../.venv/bin/pip install -r requirements.txt
../.venv/bin/python -m pytest test_engine.py test_stair.py test_groq.py -v
../.venv/bin/uvicorn app:app --reload --port 8000   # docs at http://localhost:8000/docs

# Live Groq mode (optional, local): export GROQ_API_KEY=<key from console.groq.com>
# and pass live_llm: true to /cases/{id}/plan or /api/run-case.
# Without the key the engine runs deterministically and says so.
```

## Deploy (Vercel)

```bash
git init && git add . && git commit -m "AT&T AI Foundry prototype"
# Create the repo on GitHub (user: durgaprasadt235-hash), push, then import in Vercel.
# vercel.json: SPA fallback excludes /api/* — the fallback cannot swallow API routes.
# After import, set GROQ_API_KEY as a Vercel project environment variable
# (Production + Preview) to enable live Groq mode; without it the deployed
# app runs deterministically and says so. Never put the key in code or git.
```

## API contract (serverless, `api/`)

| Endpoint | Method | Body | Returns |
|----------|--------|------|---------|
| `/api/health` | GET | — | `{ ok, engine, llm, llmModel, realAttSystems: false }` — `llm` is true only when `GROQ_API_KEY` is configured |
| `/api/run-case` | POST | `{ case, customers, ledger, usage, tickets, docs, live_llm? }` | plan steps, proposed credit/action, `liveLlm` status, `liveSummary`, or honest failure |
| `/api/rag` | POST | `{ query, docs }` | grounded answer + citations, or refusal (baseline only) |
| `/api/stair` | POST | `{ query, trees, live_llm? }` | intact leaf + full path citation, or “not found in policy” |

All endpoints are **stateless**: the caller posts its current state; no
server-side persistence in the demo (browser state persists in localStorage).
Validation errors return 400 with a reason; wrong method returns 405.

## Agent tool contracts

| Tool | Input schema | Guarantees |
|------|--------------|-----------|
| `validate_case` | `{ caseId, idempotencyKey }` | 400 if case/customer missing; duplicate key returns the original run |
| `get_customer_360` | `{ customerId }` | read-only; returns customer + ledger + usage + tickets |
| `stair_retrieve` | `{ query }` | only a TOC leaf title may be returned; refusal when no match |
| `search_knowledge` (baseline) | `{ query }` | grounded answer or refusal; never invents |
| `validate_duplicate` | `{ customerId }` | duplicate = same service + amount, different invoices, ≤ 7 days |
| `propose_credit` / `propose_*` | `{ amount, reason, citation }` | proposal only — execution requires human approval |
| `execute_approved` | `{ runId, approval }` | idempotent: a posted credit is never posted twice |

Retries: tool calls retry once on transient failure and record the retry
count in the run trace. Rate limits: the demo engine is local and
synchronous; the production contract is 60 requests/min per caller with
429 + `Retry-After`. Errors are structured `{ error, reason }`, never a
silent success.

## Evaluation criteria

- **Agent eval suite** (Evaluations view, 8 checks, **85% release gate**):
  duplicate detection, amount, non-duplicate discrimination, RAG grounding,
  RAG refusal, idempotency, agent plan. Runs against live state — delete
  POL-001 and the suite fails.
- **STAIR eval** (STAIR view, 10 queries): measured Recall@1 and
  invalid-section rate, plus the chunk-RAG baseline on the same queries.
- **ROI** (Dashboard): cases resolved, success rate, median agent time
  (measured per run, vs the 38-minute manual baseline in POL-005), cost per
  case ($28.50 manual vs $0.85 agent — stated assumptions, labelled in the
  footer), credits issued, orders activated, technician visits scheduled.
  All computed from real records; **“— / No runs yet”** when zero runs exist.

## Honest limits

- Live Groq mode needs `GROQ_API_KEY` set (Vercel env var in production,
  or exported locally). Without it the agent is deterministic code, not a
  model — and it says so in every run trace. Groq never executes anything:
  it only picks a STAIR leaf from the allowlist and drafts a summary.
- No API key, no real AT&T APIs, no real customer data.
- Serverless demo state lives in the browser (localStorage); the Python
  backend is a reference implementation, not the deployed demo backend.
- Agent runs use real measured timing (each step is awaited and timed), but
  the “agent” is deterministic code, not a model.
- Manual baseline (38 min, $28.50/case) and agent cost ($0.85/run) are
  stated assumptions from POL-005 / the footer, not measured cloud bills.
- One-click demo case: CASE-1001 is pre-seeded and ready; the other cases
  are one click each from the Cases view.

## Files

```
src/lib/engine.ts      deterministic agent engine (TS) — plan by case type
src/lib/groq.ts        live Groq client (TS) — leaf pick + summary, User-Agent att-ai-foundry/1.0
src/lib/stair.ts       STAIR retriever (TS) + eval set + measured recall
src/lib/seed.ts        synthetic seed: 20 customers, 12 cases, 8 docs, 3 trees
src/lib/types.ts       record types
src/App.tsx            Dashboard, Customers, Cases, Pipelines, RAG, STAIR, Evals, Observability
api/                   Vercel serverless: health, run-case, rag, stair
server/engine.py       Python port of the agent engine (live_llm mode included)
server/groq_client.py  live Groq client (Python) — leaf pick + summary, User-Agent att-ai-foundry/1.0
server/stair_retriever.py  STAIR (Python) with trie allowlist
server/app.py          FastAPI reference backend (live_llm flag on /cases/{id}/plan)
server/test_engine.py  pytest: 26 tests (billing + 4 journeys + evals)
server/test_stair.py   pytest: 8 tests (valid leaf, intact section, refusal)
server/test_groq.py    pytest: 11 tests (mocked Groq — success, invalid pick, 429, missing key)
server/seed.json       seed state shared with the Python backend
vercel.json            SPA fallback excludes /api/* (do not change this)
```
