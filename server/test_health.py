"""Pytest HTTP tests for the FastAPI backend (server/app.py).

/health reports llm/datasource/db/auth status truthfully (llm_live is
False here: no GROQ_API_KEY is set in the test env, so no probe can
succeed). Plan responses carry a run ID, a measured duration, and a
structured audit entry. Errors are JSON, never HTML. The demo-grade
rate-limit guard is exercised directly with a tiny limit.
Run: python3 -m pytest server/test_health.py -v
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app as app_module  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(app_module.app)


def _seed() -> dict:
    return json.loads((Path(__file__).parent / "seed.json").read_text())


def test_health_seed_mode_honest_flags():
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["engine"] == "deterministic-py"
    # No key in the test env: configured AND live must both be False.
    assert body["llm"] is False
    assert body["llm_configured"] is False
    assert body["llm_live"] is False
    assert body["llmModel"] is None
    assert body["datasource"]["mode"] == "seed"
    assert body["datasource"]["status"] == "seed"
    assert body["db"]["mode"] == "seed"
    assert body["db"]["configured"] is False
    assert body["auth"]["enabled"] is False
    assert body["realAttSystems"] is False
    assert body["demoData"] == "synthetic"


def test_datasource_status_seed_counts():
    r = client.get("/datasource/status")
    assert r.status_code == 200
    body = r.json()
    assert body["mode"] == "seed"
    assert body["counts"]["customers"] == 20
    assert body["counts"]["ledger"] == 66


def test_plan_case_returns_run_id_duration_and_audit():
    r = client.post("/cases/CASE-1001/plan",
                    json={"state": _seed(), "live_llm": False})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "awaiting_approval"
    assert body["proposedCredit"] == 87.4
    assert body["runId"].startswith("RUN-")
    assert isinstance(body["durationMs"], int) and body["durationMs"] >= 0
    audit = body["audit"]
    assert audit["runId"] == body["runId"]
    assert audit["durationMs"] == body["durationMs"]
    assert audit["actor"] == "agent"
    assert audit["action"] == "awaiting_approval"


def test_plan_case_failed_run_audit_action():
    # CASE-1005 is a roaming dispute — no agent workflow, fails honestly.
    r = client.post("/cases/CASE-1005/plan",
                    json={"state": _seed(), "live_llm": False})
    assert r.status_code == 200
    assert r.json()["status"] == "failed"
    assert r.json()["audit"]["action"] == "run_failed"
    assert r.json()["runId"].startswith("RUN-")


def test_plan_unknown_case_is_json_404():
    r = client.post("/cases/CASE-9999/plan",
                    json={"state": _seed(), "live_llm": False})
    assert r.status_code == 404
    assert "CASE-9999" in r.json()["detail"]
    assert "text/html" not in r.headers["content-type"]


def test_unknown_route_and_wrong_method_are_json():
    r = client.get("/no-such-route")
    assert r.status_code == 404
    assert "text/html" not in r.headers["content-type"]
    r = client.post("/health")
    assert r.status_code == 405
    assert "detail" in r.json() or "error" in r.json()


def test_rate_limit_guard_trips_with_tiny_limit():
    old = app_module.RATE_LIMIT_PER_MINUTE
    app_module.RATE_LIMIT_PER_MINUTE = 3
    try:
        ip = "test-rate-limit-ip"
        assert app_module._check_rate_limit(ip) is None
        assert app_module._check_rate_limit(ip) is None
        assert app_module._check_rate_limit(ip) is None
        retry_after = app_module._check_rate_limit(ip)
        assert isinstance(retry_after, int) and retry_after >= 1
    finally:
        app_module.RATE_LIMIT_PER_MINUTE = old


def test_rag_validation_error_is_json():
    r = client.post("/rag/search", json={})
    assert r.status_code == 422
    assert "text/html" not in r.headers["content-type"]


def test_health_reports_circuit_state():
    body = client.get("/health").json()
    assert body["llm_circuit"] in ("closed", "open", "half-open")


def test_metrics_counts_come_from_live_state():
    body = client.get("/metrics").json()
    assert body["records"]["customers"] == 20
    assert body["records"]["ledger"] == 66
    assert body["medallion"]["bronze"] == 106
    assert body["medallion"]["silverPassed"] + \
        body["medallion"]["silverQuarantined"] == 106
    assert body["medallion"]["goldLedger"] == 63
    assert body["counters"]["plans"] >= 1  # earlier plan tests counted


def test_tools_endpoint_lists_contracts():
    body = client.get("/tools").json()
    tools = body["tools"]
    assert "execute_approved" in tools
    assert tools["execute_approved"]["mutating"] is True
    assert tools["execute_approved"]["retries"] == 0
    assert tools["groq_chat"]["timeoutMs"] == 20000
    assert tools["stair_retrieve"]["timeoutMs"] == 5000


def test_events_endpoint_lists_feed():
    # Planning a case emits a credit_proposed event (CASE-1001).
    client.post("/cases/CASE-1001/plan",
                json={"state": _seed(), "live_llm": False})
    body = client.get("/events").json()
    assert "events" in body
    assert any(e["type"] == "credit_proposed" for e in body["events"])


def test_stair_eval_includes_chunk_baseline():
    body = client.get("/stair/eval").json()
    assert "stair" in body and "chunkBaseline" in body
    assert body["stair"]["total"] == 10
    assert body["chunkBaseline"]["total"] == 10
    assert len(body["chunkBaseline"]["perQuery"]) == 10
    assert body["stair"]["invalidSections"] == 0


def test_plan_response_carries_trace_id_and_state_trace():
    body = client.post("/cases/CASE-1001/plan",
                       json={"state": _seed(), "live_llm": False}).json()
    assert body["traceId"].startswith("TRC-")
    assert body["audit"]["traceId"] == body["traceId"]
    trace = body["agentStateTrace"]
    assert trace["states"] == ["INTAKE", "RETRIEVE_360", "GROUND",
                               "VALIDATE", "PROPOSE", "AWAITING_APPROVAL"]
    assert trace["valid"] is True
    assert trace["current"] == "AWAITING_APPROVAL"
