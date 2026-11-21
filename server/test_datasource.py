"""Pytest unit tests for the data-source switch (server/datasource.py).

Seed mode loads the synthetic seed. `att` mode maps AT&T payloads onto
the existing record types — and FAILS HONESTLY on any failure: it never
silently falls back to seed data. The HTTP calls are mocked; no real
AT&T API exists in this repo.
Run: python3 -m pytest server/test_datasource.py -v
"""
from __future__ import annotations

import io
import json
import sys
import urllib.error
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent))

import pytest  # noqa: E402

from config import load_config  # noqa: E402
from datasource import (  # noqa: E402
    AttDatasource,
    DatasourceError,
    SeedDatasource,
    datasource_from_config,
    load_state,
    map_att_case,
    map_att_customer,
    map_att_doc,
    map_att_ledger_entry,
    map_att_usage,
)


def _mock_response(payload) -> MagicMock:
    resp = MagicMock()
    resp.read.return_value = json.dumps(payload).encode()
    resp.__enter__.return_value = resp
    resp.__exit__.return_value = False
    return resp


def _seed() -> dict:
    return json.loads((Path(__file__).parent / "seed.json").read_text())


def test_seed_mode_loads_synthetic_counts():
    state = SeedDatasource().load_state()
    assert len(state["customers"]) == 20
    assert len(state["ledger"]) == 66
    assert len(state["usage"]) == 20
    assert len(state["cases"]) == 12


def test_load_state_defaults_to_seed():
    state = load_state(load_config({}))
    assert len(state["customers"]) == 20


def test_map_customer_accepts_camel_and_snake_case():
    camel = map_att_customer({"id": "CUST-1", "name": "Test Person",
                              "account": "ACC-1", "phone": "555",
                              "plan": "Unlimited Premium", "status": "active",
                              "balance": 10.5, "city": "Dallas, TX"})
    assert camel["id"] == "CUST-1" and camel["balance"] == 10.5
    snake = map_att_customer({"customer_id": "CUST-2", "full_name": "Two",
                              "account_number": "ACC-2",
                              "outstanding_balance": 0})
    assert snake["id"] == "CUST-2" and snake["name"] == "Two"


def test_map_customer_missing_id_fails_loudly():
    with pytest.raises(DatasourceError, match="missing required field"):
        map_att_customer({"name": "No Id"})


def test_map_ledger_and_usage_and_case_and_doc():
    entry = map_att_ledger_entry({"id": "LED-1", "customer_id": "CUST-1",
                                  "invoice": "INV-1", "amount": 87.40,
                                  "kind": "charge", "status": "posted"})
    assert entry["amount"] == 87.40 and entry["customerId"] == "CUST-1"
    usage = map_att_usage({"id": "USE-1", "customer_id": "CUST-1",
                           "month": "2026-11", "data_gb": 12.5,
                           "minutes": 300, "sms": 40})
    assert usage["dataGb"] == 12.5
    case = map_att_case({"id": "CASE-1", "customer_id": "CUST-1",
                         "type": "duplicate_charge", "amount": 87.40})
    assert case["idempotencyKey"] == "case-1-v1"
    doc = map_att_doc({"id": "POL-1", "title": "Billing Policy",
                       "body": "Credits are ..."})
    assert doc["title"] == "Billing Policy"
    with pytest.raises(DatasourceError):
        map_att_ledger_entry({"id": "LED-2", "customerId": "CUST-1"})


def test_att_mode_requires_config():
    with pytest.raises(DatasourceError, match="ATT_API_BASE_URL"):
        AttDatasource("", "key")
    with pytest.raises(DatasourceError, match="ATT_API_KEY"):
        AttDatasource("https://api.example.invalid", "")
    with pytest.raises(DatasourceError):
        datasource_from_config(load_config({"DATASOURCE": "att"}))


def _att_payloads() -> dict[str, list]:
    seed = _seed()
    return {
        "/customers": seed["customers"],
        "/ledger": seed["ledger"],
        "/usage": seed["usage"],
        "/cases": seed["cases"],
        "/docs": seed["docs"],
    }


def test_att_load_maps_seed_payloads():
    payloads = _att_payloads()

    def fake_urlopen(request, timeout=None):
        path = request.full_url.replace("https://api.example.invalid", "")
        return _mock_response(payloads[path])

    ds = AttDatasource("https://api.example.invalid", "att-key")
    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        state = ds.load_state()
    assert len(state["customers"]) == 20
    assert len(state["ledger"]) == 66
    assert state["customers"][0]["id"] == "CUST-1001"


def test_att_unreachable_fails_honestly_never_seed():
    ds = AttDatasource("https://api.example.invalid", "att-key")
    with patch("urllib.request.urlopen",
               side_effect=urllib.error.URLError("no route to host")):
        with pytest.raises(DatasourceError, match="unreachable"):
            ds.load_state()


def test_att_retries_once_on_500_then_succeeds():
    calls = {"n": 0}
    payloads = _att_payloads()

    def fake_urlopen(request, timeout=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.HTTPError(
                request.full_url, 500, "Server Error", {},
                io.BytesIO(b"boom"))
        path = request.full_url.replace("https://api.example.invalid", "")
        return _mock_response(payloads[path])

    ds = AttDatasource("https://api.example.invalid", "att-key")
    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        state = ds.load_state()
    assert len(state["customers"]) == 20
    assert calls["n"] >= 2  # at least one retry happened


def test_att_401_is_not_retried():
    calls = {"n": 0}

    def fake_urlopen(request, timeout=None):
        calls["n"] += 1
        raise urllib.error.HTTPError(
            request.full_url, 401, "Unauthorized", {},
            io.BytesIO(b"bad key"))

    ds = AttDatasource("https://api.example.invalid", "att-key")
    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        with pytest.raises(DatasourceError, match="HTTP 401"):
            ds.load_state()
    assert calls["n"] == 1  # 4xx is a real client error — no retry


def test_att_non_array_response_fails():
    ds = AttDatasource("https://api.example.invalid", "att-key")
    with patch("urllib.request.urlopen",
               return_value=_mock_response({"not": "a list"})):
        with pytest.raises(DatasourceError, match="did not return a JSON array"):
            ds.load_state()


def test_att_probe_reports_unreachable_honestly():
    ds = AttDatasource("https://api.example.invalid", "att-key")
    with patch("urllib.request.urlopen",
               side_effect=urllib.error.URLError("down")):
        probe = ds.probe()
    assert probe["reachable"] is False
    assert probe["error"]
