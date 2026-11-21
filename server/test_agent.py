"""Pytest unit tests for the explicit agent state machine (server/agent.py).

A successful CASE-1001 plan traces INTAKE -> RETRIEVE_360 -> GROUND ->
VALIDATE -> PROPOSE -> AWAITING_APPROVAL with every transition legal;
a failed case ends in FAILED; a trace that jumps the approval gate
(PROPOSE -> EXECUTE) is reported invalid.
Run: python3 -m pytest server/test_agent.py -v
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from agent import (  # noqa: E402
    TRANSITIONS,
    is_terminal,
    legal_transition,
    state_trace_for_run,
)
from engine import plan_run  # noqa: E402


def _seed() -> dict:
    return json.loads((Path(__file__).parent / "seed.json").read_text())


def _case(state: dict, case_id: str) -> dict:
    return next(c for c in state["cases"] if c["id"] == case_id)


def test_successful_plan_trace_is_legal():
    state = _seed()
    plan = plan_run(state, _case(state, "CASE-1001"))
    assert plan.failure_reason is None
    trace = state_trace_for_run({
        "steps": plan.steps, "status": "awaiting_approval"})
    assert trace["states"] == ["INTAKE", "RETRIEVE_360", "GROUND",
                               "VALIDATE", "PROPOSE", "AWAITING_APPROVAL"]
    assert trace["current"] == "AWAITING_APPROVAL"
    assert trace["valid"] is True
    assert trace["invalidTransitions"] == []


def test_completed_trace_reaches_done():
    state = _seed()
    plan = plan_run(state, _case(state, "CASE-1001"))
    steps = plan.steps + [
        {"id": "execute", "name": "Execute", "tool": "execute_approved",
         "status": "done", "ms": 1, "retries": 0, "detail": "ok"},
        {"id": "notify", "name": "Notify", "tool": "notify_customer",
         "status": "done", "ms": 1, "retries": 0, "detail": "ok"},
        {"id": "close-verify", "name": "Verify", "tool": "verify_outcome",
         "status": "done", "ms": 1, "retries": 0, "detail": "ok"},
    ]
    trace = state_trace_for_run({"steps": steps, "status": "completed"})
    assert trace["states"][-3:] == ["EXECUTE", "VERIFY", "DONE"]
    assert trace["valid"] is True


def test_failed_plan_trace_ends_failed():
    state = _seed()
    plan = plan_run(state, _case(state, "CASE-1005"))  # roaming: no workflow
    assert plan.failure_reason is not None
    trace = state_trace_for_run({"steps": plan.steps, "status": "failed"})
    assert trace["current"] == "FAILED"
    assert trace["valid"] is True


def test_done_without_execution_is_invalid():
    # A run that claims DONE straight from PROPOSE — no execution, no
    # verification — is not a legal trace.
    trace = state_trace_for_run({
        "steps": [
            {"id": "intake", "name": "", "tool": "", "status": "done",
             "ms": 0, "retries": 0, "detail": ""},
            {"id": "retrieve-360", "name": "", "tool": "", "status": "done",
             "ms": 0, "retries": 0, "detail": ""},
            {"id": "stair-ground", "name": "", "tool": "", "status": "done",
             "ms": 0, "retries": 0, "detail": ""},
            {"id": "validate", "name": "", "tool": "", "status": "done",
             "ms": 0, "retries": 0, "detail": ""},
            {"id": "plan-propose", "name": "", "tool": "", "status": "done",
             "ms": 0, "retries": 0, "detail": ""},
        ],
        "status": "completed"})
    assert trace["valid"] is False
    assert ["PROPOSE", "DONE"] in trace["invalidTransitions"]


def test_execution_without_grounding_is_invalid():
    # A run that jumps INTAKE -> EXECUTE never retrieved, grounded, or
    # validated anything. The approval hop is reconstructed, but
    # INTAKE -> AWAITING_APPROVAL is still an illegal jump.
    trace = state_trace_for_run({
        "steps": [
            {"id": "intake", "name": "", "tool": "", "status": "done",
             "ms": 0, "retries": 0, "detail": ""},
            {"id": "execute", "name": "", "tool": "", "status": "done",
             "ms": 0, "retries": 0, "detail": ""},
        ],
        "status": "completed"})
    assert trace["valid"] is False
    assert ["INTAKE", "AWAITING_APPROVAL"] in trace["invalidTransitions"]


def test_transition_table_covers_every_state():
    for state in ("INTAKE", "RETRIEVE_360", "GROUND", "VALIDATE", "PROPOSE",
                  "AWAITING_APPROVAL", "EXECUTE", "VERIFY", "DONE",
                  "FAILED", "REJECTED"):
        assert state in TRANSITIONS
    assert is_terminal("DONE") and is_terminal("FAILED")
    assert is_terminal("REJECTED") and not is_terminal("PROPOSE")
    assert legal_transition("AWAITING_APPROVAL", "EXECUTE") is True
    assert legal_transition("AWAITING_APPROVAL", "REJECTED") is True
    assert legal_transition("PROPOSE", "EXECUTE") is False
    assert legal_transition("DONE", "INTAKE") is False


def test_empty_run_defaults_to_intake():
    trace = state_trace_for_run({"steps": [], "status": "running"})
    assert trace["states"] == ["INTAKE"]
    assert trace["current"] == "INTAKE"
