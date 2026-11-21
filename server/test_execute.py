"""Pytest HTTP tests for the mutating endpoint POST /cases/{id}/execute
(server/app.py) — the one place a credit is actually posted server-side.

Idempotency is ENFORCED twice: a repeated idempotency key returns the
original outcome, and a credit already posted for the case is never
posted again. A plan that is no longer valid fails with an honest 409.
Run: python3 -m pytest server/test_execute.py -v
"""
from __future__ import annotations

import copy
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app as app_module  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(app_module.app)


def _seed() -> dict:
    return json.loads((Path(__file__).parent / "seed.json").read_text())


def _key() -> str:
    return f"test-{uuid.uuid4().hex[:8]}-v1"


def test_execute_case_1001_posts_credit_once():
    state = _seed()
    before = next(c for c in state["customers"] if c["id"] == "CUST-1001")
    balance_before = before["balance"]
    r = client.post("/cases/CASE-1001/execute",
                    json={"state": state, "idempotencyKey": _key()})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "completed"
    assert body["duplicate"] is False
    assert body["effectKind"] == "credit"
    assert body["creditApplied"] == 87.4
    assert body["traceId"].startswith("TRC-")
    assert body["audit"]["traceId"] == body["traceId"]
    updated = body["updatedState"]
    entries = [e for e in updated["ledger"] if e["id"] == "LED-CR-CASE-1001"]
    assert len(entries) == 1
    assert entries[0]["amount"] == -87.4
    after = next(c for c in updated["customers"] if c["id"] == "CUST-1001")
    assert after["balance"] == round(balance_before - 87.4, 2)
    assert updated["notifications"], "customer must be notified"


def test_execute_same_key_twice_returns_original_no_second_credit():
    key = _key()
    state = _seed()
    first = client.post("/cases/CASE-1001/execute",
                        json={"state": state, "idempotencyKey": key})
    assert first.status_code == 200
    # Second call posts the SAME state again (as a retry would) with the
    # same key: it must return the original outcome, not a second credit.
    second = client.post("/cases/CASE-1001/execute",
                         json={"state": state, "idempotencyKey": key})
    assert second.status_code == 200
    assert second.json()["duplicate"] is True
    assert second.json()["creditApplied"] == 87.4


def test_execute_after_credit_posted_is_duplicate_with_new_key():
    state = _seed()
    state["ledger"].append({
        "id": "LED-CR-CASE-1001", "customerId": "CUST-1001",
        "invoice": "INV-2041", "date": "2026-11-21",
        "service": "Credit — duplicate charge INV-2041", "amount": -87.4,
        "kind": "credit", "status": "posted"})
    r = client.post("/cases/CASE-1001/execute",
                    json={"state": state, "idempotencyKey": _key()})
    assert r.status_code == 200
    assert r.json()["duplicate"] is True
    assert "already applied" in r.json()["resolution"]
    assert len([e for e in r.json()["updatedState"]["ledger"]
                if e["id"] == "LED-CR-CASE-1001"]) == 1


def test_execute_invalid_plan_is_honest_409():
    # CASE-1005 (roaming dispute) has no agent workflow: nothing to execute.
    r = client.post("/cases/CASE-1005/execute",
                    json={"state": _seed(), "idempotencyKey": _key()})
    assert r.status_code == 409
    assert "error" in r.json()["detail"] or "detail" in r.json()


def test_execute_unknown_case_is_404():
    r = client.post("/cases/CASE-9999/execute",
                    json={"state": _seed(), "idempotencyKey": _key()})
    assert r.status_code == 404


def test_execute_requires_idempotency_key():
    r = client.post("/cases/CASE-1001/execute", json={"state": _seed()})
    assert r.status_code == 422  # FastAPI validation, JSON error


def test_execute_plan_change_posts_credit_for_cheaper_target():
    # CASE-1008: Family Share $98 -> Premium $87.40 = $10.60 CREDIT.
    r = client.post("/cases/CASE-1008/execute",
                    json={"state": _seed(), "idempotencyKey": _key()})
    assert r.status_code == 200
    body = r.json()
    assert body["effectKind"] == "plan_change"
    assert body["creditApplied"] == 10.6
    updated = body["updatedState"]
    cust = next(c for c in updated["customers"] if c["id"] == "CUST-1008")
    assert cust["plan"] == "Unlimited Premium"
