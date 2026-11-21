"""Event feed — mirrors src/lib/events.ts.

Every state change emits a structured event to an append-only in-memory
feed. The feed is the contract a real bus consumes: replace the append
in emit_event() with a publish to Kafka / SNS / EventBridge and
subscribers get the same event types, fields and ordering. Production
note: this feed is per-instance and in-memory. It proves the event
contract; it is NOT a durable bus.
"""
from __future__ import annotations

import time
import uuid

from observability import json_log
from redact import redact_pii

EVENT_TYPES = (
    "case_created", "customer_created",
    "credit_proposed", "credit_approved", "credit_executed",
    "plan_proposed", "plan_approved", "plan_executed",
    "pipeline_run", "pipeline_failed",
    "run_failed", "eval_run",
    "release_approved", "release_blocked",
)

_FEED: list[dict] = []
_MAX_EVENTS = 500


def emit_event(event_type: str, actor: str, detail: str,
               run_id: str | None = None,
               trace_id: str | None = None) -> dict:
    """Append a structured event (redacted) and log it as JSON."""
    if event_type not in EVENT_TYPES:
        raise ValueError(f"Unknown event type {event_type!r}")
    event = {
        "id": f"EVT-{uuid.uuid4().hex[:8]}",
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "type": event_type,
        "actor": actor,
        "detail": redact_pii(detail),
        **({"runId": run_id} if run_id else {}),
        **({"traceId": trace_id} if trace_id else {}),
    }
    _FEED.append(event)
    if len(_FEED) > _MAX_EVENTS:
        del _FEED[: len(_FEED) - _MAX_EVENTS]
    json_log("event", event_type=event_type, run_id=run_id,
             trace_id=trace_id)
    return event


def list_events(limit: int = 50) -> list[dict]:
    return list(reversed(_FEED[-limit:]))


def clear_events() -> None:
    _FEED.clear()
