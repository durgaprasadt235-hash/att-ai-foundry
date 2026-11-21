"""Data-source switch — mirrors src/lib/datasource.ts.

Two modes, one interface:
  seed — the synthetic demo data in seed.json. Default.
  att  — live AT&T adapter: reads CRM / billing / usage payloads from
         ATT_API_BASE_URL with ATT_API_KEY (Bearer), and maps them onto
         the existing customer / ledger / usage shapes.

`att` mode FAILS HONESTLY: if the AT&T API is unreachable, returns an
error, or sends a record that cannot be mapped, load_state() raises
DatasourceError — it NEVER silently falls back to seed/fake data.
Mode is selected by the DATASOURCE env var (default `seed`) — see config.py.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path

from config import AppConfig, load_config

ATT_TIMEOUT_SECONDS = 10
ATT_MAX_ATTEMPTS = 2

ATT_ENDPOINTS = {
    "customers": "/customers",
    "ledger": "/ledger",
    "usage": "/usage",
    "cases": "/cases",
    "docs": "/docs",
}

_SEED_PATH = Path(__file__).with_name("seed.json")


class DatasourceError(Exception):
    """The configured data source could not be read. Callers surface this
    honestly; they never substitute seed data in `att` mode."""

    def __init__(self, reason: str, status: int | None = None):
        super().__init__(reason)
        self.reason = reason
        self.status = status


def _pick(raw: dict, *names: str):
    for name in names:
        if raw.get(name) is not None:
            return raw[name]
    return None


def _req_str(raw: dict, record_id: str, *names: str) -> str:
    value = _pick(raw, *names)
    if not isinstance(value, str) or value == "":
        raise DatasourceError(
            f"AT&T record {record_id} is missing required field {names[0]}")
    return value


def _req_num(raw: dict, record_id: str, *names: str) -> float:
    value = _pick(raw, *names)
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        raise DatasourceError(
            f"AT&T record {record_id} is missing required numeric field "
            f"{names[0]}") from None
    return number


def map_att_customer(raw: dict) -> dict:
    record_id = _req_str(raw, str(raw.get("id", "?")), "id", "customerId",
                         "customer_id")
    return {
        "id": record_id,
        "name": _req_str(raw, record_id, "name", "fullName", "full_name"),
        "account": str(_pick(raw, "account", "accountNumber",
                             "account_number") or ""),
        "phone": str(_pick(raw, "phone", "phoneNumber", "phone_number") or ""),
        "email": str(_pick(raw, "email") or ""),
        "plan": str(_pick(raw, "plan", "planName", "plan_name") or "Unknown"),
        "status": _pick(raw, "status") or "active",
        "since": str(_pick(raw, "since", "createdAt", "created_at") or ""),
        "balance": float(_pick(raw, "balance", "outstandingBalance",
                               "outstanding_balance") or 0),
        "city": str(_pick(raw, "city") or ""),
    }


def map_att_ledger_entry(raw: dict) -> dict:
    record_id = _req_str(raw, str(raw.get("id", "?")), "id", "entryId",
                         "entry_id")
    return {
        "id": record_id,
        "customerId": _req_str(raw, record_id, "customerId", "customer_id"),
        "invoice": str(_pick(raw, "invoice", "invoiceNumber",
                             "invoice_number") or ""),
        "date": str(_pick(raw, "date", "postedDate", "posted_date") or ""),
        "service": str(_pick(raw, "service", "description") or ""),
        "amount": _req_num(raw, record_id, "amount"),
        "kind": _pick(raw, "kind", "type") or "charge",
        "status": _pick(raw, "status") or "posted",
    }


def map_att_usage(raw: dict) -> dict:
    record_id = _req_str(raw, str(raw.get("id", "?")), "id", "usageId",
                         "usage_id")
    return {
        "id": record_id,
        "customerId": _req_str(raw, record_id, "customerId", "customer_id"),
        "month": str(_pick(raw, "month", "billingMonth", "billing_month") or ""),
        "dataGb": float(_pick(raw, "dataGb", "data_gb", "dataGB") or 0),
        "minutes": float(_pick(raw, "minutes") or 0),
        "sms": float(_pick(raw, "sms") or 0),
    }


def map_att_case(raw: dict) -> dict:
    record_id = _req_str(raw, str(raw.get("id", "?")), "id", "caseId",
                         "case_id")
    return {
        "id": record_id,
        "customerId": _req_str(raw, record_id, "customerId", "customer_id"),
        "type": _pick(raw, "type", "caseType", "case_type") or "other",
        "title": str(_pick(raw, "title", "subject") or ""),
        "description": str(_pick(raw, "description", "detail") or ""),
        "amount": float(_pick(raw, "amount") or 0),
        "status": _pick(raw, "status") or "open",
        "createdAt": str(_pick(raw, "createdAt", "created_at") or ""),
        "idempotencyKey": str(_pick(raw, "idempotencyKey", "idempotency_key")
                              or f"{record_id.lower()}-v1"),
    }


def map_att_doc(raw: dict) -> dict:
    record_id = _req_str(raw, str(raw.get("id", "?")), "id", "docId",
                         "doc_id")
    return {
        "id": record_id,
        "title": _req_str(raw, record_id, "title"),
        "body": _req_str(raw, record_id, "body", "text", "content"),
        "updated": str(_pick(raw, "updated", "updatedAt", "updated_at") or ""),
    }


class SeedDatasource:
    """Synthetic demo data from seed.json."""

    mode = "seed"

    def load_state(self) -> dict:
        if _SEED_PATH.exists():
            return json.loads(_SEED_PATH.read_text())
        return {"customers": [], "ledger": [], "usage": [], "tickets": [],
                "cases": [], "docs": [], "orders": [], "stairTrees": []}


class AttDatasource:
    """Live AT&T adapter. One GET per collection, Bearer auth, 10s
    timeout, one retry on network/5xx. Any failure raises DatasourceError.
    No fallback to seed — ever."""

    mode = "att"

    def __init__(self, base_url: str, api_key: str):
        if not base_url:
            raise DatasourceError(
                "ATT_API_BASE_URL is required in att datasource mode")
        if not api_key:
            raise DatasourceError(
                "ATT_API_KEY is required in att datasource mode")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def _fetch_json(self, path: str):
        last_error: Exception | None = None
        for _attempt in range(ATT_MAX_ATTEMPTS):
            request = urllib.request.Request(f"{self.base_url}{path}")
            request.add_header("Accept", "application/json")
            request.add_header("Authorization", f"Bearer {self.api_key}")
            try:
                with urllib.request.urlopen(request,
                                            timeout=ATT_TIMEOUT_SECONDS) as resp:
                    return json.loads(resp.read().decode())
            except urllib.error.HTTPError as e:
                detail = e.read().decode("utf-8", errors="replace")[:300]
                # 4xx is a real client error (bad key, bad path) — no retry.
                if e.code < 500:
                    raise DatasourceError(
                        f"AT&T API {path} returned HTTP {e.code}: {detail}",
                        status=e.code) from e
                last_error = e
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                last_error = e
            time.sleep(0.2)  # brief pause before the one retry
        raise DatasourceError(
            f"AT&T API unreachable at {self.base_url} after "
            f"{ATT_MAX_ATTEMPTS} attempts: {last_error}")

    @staticmethod
    def _as_list(value, path: str) -> list:
        if not isinstance(value, list):
            raise DatasourceError(
                f"AT&T API {path} did not return a JSON array")
        return value

    def load_state(self) -> dict:
        customers = [map_att_customer(r) for r in self._as_list(
            self._fetch_json(ATT_ENDPOINTS["customers"]),
            ATT_ENDPOINTS["customers"])]
        ledger = [map_att_ledger_entry(r) for r in self._as_list(
            self._fetch_json(ATT_ENDPOINTS["ledger"]),
            ATT_ENDPOINTS["ledger"])]
        usage = [map_att_usage(r) for r in self._as_list(
            self._fetch_json(ATT_ENDPOINTS["usage"]),
            ATT_ENDPOINTS["usage"])]
        cases = [map_att_case(r) for r in self._as_list(
            self._fetch_json(ATT_ENDPOINTS["cases"]),
            ATT_ENDPOINTS["cases"])]
        docs = [map_att_doc(r) for r in self._as_list(
            self._fetch_json(ATT_ENDPOINTS["docs"]),
            ATT_ENDPOINTS["docs"])]
        return {"customers": customers, "ledger": ledger, "usage": usage,
                "tickets": [], "cases": cases, "docs": docs,
                "orders": [], "stairTrees": []}

    def probe(self) -> dict:
        """Lightweight reachability check: GET the customers endpoint and
        report honestly. Used by /health — never returns seed data."""
        try:
            value = self._fetch_json(ATT_ENDPOINTS["customers"])
            count = len(value) if isinstance(value, list) else None
            return {"reachable": True, "customers": count, "error": None}
        except DatasourceError as e:
            return {"reachable": False, "customers": None, "error": e.reason}


def datasource_from_config(cfg: AppConfig | None = None):
    """Build the datasource for the current config."""
    cfg = cfg if cfg is not None else load_config()
    if cfg.datasource == "att":
        return AttDatasource(cfg.att_api_base_url, cfg.att_api_key)
    return SeedDatasource()


def load_state(cfg: AppConfig | None = None) -> dict:
    """Load state from the configured source. In `att` mode this raises
    DatasourceError on any failure — the caller must surface it, never
    substitute the seed."""
    return datasource_from_config(cfg).load_state()
