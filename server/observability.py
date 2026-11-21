"""Structured observability — mirrors the frontend's run/trace display.

* Structured JSON logging: every significant action logs one JSON line
  (timestamp, event, run id, trace id, duration) to stdout. A log
  aggregator can parse it without regexes; a human can read it too.
* Trace ids: one trace id per agent run, carried through the plan, the
  audit entry, the events, and the UI run view (distributed-tracing
  style: the same id links every hop of one run).
* Metrics: build_metrics() counts records per pipeline/layer (Bronze /
  Silver / Gold via the Medallion snapshot) plus in-memory endpoint
  counters, for GET /metrics.
"""
from __future__ import annotations

import json
import sys
import time
import uuid


def new_trace_id() -> str:
    return f"TRC-{uuid.uuid4().hex[:12]}"


def json_log(event: str, **fields) -> None:
    """One structured JSON log line. Never raises (logging must not break
    the request it describes)."""
    try:
        record = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                  "event": event, **fields}
        print(json.dumps(record), file=sys.stdout, flush=True)
    except Exception:
        pass


def build_metrics(state: dict, counters: dict) -> dict:
    """Counts per pipeline/layer + endpoint counters. All numbers come
    from the live state passed in — nothing is hardcoded."""
    from medallion import build_medallion, default_batch_id

    snapshot = build_medallion(state, default_batch_id(state))
    return {
        "records": {
            "customers": len(state.get("customers", [])),
            "ledger": len(state.get("ledger", [])),
            "usage": len(state.get("usage", [])),
            "cases": len(state.get("cases", [])),
            "docs": len(state.get("docs", [])),
        },
        "medallion": {
            "bronze": snapshot["bronzeTotal"],
            "silverPassed": snapshot["silverPassed"],
            "silverQuarantined": snapshot["silverQuarantined"],
            "goldLedger": snapshot["gold"]["ledgerReconciled"],
            "goldLedgerTotal": snapshot["gold"]["ledgerReconciledTotal"],
        },
        "counters": dict(counters),
    }
