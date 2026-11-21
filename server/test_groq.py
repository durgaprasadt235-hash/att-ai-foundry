"""Pytest unit tests for the live Groq integration (server/groq_client.py
and the live mode of server/engine.py).

No live Groq calls are made here: the Groq client is mocked or stubbed in
every test. The real key is exercised only in the manual live end-to-end
check (see README), never in the test suite.

Run: python3 -m pytest server/test_groq.py -v
"""
from __future__ import annotations

import io
import json
import sys
import urllib.error
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from engine import plan_run  # noqa: E402
from groq_client import GroqClient, GroqUnavailable, MODEL, USER_AGENT  # noqa: E402


def _load_seed() -> dict:
    return json.loads((Path(__file__).parent / "seed.json").read_text())


def _case_1001(state: dict) -> dict:
    return next(c for c in state["cases"] if c["id"] == "CASE-1001")


class FakeGroq:
    """Stub Groq client: picks the right leaf and drafts a fixed summary."""

    def __init__(self, pick: str = "BILL-CREDIT-DUP"):
        self.pick = pick

    def pick_leaf(self, query: str, leaves: list[dict]) -> str:
        if self.pick not in {leaf["id"] for leaf in leaves}:
            raise GroqUnavailable(f"Groq picked leaf id {self.pick!r}, which is not in the TOC allowlist")
        return self.pick

    def draft_summary(self, case: dict, citation: str, proposed_action: str) -> str:
        return "We found the duplicate charge and will credit it back to your account."


class FailingGroq:
    """Stub Groq client that always fails the way a real failure would."""

    def __init__(self, reason: str, status: int | None = None):
        self.reason = reason
        self.status = status

    def pick_leaf(self, query: str, leaves: list[dict]) -> str:
        raise GroqUnavailable(self.reason, status=self.status)

    def draft_summary(self, case: dict, citation: str, proposed_action: str) -> str:
        raise GroqUnavailable(self.reason, status=self.status)


# --- GroqClient unit tests (mocked transport) ------------------------------


def test_client_requires_key(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    with pytest.raises(GroqUnavailable, match="GROQ_API_KEY is not set"):
        GroqClient.from_env()


def test_pick_leaf_accepts_allowlisted_id(monkeypatch):
    client = GroqClient("test-key")
    monkeypatch.setattr(client, "chat",
                        lambda *a, **k: '{"leaf_id": "BILL-CREDIT-DUP"}')
    leaves = [{"id": "BILL-CREDIT-DUP", "path": "Billing Policy > Credits > Duplicate Charges", "section": "§4.2"},
              {"id": "SVC-NET-OUTAGE", "path": "Services > Network > Outage Triage", "section": "§3.1"}]
    assert client.pick_leaf("duplicate charge credit policy", leaves) == "BILL-CREDIT-DUP"


def test_pick_leaf_rejects_invented_id(monkeypatch):
    client = GroqClient("test-key")
    monkeypatch.setattr(client, "chat",
                        lambda *a, **k: '{"leaf_id": "BILL-CREDIT-FAKE"}')
    leaves = [{"id": "BILL-CREDIT-DUP", "path": "Billing Policy > Credits > Duplicate Charges", "section": "§4.2"}]
    with pytest.raises(GroqUnavailable, match="not in the TOC allowlist"):
        client.pick_leaf("duplicate charge credit policy", leaves)


def test_pick_leaf_rejects_no_pick(monkeypatch):
    client = GroqClient("test-key")
    monkeypatch.setattr(client, "chat", lambda *a, **k: '{"leaf_id": null}')
    with pytest.raises(GroqUnavailable, match="picked no leaf"):
        client.pick_leaf("duplicate charge credit policy",
                         [{"id": "BILL-CREDIT-DUP", "path": "Billing Policy > Credits > Duplicate Charges", "section": "§4.2"}])


def test_chat_maps_http_429_to_groq_unavailable(monkeypatch):
    client = GroqClient("test-key")
    error = urllib.error.HTTPError(
        "https://api.groq.com/openai/v1/chat/completions", 429,
        "Too Many Requests", {}, io.BytesIO(b'{"error": "rate limited"}'))

    class FakeOpener:
        def open(self, request, timeout=None):
            # The real User-Agent is REQUIRED: Cloudflare blocks the default.
            assert request.get_header("User-agent") == USER_AGENT
            assert request.get_header("Authorization") == "Bearer test-key"
            raise error

    monkeypatch.setattr("urllib.request.build_opener", lambda *a, **k: FakeOpener())
    with pytest.raises(GroqUnavailable) as exc:
        client.chat([{"role": "user", "content": "hi"}])
    assert exc.value.status == 429
    assert "429" in exc.value.reason


def test_chat_uses_gpt_oss_120b(monkeypatch):
    assert MODEL == "openai/gpt-oss-120b"
    client = GroqClient("test-key")
    assert client.model == "openai/gpt-oss-120b"


# --- Engine live-mode tests (stubbed Groq) ---------------------------------


def test_live_mode_success_case_1001():
    state = _load_seed()
    plan = plan_run(state, _case_1001(state), live_llm=True, groq_client=FakeGroq())
    assert plan.proposed_credit == 87.4
    assert plan.live_llm == "groq"
    assert plan.live_leaf_picks.get("duplicate charge credit policy") == "BILL-CREDIT-DUP"
    assert plan.live_summary == "We found the duplicate charge and will credit it back to your account."
    assert plan.citation is not None and "Duplicate Charges" in plan.citation
    assert any(s["id"] == "live-llm" and s["status"] == "done" for s in plan.steps)


def test_live_mode_invalid_leaf_pick_falls_back():
    state = _load_seed()
    plan = plan_run(state, _case_1001(state), live_llm=True,
                    groq_client=FakeGroq(pick="BILL-CREDIT-FAKE"))
    assert plan.proposed_credit == 87.4  # deterministic engine still resolves it
    assert plan.live_llm == "unavailable, deterministic fallback"
    assert plan.live_summary is None
    assert any(s["id"] == "live-llm" and "Deterministic fallback" in s["detail"]
               for s in plan.steps)


def test_live_mode_429_falls_back():
    state = _load_seed()
    plan = plan_run(state, _case_1001(state), live_llm=True,
                    groq_client=FailingGroq("Groq returned HTTP 429: rate limited", status=429))
    assert plan.proposed_credit == 87.4
    assert plan.live_llm == "unavailable, deterministic fallback"
    assert any(s["id"] == "live-llm" for s in plan.steps)


def test_live_mode_missing_key_falls_back(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    state = _load_seed()
    plan = plan_run(state, _case_1001(state), live_llm=True)
    assert plan.proposed_credit == 87.4
    assert plan.live_llm == "unavailable, deterministic fallback"
    assert any("GROQ_API_KEY is not set" in s["detail"] for s in plan.steps
               if s["id"] == "live-llm")


def test_deterministic_default_is_unchanged():
    state = _load_seed()
    plan = plan_run(state, _case_1001(state))
    assert plan.proposed_credit == 87.4
    assert plan.live_llm == "off"
    assert plan.live_summary is None
    assert not any(s["id"] == "live-llm" for s in plan.steps)
