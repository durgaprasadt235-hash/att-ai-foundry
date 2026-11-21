"""Pytest tests for the raw-upload auto-cleanse (server/cleanse.py).

The cleanser mirrors src/lib/cleanse.ts rules CL1–CL8. A dirty file
must come out production-ready: balances corrected and listed,
unfixable records quarantined and listed, and the cleansed output
must pass the validator with 0 errors. The raw input is never
modified.
Run: python3 -m pytest server/test_cleanse.py -v
"""
from __future__ import annotations

import copy
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from cleanse import cleanse_dataset  # noqa: E402
from validate_dataset import validate_dataset  # noqa: E402

SEED = Path(__file__).parent / "seed.json"
REPO_TEST_DATA = Path(__file__).parent.parent / "test-data.json"


def _load_seed():
    return json.loads(SEED.read_text())


def _dirty():
    """The seed plus one of each cleansable problem: a wrong balance
    (D7), a duplicate id (D3), a record missing a required field (D4),
    a ledger entry and a case referencing an unknown customer (D6),
    a usage row missing its month (D4), and a ledger entry with an
    unknown kind (D5)."""
    data = _load_seed()
    # D7 — CUST-1001 balance is wrong (ledger reconciles to 194.32).
    data["customers"][0]["balance"] = 999.99
    # D3 — duplicate customer id (a second CUST-1002 row).
    data["customers"].append(copy.deepcopy(data["customers"][1]))
    # D4 — a customer with no name.
    data["customers"].append({
        "id": "CUST-9001", "name": "", "account": "ACC-999001",
        "phone": "(555) 010-9001", "email": "noname@example.com",
        "plan": "Unlimited Starter", "status": "active",
        "since": "2024-01-01", "balance": 10.0, "city": "Nowhere, NJ"})
    # D6 — ledger entry for a customer that does not exist.
    bad_ledger = copy.deepcopy(data["ledger"][0])
    bad_ledger["id"] = "LED-UNKNOWN"
    bad_ledger["customerId"] = "CUST-9999"
    data["ledger"].append(bad_ledger)
    # D5 — ledger entry with an unknown kind.
    bad_kind = copy.deepcopy(data["ledger"][1])
    bad_kind["id"] = "LED-BADKIND"
    bad_kind["kind"] = "refund"
    data["ledger"].append(bad_kind)
    # D6 — case for a customer that does not exist.
    bad_case = copy.deepcopy(data["cases"][0])
    bad_case["id"] = "CASE-UNKNOWN"
    bad_case["customerId"] = "CUST-9999"
    data["cases"].append(bad_case)
    # D4 — usage row with no month.
    bad_usage = copy.deepcopy(data["usage"][0])
    bad_usage["id"] = "USE-NOMONTH"
    bad_usage["month"] = ""
    data["usage"].append(bad_usage)
    return data


def test_dirty_file_cleanses_to_valid():
    raw = _dirty()
    cleansed, report = cleanse_dataset(copy.deepcopy(raw))
    assert report["can_cleanse"] is True, report["blocked_reason"]
    assert cleansed is not None
    v, _ = validate_dataset(cleansed)
    assert v["valid"] is True, v["errors"]
    assert v["errors"] == []
    # The cleansed output itself is the production-ready file: it
    # round-trips through the validator with 0 errors.
    v2, _ = validate_dataset(json.loads(json.dumps(cleansed)))
    assert v2["valid"] is True and v2["errors"] == []


def test_wrong_balance_corrected_and_listed():
    _, report = cleanse_dataset(_dirty())
    corr = [c for c in report["corrected"]
            if c["id"] == "CUST-1001" and c["field"] == "balance"]
    assert len(corr) == 1
    assert corr[0]["old_value"] == "$999.99"
    assert corr[0]["new_value"] == "$194.32"
    assert corr[0]["rule"] == "CL4"


def test_unfixable_records_quarantined_and_listed():
    _, report = cleanse_dataset(_dirty())
    q = {(x["table"], x["id"]): x for x in report["quarantined"]}
    assert ("customers", "CUST-1002") in q  # CL1 duplicate id
    assert q[("customers", "CUST-1002")]["rule"] == "CL1"
    assert ("customers", "CUST-9001") in q  # CL2 missing name
    assert q[("customers", "CUST-9001")]["rule"] == "CL2"
    assert ("ledger", "LED-UNKNOWN") in q  # CL3 unknown customer
    assert q[("ledger", "LED-UNKNOWN")]["rule"] == "CL3"
    assert ("ledger", "LED-BADKIND") in q  # CL2 unknown kind
    assert ("cases", "CASE-UNKNOWN") in q  # CL3 unknown customer
    assert ("usage", "USE-NOMONTH") in q  # CL2 missing month
    # Counts: 22 source customers (20 + duplicate + nameless) → 20 kept.
    assert report["source_counts"]["customers"] == 22
    assert report["cleansed_counts"]["customers"] == 20
    assert report["source_counts"]["ledger"] == 68
    assert report["cleansed_counts"]["ledger"] == 66
    assert report["cleansed_counts"]["cases"] == 12
    assert report["cleansed_counts"]["usage"] == 20


def test_raw_input_never_modified():
    raw = _dirty()
    before = copy.deepcopy(raw)
    cleanse_dataset(raw)
    assert raw == before
    assert raw["customers"][0]["balance"] == 999.99


def test_already_clean_file_passes_through_unchanged():
    data = _load_seed()
    cleansed, report = cleanse_dataset(copy.deepcopy(data))
    assert report["can_cleanse"] is True
    assert report["corrected"] == []
    assert report["quarantined"] == []
    assert cleansed["customers"] == data["customers"]
    assert cleansed["ledger"] == data["ledger"]


def test_repo_test_data_cleanses_with_no_corrections():
    data = json.loads(REPO_TEST_DATA.read_text())
    cleansed, report = cleanse_dataset(copy.deepcopy(data))
    assert report["can_cleanse"] is True, report["blocked_reason"]
    assert report["corrected"] == []
    assert report["quarantined"] == []
    v, _ = validate_dataset(cleansed)
    assert v["valid"] is True and v["errors"] == []


def test_structurally_broken_file_cannot_be_cleansed():
    cleansed, report = cleanse_dataset({"customers": "not-an-array"})
    assert cleansed is None
    assert report["can_cleanse"] is False
    assert report["blocked_reason"] is not None
    assert "D1" in report["blocked_reason"]


def test_no_valid_customers_left_cannot_be_cleansed():
    data = _load_seed()
    for c in data["customers"]:
        c["name"] = ""  # every customer fails CL2
    cleansed, report = cleanse_dataset(data)
    assert cleansed is None
    assert report["can_cleanse"] is False
    assert "D2" in report["blocked_reason"]


def test_cli_writes_production_ready_file(tmp_path):
    dirty_path = tmp_path / "dirty.json"
    dirty_path.write_text(json.dumps(_dirty()))
    out_path = tmp_path / "dirty.cleansed.json"
    proc = subprocess.run(
        [sys.executable, "server/cleanse.py", str(dirty_path),
         str(out_path)],
        cwd=str(Path(__file__).parent.parent),
        capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert out_path.is_file()
    assert "CLEANSED" in proc.stdout
    assert "CUST-1001" in proc.stdout  # the CL4 correction is printed
    cleansed = json.loads(out_path.read_text())
    v, _ = validate_dataset(cleansed)
    assert v["valid"] is True and v["errors"] == []
    assert cleansed["customers"][0]["balance"] == 194.32
