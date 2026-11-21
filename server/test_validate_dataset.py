"""Pytest tests for the bring-your-own-dataset validator
(server/validate_dataset.py).

The validator mirrors src/lib/dataset.ts rules D1-D12. The current seed
must pass; deliberately broken datasets must fail with the right errors;
CSV samples must behave the same as JSON.
Run: python3 -m pytest server/test_validate_dataset.py -v
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from validate_dataset import (  # noqa: E402
    find_duplicate_pairs,
    validate_dataset,
    validate_dataset_csv_files,
)

SEED = Path(__file__).parent / "seed.json"


def _load_seed():
    return json.loads(SEED.read_text())


def test_seed_passes_with_expected_warnings():
    data = _load_seed()
    v, tables = validate_dataset(data)
    assert v["valid"] is True, v["errors"]
    assert tables is not None
    assert v["counts"] == {"customers": 20, "ledger": 66, "usage": 20,
                           "tickets": 12, "cases": 12, "docs": 8,
                           "orders": 0, "stairTrees": 3}
    assert v["errors"] == []
    # The seed is honest test content: 3 duplicate charges (D9) and 2
    # suspended-with-balance customers (D11) are warnings, not errors.
    assert len(v["duplicatesFound"]) == 3
    assert any("CUST-1001" in d for d in v["duplicatesFound"])
    assert v["balanceMismatches"] == []
    assert v["unmatchedCases"] == []


def test_duplicate_id_rejected():
    data = _load_seed()
    data["customers"].append(copy.deepcopy(data["customers"][0]))
    v, tables = validate_dataset(data)
    assert v["valid"] is False
    assert tables is None
    assert any("D3" in e and "CUST-1001" in e for e in v["errors"])


def test_unknown_customer_reference_rejected():
    data = _load_seed()
    bad = copy.deepcopy(data["ledger"][0])
    bad["id"] = "LED-UNKNOWN"
    bad["customerId"] = "CUST-9999"
    data["ledger"].append(bad)
    v, _ = validate_dataset(data)
    assert v["valid"] is False
    assert any("D6" in e and "CUST-9999" in e for e in v["errors"])


def test_balance_mismatch_listed_not_fixed():
    data = _load_seed()
    data["customers"][0]["balance"] = 999.99
    v, tables = validate_dataset(data)
    assert v["valid"] is False
    assert tables is None
    assert len(v["balanceMismatches"]) == 1
    assert v["balanceMismatches"][0]["customerId"] == "CUST-1001"
    assert v["balanceMismatches"][0]["stated"] == 999.99
    assert v["balanceMismatches"][0]["computed"] == 194.32
    assert any("D7" in e and "CUST-1001" in e for e in v["errors"])
    # The validator never rewrites the balance to make it pass.
    assert data["customers"][0]["balance"] == 999.99


def _add_payment_and_credit(data):
    """Add a positive-amount payment ($20) and credit ($10) for
    CUST-1001. Amounts are magnitudes; kind decides the sign, so the
    signed ledger sum for CUST-1001 drops by $30.00 (194.32 -> 164.32)."""
    data["ledger"].append({
        "id": "LED-TEST-PAY", "customerId": "CUST-1001",
        "invoice": "INV-TEST-PAY", "date": "2026-11-13",
        "service": "Account payment", "amount": 20.00,
        "kind": "payment", "status": "posted"})
    data["ledger"].append({
        "id": "LED-TEST-CR", "customerId": "CUST-1001",
        "invoice": "INV-TEST-CR", "date": "2026-11-13",
        "service": "Goodwill credit", "amount": 10.00,
        "kind": "credit", "status": "posted"})


def test_positive_payment_and_credit_pass_d7():
    # The old validator summed amounts raw and rejected any file where a
    # payment or credit was stored as a positive amount (373 false D7
    # errors on a real 1,000-customer file). Kind-based signs must pass.
    data = _load_seed()
    _add_payment_and_credit(data)
    data["customers"][0]["balance"] = 164.32
    v, tables = validate_dataset(data)
    assert v["valid"] is True, v["errors"]
    assert tables is not None
    assert v["balanceMismatches"] == []


def test_genuinely_wrong_balance_still_fails_d7_with_payment_present():
    data = _load_seed()
    _add_payment_and_credit(data)
    # Balance NOT adjusted: stated 194.32, signed ledger sums to 164.32.
    v, tables = validate_dataset(data)
    assert v["valid"] is False
    assert tables is None
    assert len(v["balanceMismatches"]) == 1
    assert v["balanceMismatches"][0]["customerId"] == "CUST-1001"
    assert v["balanceMismatches"][0]["stated"] == 194.32
    assert v["balanceMismatches"][0]["computed"] == 164.32
    assert any("D7" in e and "CUST-1001" in e for e in v["errors"])


def test_verbatim_test_data_file_passes():
    # The user's original ChatGPT file (repo root test-data.json) stores
    # amounts as positive magnitudes with a kind field. It must pass.
    verbatim = Path(__file__).parent.parent / "test-data.json"
    data = json.loads(verbatim.read_text())
    v, tables = validate_dataset(data)
    assert v["valid"] is True, v["errors"]
    assert tables is not None
    assert v["balanceMismatches"] == []


def test_case_amount_with_no_ledger_entry_is_a_warning():
    data = _load_seed()
    data["cases"][0]["amount"] = 1234.56
    v, tables = validate_dataset(data)
    # A warning, not an error: the case may still run and fail honestly.
    assert v["valid"] is True
    assert tables is not None
    assert "CASE-1001" in v["unmatchedCases"]
    assert any("D8" in w and "CASE-1001" in w for w in v["warnings"])


def test_missing_required_table_rejected():
    data = _load_seed()
    del data["cases"]
    v, _ = validate_dataset(data)
    assert v["valid"] is False
    assert any("D1" in e and "cases" in e for e in v["errors"])


def test_empty_dataset_rejected():
    v, _ = validate_dataset({"customers": [], "ledger": [],
                             "usage": [], "cases": []})
    assert v["valid"] is False
    assert any("D2" in e for e in v["errors"])


def test_non_object_rejected():
    v, _ = validate_dataset([1, 2, 3])
    assert v["valid"] is False
    assert any("D1" in e for e in v["errors"])


def test_missing_idempotency_key_is_filled_and_listed():
    data = _load_seed()
    del data["cases"][0]["idempotencyKey"]
    v, tables = validate_dataset(data)
    assert v["valid"] is True
    assert tables["cases"][0]["idempotencyKey"] == "case-1001-v1"
    assert any("idempotencyKey" in f for f in v["filled"])


def test_duplicate_pair_rule_matches_engine():
    data = _load_seed()
    pairs = find_duplicate_pairs(data["ledger"])
    assert len(pairs) == 3
    assert pairs[0]["customerId"] == "CUST-1001"
    assert pairs[0]["original"]["invoice"] == "INV-2039"
    assert pairs[0]["duplicate"]["invoice"] == "INV-2041"


def test_csv_sample_passes(tmp_path):
    d = tmp_path
    (d / "customers.csv").write_text(
        "id,name,account,phone,email,plan,status,since,balance,city\n"
        "CUST-2001,Sample One,ACC-900001,(555) 010-0001,one@example.com,"
        "Unlimited Premium,active,2023-01-15,190.80,Sample City\n"
        "CUST-2002,Sample Two,ACC-900002,(555) 010-0002,two@example.com,"
        "Unlimited Starter,active,2024-03-20,65.00,Sample Town\n")
    (d / "ledger.csv").write_text(
        "id,customerId,invoice,date,service,amount,kind,status\n"
        "LED-2001,CUST-2001,INV-9001,2026-11-08,"
        "Unlimited Premium — monthly plan,87.40,charge,posted\n"
        "LED-2002,CUST-2001,INV-9002,2026-11-09,Device installment,16.00,"
        "charge,posted\n"
        "LED-2003,CUST-2001,INV-9003,2026-11-14,"
        "Unlimited Premium — monthly plan,87.40,charge,posted\n"
        "LED-2004,CUST-2002,INV-9010,2026-11-08,"
        "Unlimited Starter — monthly plan,65.00,charge,posted\n")
    (d / "usage.csv").write_text(
        "id,customerId,month,dataGb,minutes,sms\n"
        "USE-2001,CUST-2001,2026-11,12.5,320,45\n"
        "USE-2002,CUST-2002,2026-11,6.1,180,22\n")
    (d / "cases.csv").write_text(
        "id,customerId,type,title,description,amount,status,createdAt,"
        "idempotencyKey\n"
        "CASE-2001,CUST-2001,duplicate_charge,Double charge,"
        "INV-9001 and INV-9003 both billed $87.40,87.40,open,"
        "2026-11-15T09:00:00Z,case-2001-v1\n")
    files = {p.name: p.read_text() for p in d.glob("*.csv")}
    v, tables = validate_dataset_csv_files(files)
    assert v["valid"] is True, v["errors"]
    assert v["counts"]["customers"] == 2
    assert v["counts"]["ledger"] == 4
    assert len(v["duplicatesFound"]) == 1


def test_csv_missing_header_column_rejected(tmp_path):
    d = tmp_path
    (d / "customers.csv").write_text("id,name\nCUST-1,Nope\n")
    (d / "ledger.csv").write_text("id,customerId,invoice,date,service,"
                                  "amount,kind,status\n")
    (d / "usage.csv").write_text("id,customerId,month,dataGb,minutes,sms\n")
    (d / "cases.csv").write_text(
        "id,customerId,type,title,description,amount,status,createdAt,"
        "idempotencyKey\n")
    files = {p.name: p.read_text() for p in d.glob("*.csv")}
    v, tables = validate_dataset_csv_files(files)
    assert v["valid"] is False
    assert tables is None
    assert any("customers.csv" in e and "missing header" in e
               for e in v["errors"])


def test_csv_unknown_file_rejected():
    v, _ = validate_dataset_csv_files({"random.csv": "a,b\n1,2\n"})
    assert v["valid"] is False
    assert any("unrecognised file" in e for e in v["errors"])
