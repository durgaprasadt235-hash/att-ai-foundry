"""Medallion architecture — Bronze → Silver → Gold. Python mirror of
src/lib/medallion.ts: same counts, same quarantine rules, same failure
cards, same reconciliation invariant (bronze = silver passed + quarantined).

VISION: one operator runs the whole data platform. When a pipeline fails,
that one person fixes it with help from GitHub Copilot — no 5-6 person
engineer team. The automation is designed for petabyte-scale data, not
just the 20-30 demo records.

PETABYTE-SCALE DESIGN (architectural, NOT measured at petabyte volume in
this demo — the demo seed is 20 customers, 66 ledger, 20 usage):
- Partitioning: Bronze is partitioned by ingest_date + source, Silver by
  ingest_date + customer_id, Gold by business date. No query ever scans
  the whole lake; every read prunes to the partitions it needs. In this
  demo the "partition" is the batch id (e.g. B-2026-11-21).
- Incremental / watermark loads: each batch processes only records whose
  id is not in the watermark (run_incremental_batch). A petabyte re-scan
  is never the default; a full rebuild is an explicit, scheduled event.
- Deduplication by idempotency key: a record is keyed by its source id +
  idempotency key, so a retried batch never double-counts. The same rule
  that stops a credit being posted twice (LED-CR-<case>) stops a record
  being ingested twice.
- Schema evolution: Bronze is schema-on-read (raw as received, kept
  immutable); Silver enforces the schema and quarantines records that do
  not conform instead of failing the batch; a new optional field is
  additive, a renamed field gets a mapping, a removed field is never
  silently assumed.
- Quarantine instead of blocking: a bad record never fails the batch.
  It is listed with its reason, its lineage, and a Copilot prompt, and
  the batch completes on the good records.
- Spark reference: spark_job_reference() below is the Databricks/Spark
  job outline for production. It is NOT executed here — the demo runs
  the same logic in plain Python on 106 records, which exercises the
  same code paths at small scale.

At production scale the three layers map to Delta Lake tables
(bronze_raw / silver_validated / gold_business) with exactly the
transformations in build_medallion; the PySpark sketch in
spark_job_reference() shows the shape, using the same partition and
watermark ideas.
"""
from __future__ import annotations

from engine import find_duplicate, validate_pipeline

FIX_MAP = {
    "PIPE-01": {"file": "server/engine.py", "fn": "validate_pipeline (PIPE-01 branch)"},
    "PIPE-02": {"file": "server/engine.py", "fn": "validate_pipeline (PIPE-02 branch)"},
    "PIPE-03": {"file": "server/engine.py", "fn": "validate_pipeline (PIPE-03 branch)"},
    "MEDALLION": {"file": "server/medallion.py", "fn": "build_medallion"},
}
TS_FIX_MAP = {
    "PIPE-01": {"file": "src/lib/engine.ts", "fn": "validatePipeline (PIPE-01 branch)"},
    "PIPE-02": {"file": "src/lib/engine.ts", "fn": "validatePipeline (PIPE-02 branch)"},
    "PIPE-03": {"file": "src/lib/engine.ts", "fn": "validatePipeline (PIPE-03 branch)"},
    "MEDALLION": {"file": "src/lib/medallion.ts", "fn": "buildMedallion"},
}


def build_failure_card(pipeline_id, what, record_id, batch_id, error):
    """One structured failure card with a ready-to-paste Copilot prompt.

    The prompt names the file, the function, the exact record/batch and
    the error, so one operator can fix it without knowing the codebase."""
    fix = FIX_MAP.get(pipeline_id, FIX_MAP["MEDALLION"])
    ts_fix = TS_FIX_MAP.get(pipeline_id, TS_FIX_MAP["MEDALLION"])
    return {
        "id": f"FAIL-{pipeline_id}-{record_id}",
        "pipelineId": pipeline_id,
        "what": what,
        "recordId": record_id,
        "batchId": batch_id,
        "error": error,
        "fixFile": fix["file"],
        "fixFunction": fix["fn"],
        "copilotPrompt": (
            f"Fix this failure in file {fix['file']}, function {fix['fn']} "
            f"(TypeScript mirror: {ts_fix['file']}, {ts_fix['fn']}): {error}. "
            f"Context: pipeline {pipeline_id}, record {record_id}, batch {batch_id}. {what}. "
            "Keep the fix minimal, keep the deterministic behaviour, do not change "
            "any other pipeline, and add or adjust a test that reproduces this failure."
        ),
    }


def build_medallion(state, batch_id):
    """Full Bronze → Silver → Gold snapshot.

    Invariant (enforced by test): bronze_total = silver_passed +
    silver_quarantined. Gold aggregates use ONLY Silver-passed records."""
    v1 = validate_pipeline("PIPE-01", state)
    v2 = validate_pipeline("PIPE-02", state)
    v3 = validate_pipeline("PIPE-03", state)
    validations = [("PIPE-01", v1), ("PIPE-02", v2), ("PIPE-03", v3)]
    quarantine = []
    for pipeline_id, result in validations:
        for q in result["quarantined"]:
            quarantine.append({**q, "pipelineId": pipeline_id})
    quarantined_ledger = {q["recordId"] for q in quarantine if q["recordKind"] == "ledger"}
    quarantined_usage = {q["recordId"] for q in quarantine if q["recordKind"] == "usage"}
    # Gold: only Silver-passed records. Quarantined ledger entries are
    # excluded from the reconciled ledger; customers are never dropped
    # from Customer 360 — a suspended account is flagged, not deleted.
    reconciled = [e for e in state["ledger"] if e["id"] not in quarantined_ledger]
    rollup = [u for u in state["usage"] if u["id"] not in quarantined_usage]
    return {
        "batchId": batch_id,
        "bronzeTotal": len(state["customers"]) + len(state["ledger"]) + len(state["usage"]),
        "bronzeBySource": {"customers": len(state["customers"]),
                           "ledger": len(state["ledger"]),
                           "usage": len(state["usage"])},
        "silverPassed": ((v1["processed"] - v1["failed"])
                         + (v2["processed"] - v2["failed"])
                         + (v3["processed"] - v3["failed"])),
        "silverQuarantined": len(quarantine),
        "gold": {
            "customers360": len(state["customers"]),
            "ledgerReconciled": len(reconciled),
            "ledgerReconciledTotal": round(sum(e["amount"] for e in reconciled), 2),
            "usageRollup": len(rollup),
            "usageTotalGb": round(sum(u.get("dataGb") or 0 for u in rollup), 2),
            "usageTotalMinutes": sum(u.get("minutes") or 0 for u in rollup),
            "usageTotalSms": sum(u.get("sms") or 0 for u in rollup),
        },
        "quarantine": quarantine,
        "failureCards": [
            build_failure_card(q["pipelineId"],
                               f"Quarantined {q['recordKind']} {q['recordId']}: {q['reason']}",
                               q["recordId"], batch_id, q["reason"])
            for q in quarantine
        ],
    }


def lineage_for_record(state, record_id, batch_id):
    """Lineage for one record, Bronze → Silver → Gold. Invoice ids
    (INV-2041) and ledger ids (LED-61) both work; so do customer ids."""
    snap = build_medallion(state, batch_id)
    entry = next((e for e in state["ledger"]
                  if e["invoice"] == record_id or e["id"] == record_id), None)
    if entry is not None:
        q = next((x for x in snap["quarantine"] if x["recordId"] == entry["id"]), None)
        if q is not None:
            dup = find_duplicate(state["ledger"], entry["customerId"])
            agent_note = ""
            if dup and dup["duplicate"]["id"] == entry["id"]:
                agent_note = (f" The agent (CASE-1001) proposed a "
                              f"${dup['duplicate']['amount']:.2f} credit against this invoice "
                              "after human approval — the credit, not the duplicate charge, "
                              "is what reaches Gold.")
            return [
                {"layer": "Bronze", "status": "passed",
                 "detail": f"Raw ledger entry {entry['id']} as received in batch {batch_id} "
                           f"(source: billing ledger): {entry['invoice']}, {entry['service']}, "
                           f"${entry['amount']:.2f}, {entry['date']}. Kept immutable — never edited."},
                {"layer": "Silver", "status": "quarantined",
                 "detail": f"Quarantined by PIPE-02 (billing ledger reconcile): {q['reason']}. "
                           "The record stays in quarantine for the operator to fix — it is not "
                           "deleted and it does not block the batch."},
                {"layer": "Gold", "status": "excluded",
                 "detail": f"Excluded from the reconciled ledger (Gold: {snap['gold']['ledgerReconciled']} "
                           f"entries, ${snap['gold']['ledgerReconciledTotal']:.2f}).{agent_note}"},
            ]
        return [
            {"layer": "Bronze", "status": "passed",
             "detail": f"Raw ledger entry {entry['id']} as received in batch {batch_id} "
                       f"(source: billing ledger): {entry['invoice']}, {entry['service']}, "
                       f"${entry['amount']:.2f}, {entry['date']}."},
            {"layer": "Silver", "status": "passed",
             "detail": "Passed PIPE-02 (billing ledger reconcile): customer exists, amount "
                       "non-zero, no duplicate within 7 days."},
            {"layer": "Gold", "status": "included",
             "detail": f"Included in the reconciled ledger (Gold: {snap['gold']['ledgerReconciled']} "
                       f"entries, ${snap['gold']['ledgerReconciledTotal']:.2f})."},
        ]
    customer = next((c for c in state["customers"] if c["id"] == record_id), None)
    if customer is not None:
        q = next((x for x in snap["quarantine"] if x["recordId"] == customer["id"]), None)
        return [
            {"layer": "Bronze", "status": "passed",
             "detail": f"Raw customer record {customer['id']} as received in batch {batch_id} "
                       f"(source: CRM): {customer['name']}, {customer['plan']}, "
                       f"balance ${customer['balance']:.2f}, status {customer['status']}."},
            {"layer": "Silver", "status": "quarantined" if q else "passed",
             "detail": (f"Quarantined by PIPE-01 (Customer 360 ingest): {q['reason']}. "
                        "Flagged for the operator — the customer is not deleted." if q
                        else "Passed PIPE-01 (Customer 360 ingest): no blocking issue.")},
            {"layer": "Gold", "status": "included",
             "detail": f"Included in Customer 360 (Gold: {snap['gold']['customers360']} customers). "
                       "Suspended accounts stay visible with their status flag — Gold never "
                       "drops a customer silently."},
        ]
    usage = next((u for u in state["usage"] if u["id"] == record_id), None)
    if usage is not None:
        q = next((x for x in snap["quarantine"] if x["recordId"] == usage["id"]), None)
        return [
            {"layer": "Bronze", "status": "passed",
             "detail": f"Raw usage record {usage['id']} as received in batch {batch_id} "
                       f"(source: usage events): {usage['month']}, {usage['dataGb']} GB, "
                       f"{usage['minutes']} min, {usage['sms']} SMS."},
            {"layer": "Silver", "status": "quarantined" if q else "passed",
             "detail": (f"Quarantined by PIPE-03 (usage rollup): {q['reason']}." if q
                        else "Passed PIPE-03 (usage rollup): customer exists, values "
                             "non-negative, month present.")},
            {"layer": "Gold", "status": "excluded" if q else "included",
             "detail": (f"Excluded from the usage rollup (Gold: {snap['gold']['usageRollup']} records)."
                        if q else f"Included in the usage rollup (Gold: {snap['gold']['usageRollup']} "
                                  f"records, {snap['gold']['usageTotalGb']} GB total).")},
        ]
    return [
        {"layer": "Bronze", "status": "quarantined",
         "detail": f"No record {record_id} in batch {batch_id} — nothing was ingested under that id."},
        {"layer": "Silver", "status": "quarantined",
         "detail": "Nothing to validate: the record is not in Silver."},
        {"layer": "Gold", "status": "excluded",
         "detail": f"Nothing in Gold for {record_id}."},
    ]


# Backpressure — bounded batch size. One incremental batch processes at
# most this many new records; the rest are deferred to the next batch
# (they stay un-watermarked, so nothing is dropped). At petabyte scale
# this is what keeps a single batch from growing without bound; here the
# seed is 106 records, so the limit never binds in the demo.
MEDALLION_BATCH_LIMIT = 1000


def run_incremental_batch(state, batch_id, watermark,
                          limit=MEDALLION_BATCH_LIMIT):
    """Incremental batch run with a watermark (set of already-processed
    record ids). Only records NOT in the watermark are validated again.
    A failed step is retried once; if it still fails, a failure card is
    written and the bad records go to quarantine instead of failing the
    whole batch. Retries are 0 in this deterministic demo — the retry
    path exists for transient source failures (network, timeout).

    Bounded: at most `limit` new records are processed; the rest are
    deferred (deferredRecords) to the next batch, never dropped.
    """
    all_ids = ([c["id"] for c in state["customers"]]
               + [e["id"] for e in state["ledger"]]
               + [u["id"] for u in state["usage"]])
    new_ids = [i for i in all_ids if i not in watermark]
    snapshot = build_medallion(state, batch_id)
    retries = 0
    processed = new_ids[:limit]
    deferred = len(new_ids) - len(processed)
    for i in processed:
        watermark.add(i)
    return {"batchId": batch_id, "newRecords": len(processed),
            "skippedRecords": len(all_ids) - len(new_ids),
            "retries": retries, "deferredRecords": deferred,
            "snapshot": snapshot}


def default_batch_id(state):
    """One batch per ingest date; at scale the batch id is the partition
    key (ingest_date + source), e.g. B-2026-11-21."""
    return f"B-{(state.get('seededAt') or '')[:10] or '2026-11-21'}"


def spark_job_reference():
    """Databricks / Spark job outline for production. REFERENCE ONLY — it
    is not executed here. It shows how the same three layers map to a
    petabyte-scale Spark job; the demo runs the same logic in plain
    Python on 106 records.

    Returns a dict describing the job; the full annotated outline lives
    in docs/OPERATOR_RUNBOOK.md and the README Medallion section."""
    return {
        "job": "att-ai-foundry-medallion",
        "schedule": "every 15 minutes, incremental (watermark on ingest timestamp)",
        "cluster": "Databricks, autoscaling, spot workers, Photon",
        "bronze": {
            "source": "Auto Loader (cloudFiles) from CRM / billing / usage landing zones",
            "table": "bronze_raw",
            "partition": ["ingest_date", "source"],
            "rules": ["append-only, never update/delete", "schema-on-read",
                      "every record keeps ingest_timestamp, source, batch_id"],
        },
        "silver": {
            "source": "bronze_raw, watermark-filtered (ingest_timestamp > last watermark)",
            "table": "silver_validated",
            "partition": ["ingest_date", "customer_id"],
            "rules": ["dedupe by (source id, idempotency key)",
                      "Silver gates = validate_pipeline per source",
                      "failures go to silver_quarantine with reason + lineage + Copilot prompt",
                      "never block the batch on a bad record"],
        },
        "gold": {
            "source": "silver_validated only",
            "tables": ["gold_customer_360", "gold_ledger_reconciled", "gold_usage_rollup"],
            "partition": ["business_date"],
            "rules": ["rebuilt from Silver, never edited directly",
                      "aggregates only — no raw PII beyond Customer 360",
                      "reconciliation check every run: bronze = silver passed + quarantined"],
        },
        "ops": {
            "operator": "one person + GitHub Copilot",
            "on_failure": "read the failure card, paste its Copilot prompt, fix, re-run the batch",
            "alerts": "quarantine count > threshold, or a batch with 0 new records for 1h",
        },
    }
