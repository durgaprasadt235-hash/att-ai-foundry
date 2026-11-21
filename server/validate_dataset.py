"""Bring-your-own-dataset validator (server mirror).

Implements the SAME rules D1-D12 as src/lib/dataset.ts, with the same
numbering and the same message wording wherever the languages allow, so a
file that passes in the browser passes here and vice versa. The browser
is the first-call path (upload on the call); this module is the
command-line / CI path and the check the fulfilment team runs on a sample
before a meeting.

    python3 server/validate_dataset.py file.json
    python3 server/validate_dataset.py --csv-dir ./sample-csvs

Exit code 0 = valid (warnings may still be listed), 1 = invalid.
Nothing is loaded, fixed, or written anywhere — this only reports.
Validation is a pre-check, not a gate: a file with errors is accepted
raw and cleansed automatically by server/cleanse.py (Bronze → Silver),
which implements the same D1–D12 checks with the cleansing rules
CL1–CL8. The validator itself never rewrites anything.

Rules (see src/lib/dataset.ts for the full text):
  D1  required tables present as arrays; optional tables default to []
  D2  at least 1 customer
  D3  ids unique within each table; STAIR leaf ids unique across trees
  D4  required fields present with the right type
  D5  enums (customer status, ledger kind/status, case type/status,
      usage numbers >= 0)
  D6  every ledger/usage/ticket/case customerId references a known customer
  D7  balance reconciliation: sum of POSTED ledger amounts (amounts are
      positive magnitudes; kind decides the sign — charge adds, credit
      and payment subtract) must equal the stated balance within $0.01.
      Listed. The cleanser corrects it on load (ledger is the source
      of truth) and records the correction — the validator never does.
  D8  (warning) case amount matches no posted ledger entry for the customer
  D9  (warning) duplicate charges found (same customer/service/amount,
      within 7 days, different invoice)
  D10 (warning) zero-amount ledger entries
  D11 (warning) suspended customer with balance > 0
  D12 file size over 5 MB rejected
"""

import csv
import io
import json
import sys
from datetime import date
from pathlib import Path

MAX_BYTES = 5_000_000
CASE_TYPES = ["duplicate_charge", "plan_change", "roaming_dispute",
              "provisioning", "outage", "retention", "other"]
CASE_STATUSES = ["open", "running", "awaiting_approval", "resolved",
                 "failed", "rejected"]

CSV_HEADERS = {
    "customers": ["id", "name", "account", "phone", "email", "plan",
                  "status", "since", "balance", "city"],
    "ledger": ["id", "customerId", "invoice", "date", "service",
               "amount", "kind", "status"],
    "usage": ["id", "customerId", "month", "dataGb", "minutes", "sms"],
    "cases": ["id", "customerId", "type", "title", "description",
              "amount", "status", "createdAt", "idempotencyKey"],
    "tickets": ["id", "customerId", "date", "subject", "status"],
}


def _is_str(v) -> bool:
    return isinstance(v, str) and v.strip() != ""


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _money_eq(a: float, b: float) -> bool:
    return abs(a - b) < 0.005


def signed_ledger_amount(e) -> float:
    """The one ledger-sign rule, used by D7 and by Medallion Gold totals.

    Amounts in a file are positive magnitudes; kind decides the sign:
    a charge adds to what the customer owes, a credit or a payment
    subtracts. A negative amount in the file is taken as given (so a
    negative payment would add) — the rule is the kind, not the sign.
    """
    amount = e.get("amount") if _is_num(e.get("amount")) else 0
    return amount if e.get("kind") == "charge" else -amount


def find_duplicate_pairs(ledger):
    """Same rule as the engine (server/engine.py find_duplicate): same
    customer, same service, same amount, within 7 days, different invoice,
    posted charges only."""
    pairs = []
    by_customer = {}
    for e in ledger:
        if e.get("kind") != "charge" or e.get("status") != "posted":
            continue
        by_customer.setdefault(e.get("customerId"), []).append(e)
    for customer_id, charges in by_customer.items():
        ordered = sorted(charges, key=lambda e: e.get("date", ""))
        for i, a in enumerate(ordered):
            for b in ordered[i + 1:]:
                if (a.get("service") != b.get("service")
                        or a.get("amount") != b.get("amount")
                        or a.get("invoice") == b.get("invoice")):
                    continue
                try:
                    days = (date.fromisoformat(b["date"])
                            - date.fromisoformat(a["date"])).days
                except (ValueError, TypeError, KeyError):
                    continue
                if 0 <= days <= 7:
                    pairs.append({"customerId": customer_id,
                                  "original": a, "duplicate": b})
    return pairs


def _empty():
    return {
        "valid": False, "errors": [], "warnings": [],
        "counts": {"customers": 0, "ledger": 0, "usage": 0, "tickets": 0,
                   "cases": 0, "docs": 0, "orders": 0, "stairTrees": 0},
        "duplicatesFound": [], "balanceMismatches": [],
        "unmatchedCases": [], "filled": [],
    }


def parse_tables(data):
    """D1 only: parse the top-level structure into the 8 tables.

    Returns (tables, errors). Tables always has all 8 keys; when errors
    is non-empty the tables may be partially populated and must not be
    used — the file is structurally unusable (nothing to cleanse).
    The cleanser (server/cleanse.py) starts from these raw tables.
    """
    tables = {"customers": [], "ledger": [], "usage": [], "tickets": [],
              "cases": [], "docs": [], "orders": [], "stairTrees": []}
    errors = []
    if not isinstance(data, dict):
        errors.append(
            "D1: dataset must be a JSON object with customers, ledger, "
            "usage and cases arrays.")
        return tables, errors
    for key in ("customers", "ledger", "usage", "cases"):
        if not isinstance(data.get(key), list):
            errors.append(
                f'D1: "{key}" is missing or not an array — it is required.')
        else:
            tables[key] = data[key]
    for key in ("tickets", "docs", "orders", "stairTrees"):
        if key in data:
            if not isinstance(data[key], list):
                errors.append(
                    f'D1: "{key}" must be an array when present.')
            else:
                tables[key] = data[key]
    return tables, errors


def validate_dataset(data):
    """Validate parsed dataset data. Returns (validation_dict, tables or
    None). Tables is None unless the dataset is valid."""
    v = _empty()
    tables, d1_errors = parse_tables(data)
    if d1_errors:
        v["errors"].extend(d1_errors)
        return v, None

    # D2 — at least one customer.
    if not tables["customers"]:
        v["errors"].append(
            "D2: dataset has no customers — at least 1 is required.")

    # D3 — unique ids within each table.
    def check_unique(rows, label):
        seen = set()
        for r in rows:
            rid = r.get("id") if isinstance(r, dict) else None
            if not _is_str(rid):
                continue
            if rid in seen:
                v["errors"].append(f'D3: duplicate id "{rid}" in {label}.')
            seen.add(rid)

    check_unique(tables["customers"], "customers")
    check_unique(tables["ledger"], "ledger")
    check_unique(tables["usage"], "usage")
    check_unique(tables["tickets"], "tickets")
    check_unique(tables["cases"], "cases")
    check_unique(tables["docs"], "docs")
    check_unique(tables["stairTrees"], "stairTrees")
    leaf_ids = set()
    for t in tables["stairTrees"]:
        if not isinstance(t, dict) or not isinstance(t.get("leaves"), list):
            v["errors"].append(
                f'D3: stair tree "{t.get("id") if isinstance(t, dict) else "?"}'
                " has no leaves array.")
            continue
        for leaf in t["leaves"]:
            lid = leaf.get("id") if isinstance(leaf, dict) else None
            if not _is_str(lid):
                continue
            if lid in leaf_ids:
                v["errors"].append(
                    f'D3: duplicate STAIR leaf id "{lid}" across trees.')
            leaf_ids.add(lid)

    customer_ids = {c.get("id") for c in tables["customers"]
                    if isinstance(c, dict)}

    # D4 + D5 — required fields, types, enums.
    for c in tables["customers"]:
        cid = c.get("id") if isinstance(c, dict) else None
        if not isinstance(c, dict) or not _is_str(c.get("id")):
            v["errors"].append('D4: a customer is missing a non-empty "id".')
        if not _is_str(c.get("name")):
            v["errors"].append(f'D4: customer {cid or "?"} is missing "name".')
        if not _is_str(c.get("account")):
            v["errors"].append(
                f'D4: customer {cid or "?"} is missing "account".')
        if not _is_str(c.get("plan")):
            v["errors"].append(f'D4: customer {cid or "?"} is missing "plan".')
        if not _is_num(c.get("balance")):
            v["errors"].append(
                f'D4: customer {cid or "?"} has a non-numeric "balance".')
        if c.get("status") not in ("active", "suspended", "closed"):
            v["errors"].append(
                f'D5: customer {cid or "?"} has unknown status '
                f'{json.dumps(c.get("status"))} (use active|suspended|closed).')
        if not _is_str(c.get("since")):
            v["errors"].append(
                f'D4: customer {cid or "?"} is missing "since".')
    for e in tables["ledger"]:
        eid = e.get("id") if isinstance(e, dict) else None
        if not isinstance(e, dict) or not _is_str(e.get("id")):
            v["errors"].append(
                'D4: a ledger entry is missing a non-empty "id".')
        if not _is_str(e.get("customerId")):
            v["errors"].append(
                f'D4: ledger {eid or "?"} is missing "customerId".')
        if not _is_str(e.get("invoice")):
            v["errors"].append(
                f'D4: ledger {eid or "?"} is missing "invoice".')
        if not _is_str(e.get("service")):
            v["errors"].append(
                f'D4: ledger {eid or "?"} is missing "service".')
        if not _is_num(e.get("amount")):
            v["errors"].append(
                f'D4: ledger {eid or "?"} has a non-numeric "amount".')
        if e.get("kind") not in ("charge", "credit", "payment"):
            v["errors"].append(
                f'D5: ledger {eid or "?"} has unknown kind '
                f'{json.dumps(e.get("kind"))} (use charge|credit|payment).')
        if e.get("status") not in ("posted", "reversed"):
            v["errors"].append(
                f'D5: ledger {eid or "?"} has unknown status '
                f'{json.dumps(e.get("status"))} (use posted|reversed).')
    for u in tables["usage"]:
        uid = u.get("id") if isinstance(u, dict) else None
        if not isinstance(u, dict) or not _is_str(u.get("id")):
            v["errors"].append(
                'D4: a usage record is missing a non-empty "id".')
        if not _is_str(u.get("customerId")):
            v["errors"].append(
                f'D4: usage {uid or "?"} is missing "customerId".')
        if not _is_str(u.get("month")):
            v["errors"].append(
                f'D4: usage {uid or "?"} is missing "month".')
        for f in ("dataGb", "minutes", "sms"):
            if not _is_num(u.get(f)):
                v["errors"].append(
                    f'D4: usage {uid or "?"} has a non-numeric "{f}".')
            elif u[f] < 0:
                v["errors"].append(
                    f'D5: usage {uid or "?"} has a negative "{f}" ({u[f]}).')
    for t in tables["tickets"]:
        tid = t.get("id") if isinstance(t, dict) else None
        if not isinstance(t, dict) or not _is_str(t.get("id")):
            v["errors"].append('D4: a ticket is missing a non-empty "id".')
        if not _is_str(t.get("customerId")):
            v["errors"].append(
                f'D4: ticket {tid or "?"} is missing "customerId".')
        if not _is_str(t.get("subject")):
            v["errors"].append(
                f'D4: ticket {tid or "?"} is missing "subject".')
        if (t.get("status") is not None
                and t.get("status") not in ("open", "resolved")):
            v["errors"].append(
                f'D5: ticket {tid or "?"} has unknown status '
                f'{json.dumps(t.get("status"))} (use open|resolved).')
    for c in tables["cases"]:
        cid = c.get("id") if isinstance(c, dict) else None
        if not isinstance(c, dict) or not _is_str(c.get("id")):
            v["errors"].append('D4: a case is missing a non-empty "id".')
        if not _is_str(c.get("customerId")):
            v["errors"].append(
                f'D4: case {cid or "?"} is missing "customerId".')
        if c.get("type") not in CASE_TYPES:
            v["errors"].append(
                f'D5: case {cid or "?"} has unknown type '
                f'{json.dumps(c.get("type"))} (use {"|".join(CASE_TYPES)}).')
        if not _is_str(c.get("title")):
            v["errors"].append(f'D4: case {cid or "?"} is missing "title".')
        if not _is_num(c.get("amount")):
            v["errors"].append(
                f'D4: case {cid or "?"} has a non-numeric "amount".')
    for d in tables["docs"]:
        did = d.get("id") if isinstance(d, dict) else None
        if not isinstance(d, dict) or not _is_str(d.get("id")):
            v["errors"].append('D4: a policy doc is missing a non-empty "id".')
        if not _is_str(d.get("title")):
            v["errors"].append(f'D4: doc {did or "?"} is missing "title".')
        if not _is_str(d.get("body")):
            v["errors"].append(f'D4: doc {did or "?"} is missing "body".')
    for t in tables["stairTrees"]:
        tid = t.get("id") if isinstance(t, dict) else None
        if not isinstance(t, dict) or not _is_str(t.get("id")):
            v["errors"].append(
                'D4: a STAIR tree is missing a non-empty "id".')
        if not _is_str(t.get("title")):
            v["errors"].append(
                f'D4: stair tree {tid or "?"} is missing "title".')
        for leaf in (t.get("leaves") or []):
            if not isinstance(leaf, dict) or not (
                    _is_str(leaf.get("id")) and _is_str(leaf.get("title"))
                    and _is_str(leaf.get("path"))
                    and _is_str(leaf.get("body"))):
                v["errors"].append(
                    f'D4: a STAIR leaf in tree {tid or "?"} is missing '
                    "id/title/path/body.")

    # D6 — references must resolve.
    for e in tables["ledger"]:
        if _is_str(e.get("customerId")) and e["customerId"] not in customer_ids:
            v["errors"].append(
                f'D6: ledger {e.get("id")} references unknown customer '
                f'{e["customerId"]}.')
    for u in tables["usage"]:
        if _is_str(u.get("customerId")) and u["customerId"] not in customer_ids:
            v["errors"].append(
                f'D6: usage {u.get("id")} references unknown customer '
                f'{u["customerId"]}.')
    for t in tables["tickets"]:
        if _is_str(t.get("customerId")) and t["customerId"] not in customer_ids:
            v["errors"].append(
                f'D6: ticket {t.get("id")} references unknown customer '
                f'{t["customerId"]}.')
    for c in tables["cases"]:
        if _is_str(c.get("customerId")) and c["customerId"] not in customer_ids:
            v["errors"].append(
                f'D6: case {c.get("id")} references unknown customer '
                f'{c["customerId"]}.')

    # D7 — balance reconciliation (posted entries only; amounts are
    # positive magnitudes, kind decides the sign — see signed_ledger_amount).
    for c in tables["customers"]:
        if not isinstance(c, dict) or not _is_num(c.get("balance")):
            continue
        computed = sum(
            signed_ledger_amount(e) for e in tables["ledger"]
            if isinstance(e, dict) and e.get("customerId") == c["id"]
            and e.get("status") == "posted" and _is_num(e.get("amount")))
        if abs(computed - c["balance"]) >= 0.01:
            v["balanceMismatches"].append({
                "customerId": c["id"], "name": c.get("name"),
                "stated": c["balance"],
                "computed": round(computed, 2)})
            v["errors"].append(
                f'D7: balance does not reconcile for {c["id"]} '
                f'({c.get("name")}): stated ${c["balance"]:.2f}, ledger sums '
                f'to ${computed:.2f}. The cleanser corrects the balance to '
                f'${computed:.2f} on load (ledger is the source of truth) — '
                "see the cleansing report.")

    # D8 — case amount with no matching ledger entry (warning only).
    for c in tables["cases"]:
        if not isinstance(c, dict) or not _is_num(c.get("amount")):
            continue
        if not _is_str(c.get("customerId")):
            continue
        match = any(
            isinstance(e, dict) and e.get("customerId") == c["customerId"]
            and e.get("status") == "posted" and _is_num(e.get("amount"))
            and _money_eq(e["amount"], c["amount"])
            for e in tables["ledger"])
        if not match:
            v["unmatchedCases"].append(c["id"])
            v["warnings"].append(
                f'D8: case {c["id"]} amount ${c["amount"]:.2f} matches no '
                f'posted ledger entry for {c["customerId"]} — the agent may '
                "fail honestly when run.")

    # D9 — duplicate charges found (warning only).
    for p in find_duplicate_pairs(tables["ledger"]):
        label = (f'{p["customerId"]}: {p["original"]["invoice"]} + '
                 f'{p["duplicate"]["invoice"]} '
                 f'(${p["duplicate"]["amount"]:.2f})')
        v["duplicatesFound"].append(label)
        v["warnings"].append(f"D9: duplicate charge found — {label}.")

    # D10 — zero-amount ledger entries (warning).
    for e in tables["ledger"]:
        if isinstance(e, dict) and e.get("amount") == 0:
            v["warnings"].append(
                f'D10: ledger {e.get("id")} has a zero amount (Silver will '
                "quarantine it).")
    # D11 — suspended customer with a balance (warning).
    for c in tables["customers"]:
        if (isinstance(c, dict) and c.get("status") == "suspended"
                and _is_num(c.get("balance")) and c["balance"] > 0):
            v["warnings"].append(
                f'D11: suspended customer {c["id"]} ({c.get("name")}) still '
                f'has a balance of ${c["balance"]:.2f} (Silver will '
                "quarantine it).")

    # Transparent fills (listed, never silent).
    for c in tables["cases"]:
        if not isinstance(c, dict):
            continue
        if c.get("status") not in CASE_STATUSES:
            c["status"] = "open"
            v["filled"].append(
                f'case {c.get("id")}: status set to "open" '
                "(was missing/unknown).")
        if not _is_str(c.get("idempotencyKey")):
            c["idempotencyKey"] = f'{str(c.get("id", "")).lower()}-v1'
            v["filled"].append(
                f'case {c.get("id")}: idempotencyKey set to '
                f'"{c["idempotencyKey"]}".')
        if not _is_str(c.get("createdAt")):
            from datetime import datetime, timezone
            c["createdAt"] = datetime.now(timezone.utc).isoformat()
            v["filled"].append(f'case {c.get("id")}: createdAt set to now.')
    for t in tables["tickets"]:
        if not isinstance(t, dict):
            continue
        if not t.get("status"):
            t["status"] = "open"
            v["filled"].append(f'ticket {t.get("id")}: status set to "open".')
        if not _is_str(t.get("date")):
            t["date"] = date.today().isoformat()
            v["filled"].append(f'ticket {t.get("id")}: date set to today.')
    for d in tables["docs"]:
        if isinstance(d, dict) and not _is_str(d.get("updated")):
            d["updated"] = date.today().isoformat()
            v["filled"].append(f'doc {d.get("id")}: updated set to today.')
    for t in tables["stairTrees"]:
        if not isinstance(t, dict):
            continue
        if t.get("autoGenerated") is None:
            t["autoGenerated"] = False
            v["filled"].append(
                f'stair tree {t.get("id")}: autoGenerated set to false '
                "(uploaded trees are treated as authored).")
        for leaf in (t.get("leaves") or []):
            if isinstance(leaf, dict) and not _is_str(leaf.get("section")):
                leaf["section"] = ""
                v["filled"].append(
                    f'STAIR leaf {leaf.get("id")}: section left blank.')

    v["counts"] = {k: len(tables[k]) for k in
                   ("customers", "ledger", "usage", "tickets", "cases",
                    "docs", "orders", "stairTrees")}
    v["valid"] = len(v["errors"]) == 0
    return v, (tables if v["valid"] else None)


def _csv_num(raw, label, errors):
    if raw is None or str(raw).strip() == "":
        errors.append(f"D4: {label} is missing a numeric value.")
        return None
    try:
        return float(raw)
    except ValueError:
        errors.append(f'D4: {label} is not a number ({json.dumps(raw)}).')
        return None


def csv_files_to_data(files):
    """Assemble CSV files ({filename: text}) into the dataset dict (the
    same shape as a JSON file). Returns (data, errors). data is None
    only when the CSVs are structurally unusable (unrecognised file,
    missing header column, missing required table). A bad number leaves
    a None in that row and is listed in errors — the cleanser
    (server/cleanse.py) quarantines that row instead of the whole file
    being unusable."""
    errors = []
    by_table = {}
    for name, text in files.items():
        stem = Path(name).stem.lower()
        if stem not in CSV_HEADERS:
            expected = ", ".join(f"{k}.csv" for k in CSV_HEADERS)
            errors.append(
                f'CSV: unrecognised file "{name}" — expected one of '
                f"{expected}.")
            continue
        try:
            reader = csv.DictReader(io.StringIO(text))
            headers = [h.strip() if h else h for h in (reader.fieldnames or [])]
            missing = [h for h in CSV_HEADERS[stem] if h not in headers]
            if missing:
                errors.append(
                    f"CSV: {name} is missing header column(s): "
                    f"{', '.join(missing)}. Expected: "
                    f"{', '.join(CSV_HEADERS[stem])}.")
                continue
            by_table[stem] = [dict(r) for r in reader if any(
                (val or "").strip() for val in r.values() if val is not None)]
        except csv.Error as exc:
            errors.append(f"CSV: {name} could not be parsed — {exc}.")
    for required in ("customers", "ledger", "usage", "cases"):
        if required not in by_table:
            errors.append(
                f'D1: "{required}.csv" was not uploaded — customers, '
                "ledger, usage and cases are all required.")
    if errors:
        return None, errors

    data = {
        "customers": [{
            "id": r.get("id"), "name": r.get("name"),
            "account": r.get("account"), "phone": r.get("phone"),
            "email": r.get("email"), "plan": r.get("plan"),
            "status": r.get("status"), "since": r.get("since"),
            "balance": _csv_num(r.get("balance"),
                                f'customer {r.get("id") or "?"} balance',
                                errors),
            "city": r.get("city"),
        } for r in by_table.get("customers", [])],
        "ledger": [{
            "id": r.get("id"), "customerId": r.get("customerId"),
            "invoice": r.get("invoice"), "date": r.get("date"),
            "service": r.get("service"),
            "amount": _csv_num(r.get("amount"),
                               f'ledger {r.get("id") or "?"} amount',
                               errors),
            "kind": r.get("kind"), "status": r.get("status"),
        } for r in by_table.get("ledger", [])],
        "usage": [{
            "id": r.get("id"), "customerId": r.get("customerId"),
            "month": r.get("month"),
            "dataGb": _csv_num(r.get("dataGb"),
                               f'usage {r.get("id") or "?"} dataGb',
                               errors),
            "minutes": _csv_num(r.get("minutes"),
                                f'usage {r.get("id") or "?"} minutes',
                                errors),
            "sms": _csv_num(r.get("sms"),
                            f'usage {r.get("id") or "?"} sms', errors),
        } for r in by_table.get("usage", [])],
        "cases": [{
            "id": r.get("id"), "customerId": r.get("customerId"),
            "type": r.get("type"), "title": r.get("title"),
            "description": r.get("description"),
            "amount": _csv_num(r.get("amount"),
                               f'case {r.get("id") or "?"} amount',
                               errors),
            "status": r.get("status") or None,
            "createdAt": r.get("createdAt") or None,
            "idempotencyKey": r.get("idempotencyKey") or None,
        } for r in by_table.get("cases", [])],
        "tickets": [{
            "id": r.get("id"), "customerId": r.get("customerId"),
            "date": r.get("date"), "subject": r.get("subject"),
            "status": r.get("status") or None,
        } for r in by_table.get("tickets", [])],
        "docs": [], "orders": [], "stairTrees": [],
    }
    return data, errors


def validate_dataset_csv_files(files):
    """Validate CSV files: {filename: text}. Same result shape as
    validate_dataset. Filenames pick the table (customers.csv, ...)."""
    v = _empty()
    data, errors = csv_files_to_data(files)
    if errors:
        v["errors"].extend(errors)
        return v, None
    return validate_dataset(data)


def main(argv):
    if len(argv) < 2:
        print("usage: python3 server/validate_dataset.py file.json "
              "[--csv-dir DIR]")
        return 2
    if "--csv-dir" in argv:
        d = Path(argv[argv.index("--csv-dir") + 1])
        if not d.is_dir():
            print(f"error: {d} is not a directory")
            return 2
        files = {p.name: p.read_text(encoding="utf-8")
                 for p in sorted(d.glob("*.csv"))}
        if not files:
            print(f"error: no .csv files in {d}")
            return 2
        validation, _ = validate_dataset_csv_files(files)
    else:
        path = Path(argv[1])
        if not path.is_file():
            print(f"error: {path} is not a file")
            return 2
        if path.stat().st_size > MAX_BYTES:
            print(f"error: D12: {path} is over 5 MB — bring an anonymised "
                  "sample, not a production dump.")
            return 1
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            print(f"error: {path} is not valid JSON: {exc}")
            return 1
        validation, _ = validate_dataset(data)

    c = validation["counts"]
    print(f"{'VALID' if validation['valid'] else 'INVALID'}: "
          f"{c['customers']} customers, {c['ledger']} ledger, "
          f"{c['usage']} usage, {c['tickets']} tickets, "
          f"{c['cases']} cases, {c['docs']} docs, "
          f"{c['stairTrees']} STAIR trees")
    for e in validation["errors"]:
        print(f"  ERROR: {e}")
    for w in validation["warnings"]:
        print(f"  warning: {w}")
    for f in validation["filled"]:
        print(f"  filled: {f}")
    return 0 if validation["valid"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
