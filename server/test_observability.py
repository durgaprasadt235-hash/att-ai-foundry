"""Pytest unit tests for structured observability (server/observability.py).
Run: python3 -m pytest server/test_observability.py -v
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from observability import build_metrics, json_log, new_trace_id  # noqa: E402


def _seed() -> dict:
    return json.loads((Path(__file__).parent / "seed.json").read_text())


def test_trace_ids_are_unique_and_prefixed():
    ids = {new_trace_id() for _ in range(100)}
    assert len(ids) == 100
    assert all(i.startswith("TRC-") for i in ids)


def test_json_log_emits_one_parseable_json_line(capsys):
    json_log("plan_completed", run_id="RUN-abc", trace_id="TRC-xyz",
             duration_ms=42, status="awaiting_approval")
    line = capsys.readouterr().out.strip()
    record = json.loads(line)
    assert record["event"] == "plan_completed"
    assert record["run_id"] == "RUN-abc"
    assert record["trace_id"] == "TRC-xyz"
    assert record["duration_ms"] == 42
    assert "ts" in record


def test_build_metrics_counts_come_from_live_state():
    metrics = build_metrics(_seed(), {"plans": 3, "executes": 1})
    assert metrics["records"]["customers"] == 20
    assert metrics["records"]["ledger"] == 66
    assert metrics["records"]["usage"] == 20
    assert metrics["records"]["cases"] == 12
    # Medallion layer counts: bronze = silver passed + quarantined.
    med = metrics["medallion"]
    assert med["bronze"] == 106
    assert med["silverPassed"] + med["silverQuarantined"] == 106
    assert med["goldLedger"] == 63
    assert metrics["counters"] == {"plans": 3, "executes": 1}
