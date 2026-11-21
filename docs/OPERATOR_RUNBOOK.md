# Operator Runbook — AT&T AI Foundry Medallion Platform

One person runs this whole platform. No 5–6 person engineer team. When
something fails, the failure card tells you what broke, where, and what to
paste into GitHub Copilot. This runbook is the whole job — if it is not in
here, ask Copilot with the prompt on the card.

## The 10-minute daily loop

1. Open the **Medallion** tab. Check the reconciliation line:
   Bronze = Silver passed + quarantined. If it does not add up, stop —
   something is dropping records. That is the one number that must never lie.
2. Click **Run incremental batch**. First run of the day processes new
   records; a second run should show 0 new and everything skipped by the
   watermark. If a run shows retries > 0, read the failure card.
3. Check **Quarantine**. Every quarantined record has a reason and a
   Copilot prompt. Fix the top one (below), re-run the batch, watch the
   record move from quarantine into Silver, then into Gold.
4. Check **Cases**: any run awaiting approval is a human decision, not a
   bug. Approve or reject it; a credit is never posted without approval.
5. Check **Evaluations**: the suite must stay at or above the 85% gate.
   Below 85% means a policy doc or a ledger rule broke — see "Common failures".

## Common failures — and the exact Copilot prompt to fix them

Every failure also appears as a card in the Medallion tab with its prompt
ready to copy. These are the ones you will see most:

| Failure | What it means | Fix (paste the card's prompt into Copilot) |
|---|---|---|
| Duplicate charge quarantined (PIPE-02) | The same customer/service/amount was billed twice within 7 days. This is **expected** on the seed (3 duplicates) — it is not a bug in your code. | No code fix. Confirm the agent case (CASE-1001/1002/1003) and approve the credit. The duplicate stays quarantined; the credit is what reaches Gold. |
| Suspended account with balance (PIPE-01) | A suspended customer still owes money. Expected on the seed (CUST-1004, CUST-1011). | No code fix. Collections / retention owns the balance, not the pipeline. Do not delete the customer — Gold keeps them flagged. |
| Usage references unknown customer (PIPE-03) | A usage record arrived for a customer id that does not exist in CRM. | Paste the card prompt. Copilot will point at `validatePipeline` (PIPE-03) / `validate_pipeline`. Usually the source sent a test id — fix the source feed or add the customer, then re-run. |
| Zero amount / negative usage (PIPE-02/03) | A ledger entry is $0 or a usage value is negative. | Paste the card prompt. Usually a source-system glitch; quarantine holds the record until the source is corrected, then re-run. |
| Unknown pipeline (any) | A run was asked for a pipeline id that does not exist. | Paste the card prompt. Check the pipeline id in the seed (`src/lib/seed.ts`, `server/seed.json`) — a typo in a schedule is the usual cause. |
| Evaluation gate below 85% | A policy doc was deleted or a ledger rule broke. | Run the suite, read which check failed, paste its detail into Copilot with the file `src/lib/engine.ts`, function `runEvalSuite`. Restoring the doc usually fixes it. |
| API returns FUNCTION_INVOCATION_FAILED | A serverless handler crashed on Vercel. | Check the Vercel dashboard function logs for the failing route first. Locally, bundle the handler with esbuild and run it under plain node — if it passes locally, the cause is the deployed environment, not the code. |

## How to re-run after a fix

1. Fix the source (Bronze) or the Silver gate — never Gold.
2. Click **Run incremental batch** in the Medallion tab. The watermark
   skips records already processed, so only new/changed records are
   re-validated. A full rebuild is the same button after a demo reset.
3. Check the record's lineage (type its invoice or customer id in the
   Medallion lineage box): Bronze → Silver passed → Gold included.
4. If the same failure comes back, the fix did not land where the prompt
   said — re-read the card's file + function, not the whole codebase.

## What never to do

- **Never edit Gold directly.** Gold is rebuilt from Silver on every run.
  Editing it by hand is overwritten on the next batch — and hides the
  real problem. Fix Bronze/Silver and re-run.
- **Never delete a quarantined record.** Quarantine is the audit trail.
  A record disappears from Gold by being fixed and re-validated, not by
  being deleted.
- **Never paste an API key into chat, GitHub, or a Copilot prompt.**
  Keys live in environment variables only (`GROQ_API_KEY` in Vercel).
- **Never approve a credit you have not read.** The agent proposes;
  a human approves. The idempotency key stops a double credit, but it
  does not stop a wrong one.
- **Never claim petabyte performance from this demo.** The seed is 106
  records. Petabyte scale is architectural (partitioning, watermarks,
  dedup by idempotency key) — the design is in the README Medallion
  section and `server/medallion.py:spark_job_reference`. It is not
  measured here.

## Scale notes (so the one operator can answer the question)

- Bronze partitions by ingest date + source; Silver by ingest date +
  customer id; Gold by business date. Nothing scans the whole lake.
- Batches are incremental by watermark. A full rebuild is a scheduled
  event, never the default.
- Dedup is by (source id, idempotency key) — the same rule that stops a
  credit being posted twice stops a record being ingested twice.
- Schema changes: Bronze is schema-on-read (raw, immutable). A new
  optional field is additive; a renamed field gets a mapping; a removed
  field is never silently assumed — Silver quarantines records that do
  not conform.
- At petabyte volume the same three functions run on Spark (see
  `GET /medallion/spark-job` and `server/medallion.py`): Auto Loader
  into Bronze, watermark-filtered Silver gates, Gold rebuilt from Silver.
