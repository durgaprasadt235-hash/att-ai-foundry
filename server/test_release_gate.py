"""Pytest HTTP tests for the 85% release gate (POST /evals/release-gate).

The gate BLOCKS a release when the eval suite fails, naming the failed
checks. It is the server side of the UI's Release button.
Run: python3 -m pytest server/test_release_gate.py -v
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


def test_release_gate_approves_clean_seed():
    r = client.post("/evals/release-gate", json={"state": _seed()})
    assert r.status_code == 200
    body = r.json()
    assert body["released"] is True
    assert body["scorePct"] == 100
    assert body["gatePct"] == 85
    assert body["failures"] == []
    assert "approved" in body["reason"].lower()


def test_release_gate_blocks_broken_state_and_names_failures():
    # No cases and no ledger: duplicate detection (E1, E2) and the agent
    # plan (E8) all fail, so the suite drops below the 85% gate.
    state = _seed()
    state["cases"] = []
    state["ledger"] = []
    r = client.post("/evals/release-gate", json={"state": state})
    assert r.status_code == 200
    body = r.json()
    assert body["released"] is False
    assert body["scorePct"] < 85
    assert body["failures"], "a blocked release must name what failed"
    assert "BLOCKED" in body["reason"]
    assert any("Duplicate" in f for f in body["failures"])


def test_release_gate_blocks_missing_policy_doc():
    # Deleting POL-001 breaks RAG grounding (E5); removing the second
    # duplicate charge (LED-61 / INV-2041) breaks duplicate detection
    # (E1, E2) and the CASE-1001 plan (E8): 4/8 = 50% < 85% gate.
    state = _seed()
    state["docs"] = [d for d in state["docs"] if d["id"] != "POL-001"]
    state["ledger"] = [e for e in state["ledger"] if e["id"] != "LED-61"]
    r = client.post("/evals/release-gate", json={"state": state})
    assert r.status_code == 200
    body = r.json()
    assert body["released"] is False
    assert body["scorePct"] == 50
    assert any("RAG grounds" in f for f in body["failures"])
    assert any("Duplicate" in f for f in body["failures"])
