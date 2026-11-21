"""FastAPI reference backend — AT&T AI Foundry demo.

Runs the same deterministic engine as the TypeScript frontend
(server/engine.py mirrors src/lib/engine.ts). Endpoints are stateless
planning/retrieval only: POST /cases/{id}/plan returns the plan and
proposed credit, or an honest failure. Credits are posted only after
human approval — there is no endpoint that moves money on its own.

Run:  uvicorn app:app --reload --port 8000   (from server/)
Docs: http://localhost:8000/docs
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from engine import (
    GROQ_MODEL,
    grounded_answer,
    plan_run,
    run_eval_suite,
    eval_score,
    validate_pipeline_batch,
)
from stair_retriever import answer as stair_answer, load_trees, measure_eval

app = FastAPI(title="AT&T AI Foundry — reference backend", version="1.0.0")

_SEED_PATH = Path(__file__).with_name("seed.json")


def load_state() -> dict:
    """Seed state, shared with the frontend demo (synthetic data only)."""
    if _SEED_PATH.exists():
        return json.loads(_SEED_PATH.read_text())
    return {"customers": [], "ledger": [], "usage": [], "tickets": [],
            "cases": [], "docs": []}


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


@app.get("/health")
def health() -> dict:
    """llm: True means a GROQ_API_KEY is configured, so live mode is
    available — not that a Groq call has succeeded yet."""
    return {"ok": True, "service": "att-ai-foundry", "engine": "deterministic-py",
            "llm": bool(os.environ.get("GROQ_API_KEY")), "llmModel": GROQ_MODEL,
            "realAttSystems": False, "demoData": "synthetic"}


@app.post("/cases/{case_id}/plan")
def plan_case(case_id: str, req: PlanRequest) -> dict:
    case = next((c for c in req.state.get("cases", []) if c["id"] == case_id), None)
    if case is None:
        raise HTTPException(status_code=404, detail=f"Case {case_id} not found.")
    plan = plan_run(req.state, case, live_llm=req.live_llm)
    return {
        "caseId": case_id,
        "status": "failed" if plan.failure_reason else "awaiting_approval",
        "failureReason": plan.failure_reason,
        "proposedCredit": plan.proposed_credit,
        "citation": plan.citation,
        "steps": plan.steps,
        "liveLlm": plan.live_llm,
        "liveLeafPicks": plan.live_leaf_picks,
        "liveSummary": plan.live_summary,
        "note": "Planning only. A credit is posted only after human approval; this endpoint moves no money.",
    }


@app.post("/rag/search")
def rag_search(req: RagRequest) -> dict:
    state = load_state()
    result = grounded_answer(state["docs"], req.query)
    return {"query": req.query, **result, "llm": False}


@app.post("/pipelines/validate")
def pipeline_validate(req: PlanRequest) -> dict:
    return validate_pipeline_batch(req.state)


@app.post("/evals/run")
def evals_run(req: PlanRequest) -> dict:
    results = run_eval_suite(req.state)
    score = eval_score(results)
    return {"results": results, "gatePct": 85, **score}


class StairRequest(BaseModel):
    query: str = Field(..., min_length=2, max_length=500)


@app.post("/stair/retrieve")
def stair_retrieve(req: StairRequest) -> dict:
    """STAIR retrieval over the seeded knowledge trees. No chunking, no
    embeddings — the leaf section is returned intact, cited by full path."""
    return stair_answer(load_trees(), req.query)


@app.get("/stair/eval")
def stair_eval() -> dict:
    """Measured STAIR Recall@1 / invalid-section rate on the seeded eval set."""
    return measure_eval(load_trees())


if __name__ == "__main__":  # pragma: no cover
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
