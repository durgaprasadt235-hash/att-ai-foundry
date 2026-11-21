"""Pytest unit tests for the event feed (server/events.py) and the
structured observability helpers (server/observability.py).
Run: python3 -m pytest server/test_events.py server/test_observability.py -v
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest  # noqa: E402

sys.path.insert(0, str(Path(__file__).parent))

from events import clear_events, emit_event, list_events  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_feed():
    clear_events()
    yield
    clear_events()


def test_emit_and_list_events_newest_first():
    first = emit_event("case_created", "human", "Created case CASE-9001.")
    second = emit_event("credit_proposed", "agent",
                        "Proposed credit $87.40 for CASE-9001.",
                        run_id="RUN-abc", trace_id="TRC-xyz")
    events = list_events()
    assert events[0]["id"] == second["id"]
    assert events[1]["id"] == first["id"]
    assert events[0]["runId"] == "RUN-abc"
    assert events[0]["traceId"] == "TRC-xyz"
    assert events[0]["type"] == "credit_proposed"


def test_event_payloads_are_redacted():
    event = emit_event("case_created", "human",
                       "Call (201) 555-0142 or maya.rodriguez.demo@example.com")
    assert "(201) 555-0142" not in event["detail"]
    assert "maya.rodriguez.demo@example.com" not in event["detail"]
    assert "(***) ***-0142" in event["detail"]


def test_unknown_event_type_is_rejected():
    with pytest.raises(ValueError, match="Unknown event type"):
        emit_event("teleported", "agent", "not a real event")


def test_feed_is_append_only_and_capped():
    for i in range(5):
        emit_event("eval_run", "system", f"Eval run {i}.")
    assert len(list_events(limit=3)) == 3
    assert len(list_events()) == 5
