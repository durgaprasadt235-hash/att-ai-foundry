"""FastAPI reference backend — AT&T AI Foundry demo.

Runs the same deterministic engine as the TypeScript frontend
(server/engine.py mirrors src/lib/engine.ts). Endpoints are stateless
planning/retrieval, plus ONE mutating endpoint: POST /cases/{id}/execute
executes an approved plan against posted state and returns the updated
state. Credits are posted only after human approval — the plan endpoint
moves no money, and execute is idempotent (seen idempotency keys and
already-posted credits return the original outcome, never a second
credit).

Every endpoint in api/ (Vercel serverless) has a mirror here:
  api/health.ts    -> GET  /health
  api/run-case.ts  -> POST /cases/{id}/plan
  api/rag.ts       -> POST /rag/search
  api/stair.ts     -> POST /stair/retrieve
Plus: /medallion, /pipelines/validate, /evals/run, /evals/release-gate,
  /stair/eval, /datasource/status, /metrics, /events, /tools.

Run:  uvicorn app:app --reload --port 8000   (from server/)
Docs: http://localhost:8000/docs
"""
from __future__ import annotations

import copy
import os
import time
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from agent import state_trace_for_run
from auth import auth_status
from config import ConfigError, config_presence, load_config, require_config
from datasource import DatasourceError, datasource_from_config, load_state as load_datasource_state
from engine import (
    EVAL_GATE_PCT,
    GROQ_MODEL,
    credit_already_applied,
    eval_score,
    execute_approved,
    grounded_answer,
    plan_run,
    run_eval_suite,
    validate_pipeline,
)
from events import emit_event, list_events
from groq_client import circuit_state, probe_live
from medallion import build_medallion, default_batch_id, spark_job_reference
from observability import build_metrics, json_log, new_trace_id
from redact import redact_pii
from stair_retriever import (
    answer as stair_answer,
    load_trees,
    measure_chunk_rag_eval,
    measure_eval,
)
from tool_contracts import TOOL_CONTRACTS

app = FastAPI(title="AT&T AI Foundry — reference backend", version="1.0.0")

# --- Startup config: fail loudly when a REQUIRED var is missing for the
# selected mode (e.g. DATASOURCE=att without ATT_API_BASE_URL/ATT_API_KEY).
# Demo mode (seed, auth off, no keys) always validates clean. ---
try:
    CONFIG = require_config()
except ConfigError as exc:  # pragma: no cover - exercised in test_config.py
    raise RuntimeError(str(exc)) from exc


def load_state() -> dict:
    """State from the configured datasource (seed by default). In `att`
    mode this raises DatasourceError honestly — never falls back to seed."""
    return load_datasource_state(CONFIG)


# --- Endpoint counters (in-memory, per process) for GET /metrics. ---
_counters: dict[str, int] = {
    "plans": 0, "executes": 0, "duplicates_blocked": 0, "evals": 0,
}

# --- Idempotency store for POST /cases/{id}/execute: idempotency key ->
# the outcome returned the first time. DEMO-GRADE (in-memory, per
# instance, resets on restart); production uses a DB unique constraint
# on the idempotency key. A repeated key returns the ORIGINAL outcome —
# the credit is never posted twice. ---
_executed_keys: dict[str, dict] = {}


# The operator id tagged on every audit entry and event (staff
# accountability, BACKEND ONLY — never rendered on any screen).
# Demo mode uses the single labelled id "demo-operator"; in production
# this resolves to the signed-in operator's Entra ID subject once the
# OAuth callback exists. Never invent a real person's identity here.
DEMO_OPERATOR_ID = "demo-operator"


def _audit_entry(action: str, detail: str, run_id: str, trace_id: str,
                 duration_ms: int, actor: str = "agent",
                 operator_id: str = DEMO_OPERATOR_ID) -> dict:
    return {
        "id": f"AUD-{run_id[4:]}",
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "actor": actor,
        "action": action,
        "detail": redact_pii(detail),
        "operatorId": operator_id,
        "runId": run_id,
        "durationMs": duration_ms,
        "traceId": trace_id,
    }


# --- Honest LLM liveness: the probe result is cached for 60s so /health
# stays fast. `llm_live` is True ONLY when a real Groq call succeeded. ---
_probe_cache: dict = {"at": 0.0, "live": False}
PROBE_CACHE_SECONDS = 60


def llm_live() -> bool:
    if not CONFIG.groq_api_key:
        return False
    now = time.monotonic()
    if now - _probe_cache["at"] < PROBE_CACHE_SECONDS:
        return _probe_cache["live"]
    live = probe_live(CONFIG.groq_api_key)
    _probe_cache.update({"at": now, "live": live})
    return live


# --- Demo-grade rate-limit guard (in-memory, per app instance, resets on
# restart). Stops a runaway caller in the demo; production rate limiting
# belongs at the edge (API gateway / WAF) at the documented 60 req/min
# per caller. Default 120/min here so the local test suite and a demo
# session never trip it; set RATE_LIMIT_PER_MINUTE to tighten. ---
RATE_LIMIT_PER_MINUTE = int(os.environ.get("RATE_LIMIT_PER_MINUTE", "120"))
RATE_LIMIT_WINDOW_SECONDS = 60
_rate_hits: dict[str, list[float]] = {}


def _check_rate_limit(client_ip: str) -> int | None:
    """Return retry-after seconds when over the limit, else None."""
    now = time.monotonic()
    window_start = now - RATE_LIMIT_WINDOW_SECONDS
    hits = [t for t in _rate_hits.get(client_ip, []) if t > window_start]
    if len(hits) >= RATE_LIMIT_PER_MINUTE:
        return max(1, int(hits[0] + RATE_LIMIT_WINDOW_SECONDS - now))
    hits.append(now)
    _rate_hits[client_ip] = hits
    return None


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    retry_after = _check_rate_limit(
        request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        or (request.client.host if request.client else "unknown"))
    if retry_after is not None:
        return JSONResponse(
            status_code=429,
            content={"error": "Rate limit exceeded",
                     "reason": f"Demo-grade guard: {RATE_LIMIT_PER_MINUTE} "
                               f"requests per minute per client. Retry after "
                               f"{retry_after}s. Production rate limiting "
                               "belongs at the edge."},
            headers={"Retry-After": str(retry_after)})
    return await call_next(request)


@app.exception_handler(Exception)
async def json_500_handler(_request: Request, exc: Exception):
    """Every unexpected error is JSON, never an HTML 500 page."""
    json_log("error", error=exc.__class__.__name__, reason=str(exc))
    return JSONResponse(status_code=500, content={
        "error": "Internal error",
        "reason": str(exc) or exc.__class__.__name__})


@app.exception_handler(DatasourceError)
async def datasource_503_handler(_request: Request, exc: DatasourceError):
    """The configured data source failed — an honest 503, never a silent
    fallback to seed data and never a 500 HTML page."""
    return JSONResponse(status_code=503, content={
        "error": "Datasource unavailable",
        "reason": exc.reason})


class RagRequest(BaseModel):
    query: str = Field(..., min_length=2, max_length=500)


class PlanRequest(BaseModel):
    # Full state is posted so the endpoint stays stateless (serverless-safe).
    state: dict
    # live_llm=True asks Groq (openai/gpt-oss-120b) to pick each STAIR leaf
    # and draft the summary. GROQ_API_KEY must be set server-side; the key
    # is never accepted in the request body. Unavailable Groq falls back
    # to the deterministic engine and the trace says so.
    live_llm: bool = False
    # Which pipeline to validate (PIPE-01/02/03). The endpoint validates
    # only that pipeline's own source; "" fails as an unknown pipeline.
    pipeline_id: str = ""


class ExecuteRequest(BaseModel):
    # Full state is posted; the updated state is returned. Stateless.
    state: dict
    # REQUIRED: the case's idempotency key. A repeated key returns the
    # original outcome — the credit is never posted twice.
    idempotencyKey: str = Field(..., min_length=1, max_length=200)
    # Optional: the run id from the earlier /plan call (for tracing).
    runId: str = ""


@app.get("/health")
def health() -> dict:
    """Liveness + honest capability flags. `llm_live` is True ONLY when a
    live Groq call succeeded in the last 60s — a configured key alone
    reports `llm_configured: true, llm_live: false` until the probe
    succeeds. `llm` is kept for compatibility and equals `llm_live`.
    `llm_circuit` is the Groq circuit breaker: closed | open | half-open."""
    presence = config_presence(CONFIG)
    live = llm_live()
    att_configured = bool(CONFIG.att_api_base_url and CONFIG.att_api_key)
    return {
        "ok": True,
        "service": "att-ai-foundry",
        "engine": "deterministic-py",
        "llm": live,
        "llm_configured": presence["groqApiKey"],
        "llm_live": live,
        "llm_circuit": circuit_state(),
        "llmModel": GROQ_MODEL if live else None,
        "datasource": {
            "mode": CONFIG.datasource,
            "status": "seed" if CONFIG.datasource == "seed"
                      else "configured" if att_configured else "not_configured",
            "detail": "Synthetic demo data (seed). Set DATASOURCE=att with "
                      "ATT_API_BASE_URL + ATT_API_KEY for the live AT&T "
                      "adapter." if CONFIG.datasource == "seed" else
                      "Live AT&T adapter configured. Data loads fail "
                      "honestly if the AT&T API is unreachable — never "
                      "falls back to seed." if att_configured else
                      "att mode selected but ATT_API_BASE_URL / "
                      "ATT_API_KEY are missing. Data loads will fail "
                      "honestly until they are set.",
        },
        "db": {
            "mode": "postgres_configured" if presence["databaseUrl"] else "seed",
            "configured": presence["databaseUrl"],
            "detail": "DATABASE_URL is set, but no live database is wired "
                      "yet — the demo still uses seed state. See "
                      "docs/DEPLOYMENT.md." if presence["databaseUrl"] else
                      "No live database. Demo state is the seed file.",
        },
        "auth": auth_status(CONFIG),
        "realAttSystems": CONFIG.datasource == "att",
        "demoData": "synthetic" if CONFIG.datasource == "seed" else "live-att",
    }


@app.get("/datasource/status")
def datasource_status() -> dict:
    """Probe the configured datasource and report honestly. In `att` mode
    this actually calls the AT&T API (one cheap GET); a failure is
    reported, never masked with seed data."""
    ds = datasource_from_config(CONFIG)
    if ds.mode == "seed":
        state = ds.load_state()
        return {"mode": "seed", "status": "seed",
                "detail": "Synthetic demo data.",
                "counts": {k: len(v) for k, v in state.items()
                           if isinstance(v, list)}}
    probe = ds.probe()
    return {"mode": "att",
            "status": "reachable" if probe["reachable"] else "unreachable",
            "detail": probe["error"] or
                      f"AT&T API reachable ({probe['customers']} customers).",
            "customers": probe["customers"]}


@app.get("/metrics")
def metrics() -> dict:
    """Counts per pipeline/layer (Bronze / Silver / Gold) + endpoint
    counters. All numbers come from the live state — nothing hardcoded."""
    try:
        state = load_state()
    except DatasourceError as exc:
        return {"datasourceError": exc.reason, "counters": dict(_counters)}
    return build_metrics(state, _counters)


@app.get("/events")
def events(limit: int = 50) -> dict:
    """Append-only event feed (newest first). The seam where a real event
    bus (Kafka / SNS / EventBridge) plugs in — see server/events.py."""
    return {"events": list_events(limit)}


@app.get("/tools")
def tools() -> dict:
    """Per-tool contracts: input schema, timeout, retry-once, rate-limit
    note, idempotency rule. See server/tool_contracts.py."""
    return {"tools": TOOL_CONTRACTS}


@app.post("/cases/{case_id}/plan")
def plan_case(case_id: str, req: PlanRequest) -> dict:
    case = next((c for c in req.state.get("cases", []) if c["id"] == case_id), None)
    if case is None:
        raise HTTPException(status_code=404, detail=f"Case {case_id} not found.")
    # Every run gets a run ID, a trace ID and a measured duration; the
    # response carries a structured audit entry and the explicit agent
    # state-machine trace — the same fields the frontend audit log
    # stores (see src/lib/types.ts AuditEntry, src/lib/agent.ts).
    run_id = f"RUN-{uuid.uuid4().hex[:8]}"
    trace_id = new_trace_id()
    started = time.monotonic()
    plan = plan_run(req.state, case, live_llm=req.live_llm)
    duration_ms = round((time.monotonic() - started) * 1000)
    _counters["plans"] += 1
    status = "failed" if plan.failure_reason else "awaiting_approval"
    trace = state_trace_for_run({"steps": plan.steps, "status": status})
    steps = [{**s, "detail": redact_pii(s["detail"])} for s in plan.steps]
    json_log("plan_completed", run_id=run_id, trace_id=trace_id,
             case_id=case_id, duration_ms=duration_ms, status=status)
    if plan.failure_reason:
        emit_event("run_failed", "agent", plan.failure_reason,
                   run_id=run_id, trace_id=trace_id)
    elif plan.proposed_credit is not None:
        emit_event("credit_proposed", "agent",
                   f"Proposed credit ${plan.proposed_credit:.2f} for {case_id}",
                   run_id=run_id, trace_id=trace_id)
    else:
        emit_event("plan_proposed", "agent",
                   f"Proposed {plan.proposed_action or 'action'} for {case_id}",
                   run_id=run_id, trace_id=trace_id)
    return {
        "runId": run_id,
        "traceId": trace_id,
        "durationMs": duration_ms,
        "caseId": case_id,
        "idempotencyKey": case.get("idempotencyKey", ""),
        "status": status,
        "failureReason": plan.failure_reason,
        "proposedCredit": plan.proposed_credit,
        "citation": plan.citation,
        "steps": steps,
        "agentStateTrace": trace,
        "liveLlm": plan.live_llm,
        "liveLeafPicks": plan.live_leaf_picks,
        "liveSummary": plan.live_summary,
        "audit": _audit_entry(
            "run_failed" if plan.failure_reason else "awaiting_approval",
            plan.failure_reason or f"Plan proposed for {case_id}",
            run_id, trace_id, duration_ms),
        "note": "Planning only. A credit is posted only after human approval; this endpoint moves no money.",
    }


@app.post("/cases/{case_id}/execute")
def execute_case(case_id: str, req: ExecuteRequest) -> dict:
    """Execute an APPROVED plan — the one mutating endpoint. The caller
    posts the current state + the case's idempotency key and gets the
    updated state back (stateless: no server-side persistence).

    Idempotency is ENFORCED, twice: (1) a repeated idempotency key
    returns the ORIGINAL outcome with duplicate: true; (2) a credit
    already posted for the case (LED-CR-<case>) is never posted again.
    A plan that is no longer valid (duplicate gone, account changed)
    fails with an honest 409 — never a silent success.
    """
    case = next((c for c in req.state.get("cases", []) if c["id"] == case_id), None)
    if case is None:
        raise HTTPException(status_code=404, detail=f"Case {case_id} not found.")
    run_id = req.runId or f"RUN-{uuid.uuid4().hex[:8]}"
    trace_id = new_trace_id()
    started = time.monotonic()
    key = req.idempotencyKey
    if key in _executed_keys:
        _counters["duplicates_blocked"] += 1
        stored = dict(_executed_keys[key])
        stored["duplicate"] = True
        stored["durationMs"] = round((time.monotonic() - started) * 1000)
        json_log("execute_duplicate", run_id=run_id, trace_id=trace_id,
                 case_id=case_id, idempotency_key=key)
        return stored
    # Re-validate the plan against the CURRENT state: approval was for a
    # plan computed earlier, and the world may have changed since.
    plan = plan_run(req.state, case)
    if plan.failure_reason:
        raise HTTPException(status_code=409, detail={
            "error": "Plan no longer valid",
            "reason": plan.failure_reason})
    credit_kinds = ("credit", "outage_credit", "retention_offer")
    if plan.effect_kind in credit_kinds and credit_already_applied(req.state, case_id):
        _counters["duplicates_blocked"] += 1
        duration_ms = round((time.monotonic() - started) * 1000)
        outcome = {
            "runId": run_id, "traceId": trace_id, "durationMs": duration_ms,
            "caseId": case_id, "status": "completed", "duplicate": True,
            "effectKind": plan.effect_kind, "creditApplied": None,
            "resolution": "Credit already applied — idempotent, no second credit.",
            "updatedState": req.state,
            "audit": _audit_entry("approve_duplicate",
                                  "Credit already applied — idempotent, no second credit.",
                                  run_id, trace_id, duration_ms, actor="human"),
        }
        _executed_keys[key] = dict(outcome)
        return outcome
    new_state = copy.deepcopy(req.state)
    try:
        outcome = execute_approved(new_state, case, plan)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={
            "error": "Cannot execute",
            "reason": str(exc)}) from exc
    duration_ms = round((time.monotonic() - started) * 1000)
    _counters["executes"] += 1
    event_type = ("credit_executed" if plan.effect_kind in credit_kinds
                  else "plan_executed")
    emit_event(event_type, "human", outcome["resolution"],
               run_id=run_id, trace_id=trace_id)
    json_log("execute_completed", run_id=run_id, trace_id=trace_id,
             case_id=case_id, duration_ms=duration_ms,
             effect_kind=plan.effect_kind)
    response = {
        "runId": run_id, "traceId": trace_id, "durationMs": duration_ms,
        "caseId": case_id, "status": "completed", "duplicate": False,
        "effectKind": outcome["effectKind"],
        "creditApplied": outcome["creditApplied"],
        "resolution": outcome["resolution"],
        "ledgerEntryId": outcome["ledgerEntryId"],
        "updatedState": new_state,
        "audit": _audit_entry("approved", outcome["resolution"],
                              run_id, trace_id, duration_ms, actor="human"),
    }
    _executed_keys[key] = dict(response)
    return response


@app.post("/rag/search")
def rag_search(req: RagRequest) -> dict:
    state = load_state()
    result = grounded_answer(state["docs"], req.query)
    return {"query": req.query, **result, "llm": False}


@app.get("/medallion")
def medallion_snapshot() -> dict:
    """Bronze → Silver → Gold snapshot for the seeded state, with the
    quarantine list and reconciliation (bronze = silver passed +
    quarantined). Gold aggregates use only Silver-passed records."""
    state = load_state()
    return build_medallion(state, default_batch_id(state))


@app.get("/medallion/spark-job")
def medallion_spark_job() -> dict:
    """Databricks / Spark job outline for production. Reference only —
    it is not executed; the demo runs the same logic in plain Python."""
    return spark_job_reference()


@app.post("/pipelines/validate")
def pipeline_validate(req: PlanRequest) -> dict:
    # Per-pipeline: the caller names the pipeline; only its own source is
    # validated. An unknown/absent id fails honestly instead of silently
    # validating the whole batch (the old behaviour).
    result = validate_pipeline(req.pipeline_id, req.state)
    if result["failed"] > 0:
        emit_event("pipeline_failed", "system",
                   f"Pipeline {req.pipeline_id}: {result['failed']} failed. "
                   + "; ".join(result["exceptions"][:3]))
    else:
        emit_event("pipeline_run", "system",
                   f"Pipeline {req.pipeline_id}: {result['processed']} "
                   "processed, 0 failed.")
    return result


@app.post("/evals/run")
def evals_run(req: PlanRequest) -> dict:
    results = run_eval_suite(req.state)
    score = eval_score(results)
    _counters["evals"] += 1
    emit_event("eval_run", "system",
               f"Evaluation suite: {score['scorePct']}% "
               f"(gate {EVAL_GATE_PCT}%) — "
               f"{'PASS' if score['passed'] else 'FAIL'}.")
    return {"results": results, "gatePct": EVAL_GATE_PCT, **score}


@app.post("/evals/release-gate")
def release_gate(req: PlanRequest) -> dict:
    """The 85% release gate, as an endpoint: runs the eval suite and
    BLOCKS the release when the gate fails, naming the failed checks.
    The UI's Release button calls this — a release is never approved
    on a failing suite."""
    results = run_eval_suite(req.state)
    score = eval_score(results)
    failures = [r["name"] for r in results if not r["passed"]]
    released = score["passed"]
    if released:
        emit_event("release_approved", "system",
                   f"Release approved: eval suite {score['scorePct']}% "
                   f"(gate {EVAL_GATE_PCT}%).")
    else:
        emit_event("release_blocked", "system",
                   f"Release BLOCKED: eval suite {score['scorePct']}% "
                   f"(gate {EVAL_GATE_PCT}%). Failed: "
                   + "; ".join(failures))
    return {
        "released": released,
        "scorePct": score["scorePct"],
        "gatePct": EVAL_GATE_PCT,
        "passed": score["passed"],
        "failures": failures,
        "reason": ("Release approved — eval suite passed the "
                   f"{EVAL_GATE_PCT}% gate."
                   if released else
                   "Release BLOCKED — eval suite failed the "
                   f"{EVAL_GATE_PCT}% gate. Failed checks: "
                   + "; ".join(failures)),
    }


class StairRequest(BaseModel):
    query: str = Field(..., min_length=2, max_length=500)


@app.post("/stair/retrieve")
def stair_retrieve(req: StairRequest) -> dict:
    """STAIR retrieval over the seeded knowledge trees. No chunking, no
    embeddings — the leaf section is returned intact, cited by full path."""
    return stair_answer(load_trees(), req.query)


@app.get("/stair/eval")
def stair_eval() -> dict:
    """Measured STAIR Recall@1 / invalid-section rate on the seeded eval
    set, plus the chunk-RAG baseline on the same 10 questions — the
    honest side-by-side comparison."""
    state = load_state()
    return {"stair": measure_eval(load_trees()),
            "chunkBaseline": measure_chunk_rag_eval(state.get("docs", []))}


if __name__ == "__main__":  # pragma: no cover
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
