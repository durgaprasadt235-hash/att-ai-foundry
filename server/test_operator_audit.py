"""Staff accountability: every audit entry and event carries the
operator's login id (operatorId) — backend only, never rendered on a
screen. Demo mode uses the single labelled id "demo-operator"."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import _audit_entry  # noqa: E402
from events import clear_events, emit_event  # noqa: E402


def test_audit_entry_carries_operator_id():
    entry = _audit_entry("approved", "Credit posted.", "RUN-1", "TRC-1", 120, actor="human")
    assert entry["operatorId"] == "demo-operator"
    assert entry["actor"] == "human"


def test_two_operator_ids_produce_distinguishable_entries():
    a = _audit_entry("customer_viewed", "Opened CUST-1001.", "RUN-1", "TRC-1", 5,
                     actor="human", operator_id="op-alice")
    b = _audit_entry("customer_viewed", "Opened CUST-1001.", "RUN-1", "TRC-1", 5,
                     actor="human", operator_id="op-bob")
    assert a["operatorId"] == "op-alice"
    assert b["operatorId"] == "op-bob"
    assert a["operatorId"] != b["operatorId"]


def test_event_carries_operator_id():
    clear_events()
    event = emit_event("case_created", "human", "Created case CASE-9001.",
                       operator_id="op-alice")
    assert event["operatorId"] == "op-alice"


def test_event_defaults_to_demo_operator():
    clear_events()
    event = emit_event("case_created", "human", "Created case CASE-9001.")
    assert event["operatorId"] == "demo-operator"
