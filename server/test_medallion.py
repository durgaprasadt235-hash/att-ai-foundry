"""Pytest tests for the Medallion architecture (server/medallion.py).

Bronze → Silver → Gold on the real seeded state, plus the failure-card /
Copilot-prompt contract and incremental (watermark) batches.
Run: python3 -m pytest server/test_medallion.py -v
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from medallion import (  # noqa: E402
    build_failure_card,
    build_medallion,
    lineage_for_record,
    run_incremental_batch,
    spark_job_reference,
)


def load_seed():
    return json.loads((Path(__file__).parent / "seed.json").read_text())


def test_bronze_silver_gold_reconcile_on_real_seed():
    snap = build_medallion(load_seed(), "B-2026-11-21")
    assert snap["bronzeTotal"] == 106  # 20 customers + 66 ledger + 20 usage
    assert snap["bronzeBySource"] == {"customers": 20, "ledger": 66, "usage": 20}
    assert snap["silverPassed"] == 101
    assert snap["silverQuarantined"] == 5
    # The invariant: nothing is silently dropped.
    assert snap["bronzeTotal"] == snap["silverPassed"] + snap["silverQuarantined"]


def test_gold_aggregates_match_reconciled_ledger():
    seed = load_seed()
    snap = build_medallion(seed, "B-2026-11-21")
    assert snap["gold"]["customers360"] == 20
    assert snap["gold"]["ledgerReconciled"] == 63  # 66 ledger - 3 duplicates
    assert snap["gold"]["ledgerReconciledTotal"] == 2318.95
    # Gold total equals the raw ledger total minus the quarantined duplicates.
    raw_total = round(sum(e["amount"] for e in seed["ledger"]), 2)
    dup_total = round(sum(e["amount"] for e in seed["ledger"]
                          if e["invoice"] in ("INV-2041", "INV-2042", "INV-2043")), 2)
    assert raw_total - dup_total == snap["gold"]["ledgerReconciledTotal"]
    assert snap["gold"]["usageRollup"] == 20
    assert snap["gold"]["usageTotalGb"] == 275.85
    assert snap["gold"]["usageTotalMinutes"] == 7281
    assert snap["gold"]["usageTotalSms"] == 1638


def test_quarantine_lists_every_bad_record():
    snap = build_medallion(load_seed(), "B-2026-11-21")
    by_id = {q["recordId"]: q for q in snap["quarantine"]}
    assert set(by_id) == {"CUST-1004", "CUST-1011", "LED-61", "LED-62", "LED-63"}
    assert by_id["CUST-1004"]["pipelineId"] == "PIPE-01"
    assert by_id["LED-61"]["pipelineId"] == "PIPE-02"
    assert "INV-2039 + INV-2041" in by_id["LED-61"]["reason"]
    # One failure card per quarantined record.
    assert len(snap["failureCards"]) == 5
    assert {c["recordId"] for c in snap["failureCards"]} == set(by_id)


def test_lineage_duplicate_invoice_is_quarantined_in_silver_excluded_from_gold():
    seed = load_seed()
    steps = lineage_for_record(seed, "INV-2041", "B-2026-11-21")
    assert [s["layer"] for s in steps] == ["Bronze", "Silver", "Gold"]
    assert steps[0]["status"] == "passed"  # Bronze keeps the raw record
    assert steps[1]["status"] == "quarantined"
    assert "INV-2039" in steps[1]["detail"]
    assert steps[2]["status"] == "excluded"
    assert "$87.40" in steps[2]["detail"]  # the credit, not the duplicate, reaches Gold


def test_lineage_clean_invoice_passes_silver_and_reaches_gold():
    seed = load_seed()
    steps = lineage_for_record(seed, "INV-2039", "B-2026-11-21")
    assert [s["status"] for s in steps] == ["passed", "passed", "included"]
    assert "63 entries" in steps[2]["detail"]


def test_failure_card_copilot_prompt_names_file_function_error_and_record():
    card = build_failure_card(
        "PIPE-02", "Quarantined ledger LED-61: duplicate charge",
        "LED-61", "B-2026-11-21", "Duplicate charge: INV-2039 + INV-2041 ($87.40)")
    assert "server/engine.py" in card["copilotPrompt"]
    assert "validate_pipeline" in card["copilotPrompt"]
    assert "LED-61" in card["copilotPrompt"]
    assert "B-2026-11-21" in card["copilotPrompt"]
    assert "Duplicate charge: INV-2039 + INV-2041 ($87.40)" in card["copilotPrompt"]
    assert card["fixFile"] == "server/engine.py"
    assert "PIPE-02" in card["fixFunction"]


def test_incremental_batch_watermark_skips_everything_on_second_run():
    seed = load_seed()
    watermark = set()
    first = run_incremental_batch(seed, "B-2026-11-21", watermark)
    assert first["newRecords"] == 106
    assert first["skippedRecords"] == 0
    assert first["retries"] == 0
    assert first["snapshot"]["bronzeTotal"] == 106
    second = run_incremental_batch(seed, "B-2026-11-21", watermark)
    assert second["newRecords"] == 0
    assert second["skippedRecords"] == 106
    # Same snapshot — the watermark changes what is re-validated, not the data.
    assert second["snapshot"] == first["snapshot"]


def test_incremental_batch_processes_only_new_records():
    seed = load_seed()
    watermark = {c["id"] for c in seed["customers"]}  # customers already done
    run = run_incremental_batch(seed, "B-2026-11-21", watermark)
    assert run["newRecords"] == 86  # 66 ledger + 20 usage
    assert run["skippedRecords"] == 20


def test_spark_job_reference_is_a_shape_not_an_execution():
    job = spark_job_reference()
    assert job["job"] == "att-ai-foundry-medallion"
    assert set(job) >= {"bronze", "silver", "gold", "ops"}
    assert job["bronze"]["partition"] == ["ingest_date", "source"]
    assert job["silver"]["partition"] == ["ingest_date", "customer_id"]
    assert "quarantine" in str(job["silver"]["rules"]).lower()
    assert job["ops"]["operator"] == "one person + GitHub Copilot"


def test_incremental_batch_is_bounded_and_defers_the_rest():
    """Backpressure: a batch processes at most `limit` new records; the
    rest are deferred (never dropped) to the next batch."""
    seed = load_seed()
    watermark: set = set()
    first = run_incremental_batch(seed, "B-2026-11-21", watermark, limit=2)
    assert first["newRecords"] == 2
    assert first["deferredRecords"] == 104
    assert len(watermark) == 2
    second = run_incremental_batch(seed, "B-2026-11-21", watermark, limit=2)
    assert second["newRecords"] == 2
    assert second["deferredRecords"] == 102
    assert second["skippedRecords"] == 2


def test_incremental_batch_default_limit_covers_the_seed():
    seed = load_seed()
    run = run_incremental_batch(seed, "B-2026-11-21", set())
    assert run["newRecords"] == 106
    assert run["deferredRecords"] == 0
