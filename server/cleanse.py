"""Raw-upload auto-cleanse — the Bronze → Silver step of the upload flow.

The user's process: a file needs to be uploaded anyway, raw or
cleansed — that IS the process. Raw data goes through automated
cleansing and comes out as a production-ready usage file. So the Data
view never rejects a file for data errors: the validation report
(rules D1–D12, validate_dataset.py) is a pre-check, and this module
turns the raw tables into a cleansed dataset that passes validation
with 0 errors. The raw file is never edited — cleansing produces a
new, separate tables dict; the original file and the built-in seed are
never touched.

Cleansing rules CL1–CL8 (the TypeScript mirror src/lib/cleanse.ts
implements the SAME rules with the SAME numbering):

  CL1 Duplicate ids — keep the first occurrence, quarantine the rest.
      Per table, and STAIR leaf ids across trees.
  CL2 Invalid record — a missing/invalid required field or an unknown
      enum value (D4/D5) quarantines the record. Nothing is guessed.
  CL3 Dangling reference — a ledger / usage / ticket / case whose
      customerId names no kept customer (D6) is quarantined. Runs
      after CL2, so records of a quarantined customer cascade here.
  CL4 Balance mismatch — the ledger is the source of truth. A
      customer's balance is recomputed from their kept POSTED ledger
      entries (kind-based signs: charge adds, credit/payment subtract)
      and corrected; every correction is recorded as old → new.
  CL5 Zero-amount ledger entries — kept (they contribute $0.00), noted.
  CL6 Suspended-with-balance customers — kept (Silver quarantines them
      at run time), noted.
  CL7 Duplicate charges — kept (they drive the billing journey), noted.
  CL8 Unfixable — anything the rules above cannot make valid is
      quarantined, never guessed. The cleansed tables are re-validated
      (D1–D12) before they are returned: if they still fail, the
      cleanse is refused and the remaining errors are reported.

What can never be cleansed (the load is refused, nothing half-loaded):
  - D1 structural failure — not an object, a required table missing
    or not an array, a CSV that cannot be parsed (no raw tables to
    start from), a file over 5 MB (D12, rejected at upload).
  - D2 — no customers at all, or no valid customers left after
    quarantining.

Every correction and every quarantined record is listed in the
report. Nothing is fixed silently, nothing is dropped silently.

CLI:

    python3 server/cleanse.py input.json [output.json]
    python3 server/cleanse.py --csv-dir ./sample-csvs [output.json]

Exit 0 = cleansed file written (or cleansable, when no output path
is given), 1 = cannot cleanse, 2 = usage error. The report is
printed in all cases; with an output path the cleansed JSON (same
shape as test-data.json) is written there.
"""

import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from validate_dataset import (  # noqa: E402
    CASE_TYPES,
    csv_files_to_data,
    parse_tables,
    signed_ledger_amount,
    validate_dataset,
)

CUSTOMER_STATUSES = ("active", "suspended", "closed")
LEDGER_KINDS = ("charge", "credit", "payment")
LEDGER_STATUSES = ("posted", "reversed")
TICKET_STATUSES = ("open", "resolved")
TABLE_KEYS = ("customers", "ledger", "usage", "tickets", "cases",
              "docs", "stairTrees")


def _is_str(v) -> bool:
    return isinstance(v, str) and v.strip() != ""


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _counts(tables):
    return {k: len(tables.get(k) or []) for k in
            ("customers", "ledger", "usage", "tickets", "cases",
             "docs", "orders", "stairTrees")}


def _money(n: float) -> str:
    return f"${n:.2f}"


def _empty_report(source_counts):
    return {
        "can_cleanse": False, "blocked_reason": None,
        "source_counts": source_counts,
        "cleansed_counts": {k: 0 for k in
                            ("customers", "ledger", "usage", "tickets",
                             "cases", "docs", "orders", "stairTrees")},
        "corrected": [], "quarantined": [], "notes": [],
        "raw_errors": [], "raw_warnings": [], "validation": None,
    }


def _record_problem(table, row):
    """One deterministic validity check per table, mirroring the
    validator's D4/D5. Returns None when the record is usable, or the
    reason it must be quarantined (CL2)."""
    if not isinstance(row, dict):
        return "record is not an object"
    if table == "customers":
        if not _is_str(row.get("id")):
            return 'missing "id"'
        if not _is_str(row.get("name")):
            return 'missing "name"'
        if not _is_str(row.get("account")):
            return 'missing "account"'
        if not _is_str(row.get("plan")):
            return 'missing "plan"'
        if not _is_num(row.get("balance")):
            return 'non-numeric "balance"'
        if row.get("status") not in CUSTOMER_STATUSES:
            return (f'unknown status {json.dumps(row.get("status"))}')
        if not _is_str(row.get("since")):
            return 'missing "since"'
        return None
    if table == "ledger":
        if not _is_str(row.get("id")):
            return 'missing "id"'
        if not _is_str(row.get("customerId")):
            return 'missing "customerId"'
        if not _is_str(row.get("invoice")):
            return 'missing "invoice"'
        if not _is_str(row.get("service")):
            return 'missing "service"'
        if not _is_num(row.get("amount")):
            return 'non-numeric "amount"'
        if row.get("kind") not in LEDGER_KINDS:
            return (f'unknown kind {json.dumps(row.get("kind"))}')
        if row.get("status") not in LEDGER_STATUSES:
            return (f'unknown status {json.dumps(row.get("status"))}')
        return None
    if table == "usage":
        if not _is_str(row.get("id")):
            return 'missing "id"'
        if not _is_str(row.get("customerId")):
            return 'missing "customerId"'
        if not _is_str(row.get("month")):
            return 'missing "month"'
        for f in ("dataGb", "minutes", "sms"):
            if not _is_num(row.get(f)):
                return f'non-numeric "{f}"'
            if row[f] < 0:
                return f'negative "{f}" ({row[f]})'
        return None
    if table == "tickets":
        if not _is_str(row.get("id")):
            return 'missing "id"'
        if not _is_str(row.get("customerId")):
            return 'missing "customerId"'
        if not _is_str(row.get("subject")):
            return 'missing "subject"'
        if row.get("status") not in TICKET_STATUSES:
            return (f'unknown status {json.dumps(row.get("status"))}')
        return None
    if table == "cases":
        if not _is_str(row.get("id")):
            return 'missing "id"'
        if not _is_str(row.get("customerId")):
            return 'missing "customerId"'
        if row.get("type") not in CASE_TYPES:
            return (f'unknown type {json.dumps(row.get("type"))}')
        if not _is_str(row.get("title")):
            return 'missing "title"'
        if not _is_num(row.get("amount")):
            return 'non-numeric "amount"'
        return None
    if table == "docs":
        if not _is_str(row.get("id")):
            return 'missing "id"'
        if not _is_str(row.get("title")):
            return 'missing "title"'
        if not _is_str(row.get("body")):
            return 'missing "body"'
        return None
    if table == "stairTrees":
        if not _is_str(row.get("id")):
            return 'missing "id"'
        if not _is_str(row.get("title")):
            return 'missing "title"'
        if not isinstance(row.get("leaves"), list):
            return 'missing "leaves" array'
        return None
    return None


def _leaf_problem(leaf):
    if not isinstance(leaf, dict):
        return "leaf is not an object"
    if not _is_str(leaf.get("id")):
        return 'missing "id"'
    if not _is_str(leaf.get("title")):
        return 'missing "title"'
    if not _is_str(leaf.get("path")):
        return 'missing "path"'
    if not _is_str(leaf.get("body")):
        return 'missing "body"'
    return None


def _row_id(row):
    return row.get("id") if isinstance(row, dict) and _is_str(row.get("id")) else "?"


def cleanse_tables(raw):
    """Cleanse raw tables into a production-ready dataset. The input is
    never mutated — the cleansed tables are a deep copy. Returns
    (cleansed_or_None, report)."""
    report = _empty_report(_counts(raw))

    # D2 — nothing to cleanse without customers.
    if not isinstance(raw.get("customers"), list) or not raw["customers"]:
        report["blocked_reason"] = (
            "D2: the file has no customers — there is nothing to cleanse.")
        return None, report

    # Work on a deep copy; the raw tables (and the user's file) are
    # never modified.
    work = copy.deepcopy(raw)
    for k in TABLE_KEYS:
        if not isinstance(work.get(k), list):
            work[k] = []
    if not isinstance(work.get("orders"), list):
        work["orders"] = []

    # Raw validation = the pre-check report. It also applies the
    # deterministic fills (case status, idempotencyKey, createdAt,
    # ticket status/date, doc updated, stair autoGenerated) to the
    # working copy; those fills are listed, never silent.
    raw_v, _ = validate_dataset(work)
    report["raw_errors"] = raw_v["errors"]
    report["raw_warnings"] = raw_v["warnings"]
    for f in raw_v["filled"]:
        report["notes"].append(f"Auto-filled: {f}")

    # Fast path — already valid: nothing to correct or quarantine.
    if raw_v["valid"]:
        report["can_cleanse"] = True
        report["validation"] = raw_v
        report["cleansed_counts"] = _counts(work)
        # The file's own warnings (duplicate charges,
        # suspended-with-balance) are still notes: those records are
        # kept, and the report says so.
        for w in raw_v["warnings"]:
            report["notes"].append(w)
        return work, report

    # CL1 — duplicate ids: keep the first occurrence, quarantine the rest.
    for key in TABLE_KEYS:
        seen = set()
        kept = []
        for row in work[key]:
            if isinstance(row, dict) and _is_str(row.get("id")):
                if row["id"] in seen:
                    report["quarantined"].append({
                        "table": key, "id": row["id"], "rule": "CL1",
                        "reason": (f'duplicate id "{row["id"]}" in {key} '
                                   "— kept the first occurrence.")})
                    continue
                seen.add(row["id"])
            kept.append(row)
        work[key] = kept
    # CL1 — STAIR leaf ids are unique across trees: keep the first leaf.
    seen_leaf_ids = set()
    for tree in work["stairTrees"]:
        if not isinstance(tree, dict) or not isinstance(tree.get("leaves"), list):
            continue
        kept_leaves = []
        for leaf in tree["leaves"]:
            if isinstance(leaf, dict) and _is_str(leaf.get("id")):
                if leaf["id"] in seen_leaf_ids:
                    report["quarantined"].append({
                        "table": "stairTrees", "id": leaf["id"],
                        "rule": "CL1",
                        "reason": (f'duplicate STAIR leaf id "{leaf["id"]}" '
                                   "across trees — kept the first "
                                   "occurrence.")})
                    continue
                seen_leaf_ids.add(leaf["id"])
            kept_leaves.append(leaf)
        tree["leaves"] = kept_leaves

    # CL2 — invalid records are quarantined, never guessed.
    for key in TABLE_KEYS:
        kept = []
        for row in work[key]:
            problem = _record_problem(key, row)
            if problem:
                report["quarantined"].append({
                    "table": key, "id": _row_id(row), "rule": "CL2",
                    "reason": problem})
                continue
            # A STAIR tree whose leaves are all invalid loses the tree.
            if key == "stairTrees" and isinstance(row, dict):
                kept_leaves = []
                for leaf in row.get("leaves") or []:
                    lp = _leaf_problem(leaf)
                    if lp:
                        report["quarantined"].append({
                            "table": "stairTrees", "id": _row_id(leaf),
                            "rule": "CL2",
                            "reason": (f'STAIR leaf in tree {_row_id(row)}: '
                                       f'{lp}')})
                        continue
                    kept_leaves.append(leaf)
                if not kept_leaves:
                    report["quarantined"].append({
                        "table": "stairTrees", "id": _row_id(row),
                        "rule": "CL2",
                        "reason": ("no valid leaves remain after "
                                   "quarantining invalid leaves")})
                    continue
                row["leaves"] = kept_leaves
            kept.append(row)
        work[key] = kept

    # No valid customers left → nothing to cleanse (D2).
    if not work["customers"]:
        report["blocked_reason"] = (
            "D2: no valid customers remain after quarantining invalid "
            "records — there is nothing to cleanse.")
        return None, report

    # CL3 — dangling references: quarantine records naming a customer
    # that is not in the kept set (including customers quarantined above).
    customer_ids = {c["id"] for c in work["customers"]}
    for key in ("ledger", "usage", "tickets", "cases"):
        kept = []
        for row in work[key]:
            cid = row.get("customerId") if isinstance(row, dict) else None
            if isinstance(cid, str) and cid not in customer_ids:
                report["quarantined"].append({
                    "table": key, "id": _row_id(row), "rule": "CL3",
                    "reason": f"references unknown customer {cid}"})
                continue
            kept.append(row)
        work[key] = kept

    # CL4 — balances: the ledger is the source of truth. Recompute each
    # kept customer's balance from their kept POSTED ledger entries and
    # correct it, recording old → new.
    for c in work["customers"]:
        computed = sum(
            signed_ledger_amount(e) for e in work["ledger"]
            if isinstance(e, dict) and e.get("customerId") == c["id"]
            and e.get("status") == "posted" and _is_num(e.get("amount")))
        rounded = round(computed, 2)
        if abs(rounded - c["balance"]) >= 0.01:
            report["corrected"].append({
                "table": "customers", "id": c["id"], "field": "balance",
                "old_value": _money(c["balance"]),
                "new_value": _money(rounded), "rule": "CL4"})
            c["balance"] = rounded

    # CL8 — re-validate the cleansed tables. They must pass D1–D12 with
    # 0 errors, or the cleanse is refused and the remaining errors are
    # reported. (CL5/CL6/CL7 are the kept-but-noted items: zero-amount
    # entries, suspended-with-balance customers and duplicate charges
    # stay in the cleansed set — the re-validation lists them as
    # warnings, which become report notes below.)
    clean_v, clean_tables = validate_dataset(work)
    report["validation"] = clean_v
    if not clean_v["valid"] or clean_tables is None:
        remaining = " | ".join(clean_v["errors"][:5])
        if len(clean_v["errors"]) > 5:
            remaining += f' (+{len(clean_v["errors"]) - 5} more)'
        report["blocked_reason"] = (
            "Cleansing could not produce a valid dataset — remaining "
            f"errors: {remaining}")
        return None, report
    for w in clean_v["warnings"]:
        report["notes"].append(w)
    report["can_cleanse"] = True
    report["cleansed_counts"] = _counts(clean_tables)
    return clean_tables, report


def cleanse_dataset(data):
    """Cleanse parsed JSON data. Returns (cleansed_or_None, report).
    Structurally unusable data (D1) cannot be cleansed."""
    tables, d1_errors = parse_tables(data)
    if d1_errors:
        report = _empty_report(_counts(tables))
        report["blocked_reason"] = (
            "D1: the file is structurally unusable — " + " | ".join(d1_errors[:3]))
        report["raw_errors"] = d1_errors
        return None, report
    return cleanse_tables(tables)


def cleanse_csv_files(files):
    """Cleanse CSV files ({filename: text}). Returns
    (cleansed_or_None, report)."""
    data, errors = csv_files_to_data(files)
    if data is None:
        report = _empty_report(
            {"customers": 0, "ledger": 0, "usage": 0, "tickets": 0,
             "cases": 0, "docs": 0, "orders": 0, "stairTrees": 0})
        report["blocked_reason"] = (
            "The CSV files are structurally unusable — "
            + " | ".join(errors[:3]))
        report["raw_errors"] = errors
        return None, report
    return cleanse_tables(data)


def cleanse_summary(report) -> str:
    """One-line summary for the audit log: what the cleanser changed,
    so any load is traceable."""
    s = report["source_counts"]
    c = report["cleansed_counts"]
    return (f'Auto-cleansed on load: {len(report["corrected"])} balance '
            f'correction(s), {len(report["quarantined"])} record(s) '
            f'quarantined, {len(report["notes"])} note(s). '
            f'Raw: {s["customers"]} customers, {s["ledger"]} ledger '
            f'entries. Cleansed: {c["customers"]} customers, '
            f'{c["ledger"]} ledger entries. Corrections and quarantines '
            "are listed in the Data view cleansing report; the raw file "
            "was not modified.")


def _print_report(report):
    s = report["source_counts"]
    c = report["cleansed_counts"]
    if report["can_cleanse"]:
        print(f'CLEANSED: {s["customers"]} customers, {s["ledger"]} ledger, '
              f'{s["usage"]} usage, {s["tickets"]} tickets, '
              f'{s["cases"]} cases → {c["customers"]} customers, '
              f'{c["ledger"]} ledger, {c["usage"]} usage, '
              f'{c["tickets"]} tickets, {c["cases"]} cases')
    else:
        print("CANNOT CLEANSE: " + (report["blocked_reason"] or "unknown"))
    print(f'  corrections: {len(report["corrected"])} '
          f'(balances recomputed from the ledger)')
    for corr in report["corrected"]:
        print(f'    CL4: {corr["table"]} {corr["id"]} {corr["field"]}: '
              f'{corr["old_value"]} → {corr["new_value"]}')
    print(f'  quarantined: {len(report["quarantined"])}')
    for q in report["quarantined"]:
        print(f'    {q["rule"]}: {q["table"]} {q["id"]} — {q["reason"]}')
    print(f'  notes: {len(report["notes"])}')
    for n in report["notes"][:10]:
        print(f'    note: {n}')
    if len(report["notes"]) > 10:
        print(f'    ... and {len(report["notes"]) - 10} more')
    v = report["validation"]
    if v is not None:
        print(f'  cleansed file validation: '
              f'{"VALID, 0 errors" if v["valid"] else "INVALID"} '
              f'({len(v["errors"])} errors, {len(v["warnings"])} warnings)')


def main(argv):
    if len(argv) < 2:
        print("usage: python3 server/cleanse.py input.json [output.json]")
        print("       python3 server/cleanse.py --csv-dir DIR [output.json]")
        return 2
    args = argv[1:]
    output = None
    if "--csv-dir" in args:
        idx = args.index("--csv-dir")
        if idx + 1 >= len(args):
            print("error: --csv-dir needs a directory")
            return 2
        d = Path(args[idx + 1])
        rest = args[:idx] + args[idx + 2:]
        if len(rest) > 1:
            print("error: too many arguments — expected --csv-dir DIR "
                  "[output.json]")
            return 2
        if rest:
            output = rest[0]
        if not d.is_dir():
            print(f"error: {d} is not a directory")
            return 2
        files = {p.name: p.read_text(encoding="utf-8")
                 for p in sorted(d.glob("*.csv"))}
        if not files:
            print(f"error: no .csv files in {d}")
            return 2
        cleansed, report = cleanse_csv_files(files)
    else:
        if len(args) > 2:
            print("error: too many arguments — expected input.json "
                  "[output.json]")
            return 2
        path = Path(args[0])
        if len(args) == 2:
            output = args[1]
        if not path.is_file():
            print(f"error: {path} is not a file")
            return 2
        if path.stat().st_size > 5_000_000:
            print("error: D12: file is over 5 MB — bring an anonymised "
                  "sample, not a production dump.")
            return 1
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            print(f"error: {path} is not valid JSON: {exc}")
            return 1
        cleansed, report = cleanse_dataset(data)

    _print_report(report)
    if not report["can_cleanse"] or cleansed is None:
        return 1
    if output:
        Path(output).write_text(json.dumps(cleansed, indent=2) + "\n",
                                encoding="utf-8")
        print(f"wrote production-ready dataset: {output}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
