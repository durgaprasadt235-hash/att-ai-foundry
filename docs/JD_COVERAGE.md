# JD coverage — Principal AI-Native Software Engineer

Every bullet of the JD, mapped to where it is implemented, how to verify
it, and what is honestly still missing. Status key:
**done** = demonstrably working in the repo;
**partial** = working, with a named gap;
**connection** = built, failing honestly until the fulfilment team connects it.
The same coverage is surfaced live in the Dashboard's Production readiness
panel (which computes its rows from `/api/health` and live state).

## 1. Production Python + FastAPI

| JD line | Implemented in | How to verify | Status |
|---|---|---|---|
| Production-grade Python + FastAPI | `server/app.py` (FastAPI 0.115), `server/engine.py`, `server/requirements.txt` | `../.venv/bin/uvicorn app:app --reload --port 8000` from `server/`; docs at `http://localhost:8000/docs` | done |
| Every `api/` endpoint has a FastAPI mirror | `api/health.ts` ↔ `GET /health`; `api/run-case.ts` ↔ `POST /cases/{id}/plan`; `api/rag.ts` ↔ `POST /rag/search`; `api/stair.ts` ↔ `POST /stair/retrieve` | `pytest server/test_health.py` (mirrors exercised over HTTP); compare `api/*.ts` with `server/app.py` | done |
| All endpoints return proper JSON errors | `server/app.py` exception handlers (`json_500_handler`, `datasource_503_handler`); `src/lib/api-utils.ts:jsonError` for `api/` | `pytest server/test_health.py::test_plan_unknown_case_is_json_404`, `test_unknown_route_and_wrong_method_are_json`; `curl` a bad route and check the content type is JSON, never HTML | done |
| README says how to run it (uvicorn) | `README.md` "How to run" | Read it; run the command | done |

## 2. Agentic workflows

| JD line | Implemented in | How to verify | Status |
|---|---|---|---|
| 5 journeys: plan → Customer 360 → STAIR grounding → validate → propose → human approval → execute → verify | `src/lib/engine.ts:planRun`, `server/engine.py:plan_run`, `src/App.tsx:runAgent/approveRun/finishRun` | Create a case on the Dashboard and read the run trace; `pytest server/test_engine.py` | done |
| Agent state machine EXPLICIT, named states + transitions | `src/lib/agent.ts`, `server/agent.py` (`INTAKE → RETRIEVE_360 → GROUND → VALIDATE → PROPOSE → AWAITING_APPROVAL → EXECUTE → VERIFY → DONE`, `FAILED`/`REJECTED` terminal) | `pytest server/test_agent.py` (legal traces, illegal jumps reported); run a case and read the "State machine:" line in the run view; `agentStateTrace` in the plan response | done |
| State trace shown in the UI run view | `src/App.tsx` CasesView ("State machine: … valid/invalid" + trace id) | Cases tab → run a case → run trace panel | done |

## 3. Tool/service contracts

| JD line | Implemented in | How to verify | Status |
|---|---|---|---|
| Per-tool contracts in code (input schema, timeout, retry-once, rate-limit note) | `src/lib/tool-contracts.ts`, `server/tool_contracts.py`, `GET /tools` | `pytest server/test_tool_contracts.py`; `curl localhost:8000/tools` | done |
| Idempotency enforced on every mutating endpoint | `POST /cases/{id}/execute` (`server/app.py`): seen-key store + `credit_already_applied` check; frontend `approveRun` + `creditAlreadyApplied` | `pytest server/test_execute.py` (same key twice → `duplicate: true`, no second credit; already-posted credit → duplicate) | done |
| Retries | Retry-once on transient failures only (tool contracts; Groq client; AT&T adapter; Medallion batch) | `pytest server/test_datasource.py::test_att_retries_once_on_500_then_succeeds`, `test_att_401_is_not_retried` | done |
| Rate limits | Demo-grade in-memory guard (`src/lib/api-utils.ts`, `server/app.py`), 429 + `Retry-After` | `pytest server/test_health.py::test_rate_limit_guard_trips_with_tiny_limit`; `curl` 429 path | done (demo-grade; production at the edge) |
| Error handling | JSON `{ error, reason }` everywhere; 400/404/409/422/429/503 with reasons | `pytest server/test_health.py`, `server/test_execute.py::test_execute_invalid_plan_is_honest_409` | done |
| Access controls | Auth boundary (`src/lib/auth.ts`, `server/auth.py`); AT&T adapter Bearer key; demo runs open on synthetic data with the gate off by default | `pytest server/test_auth.py`; `GET /health` → `auth` block | partial — the Entra ID callback is a placeholder (see §7 / DEPLOYMENT.md step 4) |

## 4. Evaluations

| JD line | Implemented in | How to verify | Status |
|---|---|---|---|
| Eval suite + 85% release gate | `src/lib/engine.ts:runEvalSuite/evalScore`, `server/engine.py:run_eval_suite/eval_score`, `EVAL_GATE_PCT = 85` | Evaluations tab → Run evaluation suite; `pytest server/test_engine.py` | done |
| Gate BLOCKS a "release" action | Evaluations tab → **Request release** button; `POST /evals/release-gate` (`server/app.py`) | Click Request release with no suite / a failing suite → BLOCKED with named failed checks; `pytest server/test_release_gate.py` | done |

## 5. RAG

| JD line | Implemented in | How to verify | Status |
|---|---|---|---|
| STAIR primary, chunk RAG labelled baseline | `src/lib/stair.ts`, `server/stair_retriever.py` | STAIR tab; `pytest server/test_stair.py` | done |
| Honest comparison view (STAIR vs chunk baseline Recall@1, 10 questions) | STAIR tab "Per-query eval detail — STAIR vs chunk-RAG baseline"; `GET /stair/eval` returns both, per query | STAIR tab table; `pytest server/test_stair.py::test_chunk_baseline_eval_has_per_query_detail`, `server/test_health.py::test_stair_eval_includes_chunk_baseline` | done |
| No vector DB by design; adapter interface where embeddings plug in | Comment + seam in `stairRetrieve()` / `retrieve()` (`src/lib/stair.ts`, `server/stair_retriever.py`): replace token-overlap scoring with an embedding lookup over the same leaf titles, keep the trie allowlist | Read the header comments; the contract (only a TOC leaf may be returned) is unchanged by the swap | done |

## 6. End-to-end backend + DB + frontend

| JD line | Implemented in | How to verify | Status |
|---|---|---|---|
| End-to-end backend + DB + frontend | FastAPI (`server/`) + Vercel serverless (`api/`) + React/TS frontend (`src/`); `docker compose up` runs API :8000 + web :4173 | `docker compose up`, then the smoke checks in `docs/DEPLOYMENT.md` | partial — DB reserved (see below) |
| Angular named as an example modern framework | **Honest statement:** the frontend is React + TypeScript, not Angular. React/TS implements the same end-to-end contract, and the API is framework-agnostic — an Angular client can consume it unchanged (same JSON endpoints, same auth header, same idempotency key). | `curl` any endpoint from any client; `README.md` "Honest limits" | partial — framework differs, contract identical |
| Database | `DATABASE_URL` reserved; `server/datasource.py` seed mode; compose `db` service (`profile: with-db`) runs Postgres for wiring | `/health` → `db` block reports "configured but not yet wired" when the var is set; `docs/DEPLOYMENT.md` §4 step 3 lists the wiring work | connection — provisioned, not wired |

## 7. Secure-by-design

| JD line | Implemented in | How to verify | Status |
|---|---|---|---|
| Auth boundary | `src/lib/auth.ts`, `server/auth.py`; UI gate in `src/App.tsx` | `pytest server/test_auth.py`; set `AUTH_ENABLED=true` without config → honest "auth not configured" screen | done (gate) / connection (Entra ID callback not implemented) |
| Secrets via env only | `src/lib/config.ts`, `server/config.py`, `.env.example`; `grep` proves no secret in code (see below) | `grep -r "gsk-\|sk-\|ATT_API_KEY=" --include="*.ts" --include="*.py" src server api \| grep -v "getEnv\|os.environ\|example"` → no hits; `pytest server/test_config.py::test_presence_flags_never_leak_values` | done |
| Audit log | `src/lib/types.ts:AuditEntry` (runId, durationMs, traceId), frontend audit sink, plan/execute responses carry an audit entry | Observability tab → Audit log; `pytest server/test_health.py::test_plan_case_returns_run_id_duration_and_audit` | done |
| Input validation | Pydantic models (`server/app.py`: `RagRequest`, `PlanRequest`, `ExecuteRequest`); `missingToolInputs` | `pytest server/test_execute.py::test_execute_requires_idempotency_key` (422); `test_tool_contracts.py` | done |
| PII-aware handling + redaction helper | `src/lib/redact.ts`, `server/redact.py` (mask phone/email); used at every log/audit/event sink + API responses | `pytest server/test_redact.py`, `server/test_events.py::test_event_payloads_are_redacted`; node check of the TS helper (see verification report) | done |
| Demo data is synthetic | `src/lib/seed.ts`, `server/seed.json`, labelled in the UI + `/health` (`demoData: "synthetic"`) | Read the seed header; Dashboard + Customers tab labels | done |

## 8. Observability

| JD line | Implemented in | How to verify | Status |
|---|---|---|---|
| Structured JSON logging with run id | `server/observability.py:json_log` (one JSON line per action: ts, event, run_id, trace_id, duration_ms) | `pytest server/test_observability.py::test_json_log_emits_one_parseable_json_line`; watch `uvicorn` stdout during a plan call | done |
| Metrics (counts per pipeline/layer) | `GET /metrics` (`server/observability.py:build_metrics`) | `curl localhost:8000/metrics`; `pytest server/test_health.py::test_metrics_counts_come_from_live_state` | done |
| Distributed tracing — traceId on every run | `traceId` on `AgentRun`/`AuditEntry`, plan + execute responses, UI run view | Run a case → trace id in the run panel; `pytest server/test_health.py::test_plan_response_carries_trace_id_and_state_trace` | done |
| Dashboards (app's own views) | Dashboard, Observability, Medallion tabs | Open the app | done |
| Alerting (failure cards + Copilot prompts) | Medallion failure cards (`src/lib/medallion.ts`, `server/medallion.py`) | Medallion tab → Failure cards; quarantine list | done |
| Incident troubleshooting (runbook) | `docs/OPERATOR_RUNBOOK.md`, `docs/DEPLOYMENT.md` §6 | Read them; follow a failure card's Copilot prompt | done |

## 9. Testing / CI / CD / Docker

| JD line | Implemented in | How to verify | Status |
|---|---|---|---|
| pytest + tsc + build | `server/test_*.py`, `npx tsc --noEmit`, `npx tsc -p tsconfig.api.json --noEmit`, `npm run build` | Run the four commands (counts in the verification report) | done |
| GitHub Actions CI | `.github/workflows/ci.yml` (node / python / docker jobs, every push) | Read the file; the Docker job runs `docker build` + `docker compose config` on CI runners | done |
| Dockerfile for the FastAPI backend | `server/Dockerfile` (+ `.dockerignore`) | `docker build -t att-ai-foundry-api ./server` (CI job; **not run in this VM — no Docker binary here**; verified by inspection + parse) | done (build not run locally — see Honest limits) |
| docker-compose.yml (frontend + API + optional Postgres) | `docker-compose.yml` (`api` :8000, `web` :4173, `db` profile `with-db`) | `docker compose config -q` (CI job); `docker compose up` | done (up not run locally — no Docker here) |

## 10. Resilient distributed patterns

| JD line | Implemented in | How to verify | Status |
|---|---|---|---|
| Retries | Retry-once on transient failures (tool contracts, Groq, AT&T adapter, Medallion) | `pytest server/test_datasource.py`, `test_groq.py` | done |
| Timeouts | Groq 20s, AT&T adapter 10s, deterministic tools 5s (tool contracts) | `GET /tools`; read the contracts | done |
| Circuit breaker | `src/lib/groq.ts`, `server/groq_client.py`: opens after 3 consecutive failures, 60s cooldown, half-open trial; reported as `llm_circuit` in `/health` | `pytest server/test_groq.py::test_circuit_breaker_opens_after_three_failures`, `test_circuit_breaker_half_open_trial_success_closes_it`; node check of the TS breaker | done |
| Backpressure (bounded batch sizes) | `MEDALLION_BATCH_LIMIT = 1000` (`src/lib/medallion.ts`, `server/medallion.py`); deferred records reported, never dropped | `pytest server/test_medallion.py::test_incremental_batch_is_bounded_and_defers_the_rest`; Medallion tab batch panel | done |
| Graceful degradation (deterministic fallback everywhere, UI says which mode) | Deterministic engine is the default and the fallback; every run trace + the header say which mode was used | Create a case with no key → trace says "deterministic fallback" / "off"; run with a key → "groq" | done |

## 11. Event-driven

| JD line | Implemented in | How to verify | Status |
|---|---|---|---|
| Event log — every state change emits a structured event | `src/lib/events.ts`, `server/events.py`; event types: `case_created`, `credit_proposed`, `credit_approved`, `credit_executed`, `plan_proposed`, `plan_approved`, `plan_executed`, `pipeline_run`, `pipeline_failed`, `run_failed`, `eval_run`, `release_approved`, `release_blocked` | Observability tab → Event feed; `GET /events`; `pytest server/test_events.py` | done |
| Append-only in-app event feed | In-app feed (Observability tab), server feed (`GET /events`) | Create a case / run a case / run a pipeline → feed grows, newest first | done |
| Kafka/SNS-style note: the feed is the seam where a real event bus plugs in | Header comments in `src/lib/events.ts` + `server/events.py`; `README.md` "Event-driven"; `docs/DEPLOYMENT.md` | Read the comments | done (seam documented; bus not wired — per-instance in-memory feed is not durable) |

## 12. AI coding assistants

| JD line | Implemented in | How to verify | Status |
|---|---|---|---|
| Document that the build used AI-assisted engineering (Muse + Copilot-style fix prompts) with deterministic validation and human approval at every step | `README.md` "How this was built — AI-assisted engineering, disclosed"; Medallion failure cards carry ready-to-paste Copilot prompts (`src/lib/medallion.ts`, `server/medallion.py`) | Read the README section; Medallion tab → Failure cards → "Copy Copilot prompt" | done |

## Honest limits (what is still NOT done)

- **No real AT&T APIs, no real customer data.** The `att` datasource mode is
  built and fails honestly until the fulfilment team connects it
  (`docs/DEPLOYMENT.md` §4 step 1). The demo runs on synthetic seed data.
- **No real Entra ID auth.** The gate, the "not configured" state, and the
  placeholder are built; the OAuth callback handler is not implemented.
- **No live database.** `DATABASE_URL` is reserved; Postgres runs in compose
  (`with-db` profile) for wiring, but no code reads the var yet.
- **No durable event bus / idempotency store.** The feed and the
  seen-key store are in-memory and per-instance; production wires Kafka/SNS
  and a DB unique constraint at those seams.
- **No petabyte-scale measurement.** Medallion scale is architectural, not
  measured (106 seed records).
- **Docker was not built in this VM** (no Docker binary). The Dockerfile and
  compose file were verified by inspection + YAML parse; the CI Docker job
  runs the real `docker build` on every push.
- **The frontend is React + TypeScript, not Angular.** The API is
  framework-agnostic, so an Angular client can consume it unchanged.
