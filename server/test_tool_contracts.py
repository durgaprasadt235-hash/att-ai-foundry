"""Pytest unit tests for the tool contracts (server/tool_contracts.py)
and the redaction helper (server/redact.py).
Run: python3 -m pytest server/test_tool_contracts.py server/test_redact.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from tool_contracts import (  # noqa: E402
    TOOL_CONTRACTS,
    contract_for_step,
    is_mutating_tool,
    missing_tool_inputs,
)


def test_every_tool_has_timeout_retry_rate_limit_and_idempotency():
    assert len(TOOL_CONTRACTS) >= 10
    for name, contract in TOOL_CONTRACTS.items():
        assert contract["timeoutMs"] > 0, name
        assert contract["retries"] in (0, 1), name
        assert "60 requests/min" in contract["rateLimit"], name
        assert contract["idempotency"], name
        assert contract["requiredInputs"], name


def test_only_execute_approved_mutates():
    mutating = [n for n, c in TOOL_CONTRACTS.items() if c["mutating"]]
    assert "execute_approved" in mutating
    assert "notify_customer" in mutating
    assert "validate_case" not in mutating
    assert "stair_retrieve" not in mutating
    assert is_mutating_tool("execute_approved") is True
    assert is_mutating_tool("get_customer_360") is False


def test_missing_inputs_detected():
    assert missing_tool_inputs("validate_case", {}) == [
        "caseId", "idempotencyKey"]
    assert missing_tool_inputs(
        "validate_case", {"caseId": "CASE-1",
                          "idempotencyKey": "case-1-v1"}) == []
    assert missing_tool_inputs("groq_chat", {"query": "x"}) == ["allowlist"]
    assert missing_tool_inputs("no_such_tool", {}) == ["Unknown tool no_such_tool"]


def test_groq_contract_timeout_matches_client():
    assert TOOL_CONTRACTS["groq_chat"]["timeoutMs"] == 20000
    assert TOOL_CONTRACTS["validate_case"]["retries"] == 0  # never retry validation


def test_contract_for_step_maps_engine_tools():
    assert contract_for_step("stair_retrieve")["tool"] == "stair_retrieve"
    assert contract_for_step("execute_approved")["mutating"] is True
    assert contract_for_step("unknown_tool_xyz") is None
