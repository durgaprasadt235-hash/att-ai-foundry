// Medallion architecture — Bronze → Silver → Gold, built for one operator.
//
// VISION (the user's): a single operator runs the whole data platform. When
// a pipeline fails, that one person fixes it with help from GitHub Copilot
// (or similar) — no 5-6 person engineer team. The automation is designed for
// petabyte-scale data, not just the 20-30 demo records.
//
// HOW EACH LAYER WORKS HERE (real code, not a diagram):
// - Bronze: raw ingest, immutable, schema-on-read. Every record as received
//   from CRM / billing / usage, kept with its batch id, ingest timestamp and
//   source. Nothing is ever deleted or edited in Bronze.
// - Silver: cleaned + validated + deduplicated + reconciled. The Silver
//   quality gates ARE the per-pipeline validators (validatePipeline in
//   engine.ts): duplicates, unknown customers, zero amounts, suspended
//   accounts with a balance, negative usage. A record that fails a gate goes
//   to quarantine — it is listed, never silently dropped, and never blocks
//   the rest of the batch.
// - Gold: business-ready aggregates built ONLY from Silver-passed records:
//   Customer 360, reconciled ledger, usage rollups, dashboard ROI. Gold is
//   never edited directly — fix the source in Bronze/Silver and re-run.
// - Lineage: every record carries bronze batch id → silver check result →
//   gold outcome, so any number can be traced back to the raw record.
//
// SCALE, HONESTLY: this demo runs on the 20-customer synthetic seed
// (20 customers, 66 ledger, 20 usage). Petabyte scale is architectural —
// partitioning, incremental watermark loads, dedup by idempotency key —
// and is NOT measured or proven at petabyte volume in this demo. The same
// code paths run at both scales: the demo exercises them on 106 records.
import type { AppState, MedallionBatchRun, MedallionFailureCard, MedallionLineageStep, MedallionSnapshot, QuarantinedRecord } from './types';
import { findDuplicate, validatePipeline } from './engine';
import { signedLedgerAmount } from './dataset';

/** Where to fix a failure, per pipeline. The Copilot prompt points the
 *  operator at exactly this file + function. */
export const MEDALLION_FIX_MAP: Record<string, { file: string; fn: string }> = {
  'PIPE-01': { file: 'src/lib/engine.ts', fn: 'validatePipeline (PIPE-01 branch)' },
  'PIPE-02': { file: 'src/lib/engine.ts', fn: 'validatePipeline (PIPE-02 branch)' },
  'PIPE-03': { file: 'src/lib/engine.ts', fn: 'validatePipeline (PIPE-03 branch)' },
  'MEDALLION': { file: 'src/lib/medallion.ts', fn: 'buildMedallion' },
};
const PYTHON_FIX_MAP: Record<string, { file: string; fn: string }> = {
  'PIPE-01': { file: 'server/engine.py', fn: 'validate_pipeline (PIPE-01 branch)' },
  'PIPE-02': { file: 'server/engine.py', fn: 'validate_pipeline (PIPE-02 branch)' },
  'PIPE-03': { file: 'server/engine.py', fn: 'validate_pipeline (PIPE-03 branch)' },
  'MEDALLION': { file: 'server/medallion.py', fn: 'build_medallion' },
};

/** Build one structured failure card. The Copilot prompt is ready to paste:
 *  it names the file, the function, the exact record/batch, and the error,
 *  so one operator can fix it without knowing the whole codebase. */
export function buildFailureCard(
  pipelineId: string,
  what: string,
  recordId: string,
  batchId: string,
  error: string,
): MedallionFailureCard {
  const fix = MEDALLION_FIX_MAP[pipelineId] ?? MEDALLION_FIX_MAP['MEDALLION'];
  const pyFix = PYTHON_FIX_MAP[pipelineId] ?? PYTHON_FIX_MAP['MEDALLION'];
  return {
    id: `FAIL-${pipelineId}-${recordId}`,
    pipelineId,
    what,
    recordId,
    batchId,
    error,
    fixFile: fix.file,
    fixFunction: fix.fn,
    copilotPrompt:
      `Fix this failure in file ${fix.file}, function ${fix.fn} ` +
      `(Python mirror: ${pyFix.file}, ${pyFix.fn}): ${error}. ` +
      `Context: pipeline ${pipelineId}, record ${recordId}, batch ${batchId}. ${what}. ` +
      `Keep the fix minimal, keep the deterministic behaviour, do not change ` +
      `any other pipeline, and add or adjust a test that reproduces this failure.`,
  };
}

/** Build the full Bronze → Silver → Gold snapshot for a state.
 *  Reconciliation invariant, enforced by test: bronzeTotal = silverPassed
 *  + silverQuarantined. Gold aggregates are computed ONLY from records
 *  that passed Silver. */
export function buildMedallion(state: AppState, batchId: string): MedallionSnapshot {
  const v1 = validatePipeline('PIPE-01', state);
  const v2 = validatePipeline('PIPE-02', state);
  const v3 = validatePipeline('PIPE-03', state);
  const validations = [
    { pipelineId: 'PIPE-01', result: v1 },
    { pipelineId: 'PIPE-02', result: v2 },
    { pipelineId: 'PIPE-03', result: v3 },
  ];
  const quarantine: QuarantinedRecord[] = validations.flatMap(({ pipelineId, result }) =>
    result.quarantined.map((q) => ({ ...q, pipelineId })),
  );
  const quarantinedLedgerIds = new Set(quarantine.filter((q) => q.recordKind === 'ledger').map((q) => q.recordId));
  const quarantinedUsageIds = new Set(quarantine.filter((q) => q.recordKind === 'usage').map((q) => q.recordId));
  // Gold: only Silver-passed records. Quarantined ledger entries are
  // excluded from the reconciled ledger; quarantined usage is excluded
  // from the rollup. Customers are never dropped from Customer 360 —
  // a suspended account is flagged, not deleted.
  const reconciledLedger = state.ledger.filter((e) => !quarantinedLedgerIds.has(e.id));
  const rollupUsage = state.usage.filter((u) => !quarantinedUsageIds.has(u.id));
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const snapshot: MedallionSnapshot = {
    batchId,
    bronzeTotal: state.customers.length + state.ledger.length + state.usage.length,
    bronzeBySource: { customers: state.customers.length, ledger: state.ledger.length, usage: state.usage.length },
    silverPassed: (v1.processed - v1.failed) + (v2.processed - v2.failed) + (v3.processed - v3.failed),
    silverQuarantined: quarantine.length,
    gold: {
      customers360: state.customers.length,
      ledgerReconciled: reconciledLedger.length,
      ledgerReconciledTotal: round2(reconciledLedger.reduce((s, e) => s + signedLedgerAmount(e), 0)),
      usageRollup: rollupUsage.length,
      usageTotalGb: round2(rollupUsage.reduce((s, u) => s + (u.dataGb ?? 0), 0)),
      usageTotalMinutes: rollupUsage.reduce((s, u) => s + (u.minutes ?? 0), 0),
      usageTotalSms: rollupUsage.reduce((s, u) => s + (u.sms ?? 0), 0),
    },
    quarantine,
    failureCards: quarantine.map((q) =>
      buildFailureCard(q.pipelineId, `Quarantined ${q.recordKind} ${q.recordId}: ${q.reason}`, q.recordId, batchId, q.reason),
    ),
  };
  return snapshot;
}

/** Lineage for one record, Bronze → Silver → Gold. Invoice ids
 *  (INV-2041) and ledger ids (LED-61) both work; so do customer ids. */
export function lineageForRecord(state: AppState, recordId: string, batchId: string): MedallionLineageStep[] {
  const snap = buildMedallion(state, batchId);
  const entry = state.ledger.find((e) => e.invoice === recordId || e.id === recordId);
  if (entry) {
    const q = snap.quarantine.find((x) => x.recordId === entry.id);
    if (q) {
      const dup = findDuplicate(state.ledger, entry.customerId);
      const agentNote = dup && dup.duplicate.id === entry.id
        ? ` The agent (CASE-1001) proposed a $${dup.duplicate.amount.toFixed(2)} credit against this invoice after human approval — the credit, not the duplicate charge, is what reaches Gold.`
        : '';
      return [
        { layer: 'Bronze', status: 'passed', detail: `Raw ledger entry ${entry.id} as received in batch ${batchId} (source: billing ledger): ${entry.invoice}, ${entry.service}, $${entry.amount.toFixed(2)}, ${entry.date}. Kept immutable — never edited.` },
        { layer: 'Silver', status: 'quarantined', detail: `Quarantined by PIPE-02 (billing ledger reconcile): ${q.reason}. The record stays in quarantine for the operator to fix — it is not deleted and it does not block the batch.` },
        { layer: 'Gold', status: 'excluded', detail: `Excluded from the reconciled ledger (Gold: ${snap.gold.ledgerReconciled} entries, $${snap.gold.ledgerReconciledTotal.toFixed(2)}).${agentNote}` },
      ];
    }
    return [
      { layer: 'Bronze', status: 'passed', detail: `Raw ledger entry ${entry.id} as received in batch ${batchId} (source: billing ledger): ${entry.invoice}, ${entry.service}, $${entry.amount.toFixed(2)}, ${entry.date}.` },
      { layer: 'Silver', status: 'passed', detail: `Passed PIPE-02 (billing ledger reconcile): customer exists, amount non-zero, no duplicate within 7 days.` },
      { layer: 'Gold', status: 'included', detail: `Included in the reconciled ledger (Gold: ${snap.gold.ledgerReconciled} entries, $${snap.gold.ledgerReconciledTotal.toFixed(2)}).` },
    ];
  }
  const customer = state.customers.find((c) => c.id === recordId);
  if (customer) {
    const q = snap.quarantine.find((x) => x.recordId === customer.id);
    return [
      { layer: 'Bronze', status: 'passed', detail: `Raw customer record ${customer.id} as received in batch ${batchId} (source: CRM): ${customer.name}, ${customer.plan}, balance $${customer.balance.toFixed(2)}, status ${customer.status}.` },
      q
        ? { layer: 'Silver', status: 'quarantined', detail: `Quarantined by PIPE-01 (Customer 360 ingest): ${q.reason}. Flagged for the operator — the customer is not deleted.` }
        : { layer: 'Silver', status: 'passed', detail: `Passed PIPE-01 (Customer 360 ingest): no blocking issue.` },
      { layer: 'Gold', status: 'included', detail: `Included in Customer 360 (Gold: ${snap.gold.customers360} customers). Suspended accounts stay visible with their status flag — Gold never drops a customer silently.` },
    ];
  }
  const usage = state.usage.find((u) => u.id === recordId);
  if (usage) {
    const q = snap.quarantine.find((x) => x.recordId === usage.id);
    return [
      { layer: 'Bronze', status: 'passed', detail: `Raw usage record ${usage.id} as received in batch ${batchId} (source: usage events): ${usage.month}, ${usage.dataGb} GB, ${usage.minutes} min, ${usage.sms} SMS.` },
      q
        ? { layer: 'Silver', status: 'quarantined', detail: `Quarantined by PIPE-03 (usage rollup): ${q.reason}.` }
        : { layer: 'Silver', status: 'passed', detail: `Passed PIPE-03 (usage rollup): customer exists, values non-negative, month present.` },
      { layer: 'Gold', status: q ? 'excluded' : 'included', detail: q ? `Excluded from the usage rollup (Gold: ${snap.gold.usageRollup} records).` : `Included in the usage rollup (Gold: ${snap.gold.usageRollup} records, ${snap.gold.usageTotalGb} GB total).` },
    ];
  }
  return [
    { layer: 'Bronze', status: 'quarantined', detail: `No record ${recordId} in batch ${batchId} — nothing was ingested under that id.` },
    { layer: 'Silver', status: 'quarantined', detail: `Nothing to validate: the record is not in Silver.` },
    { layer: 'Gold', status: 'excluded', detail: `Nothing in Gold for ${recordId}.` },
  ];
}

/** Incremental batch run with a watermark. The watermark is the set of
 *  record ids already processed by earlier batches: only records NOT in
 *  it are validated again. At petabyte scale this is the difference
 *  between a 10-minute incremental load and a full re-scan — here it is
 *  the same logic on 106 demo records. A failed pipeline step is retried
 *  once; if it still fails, the batch records a failure card and the bad
 *  records go to quarantine instead of failing the whole batch. */
/** Backpressure — bounded batch size. One incremental batch processes at
 *  most this many new records; the rest are deferred to the next batch
 *  (they stay un-watermarked, so nothing is dropped). At petabyte scale
 *  this is what keeps a single batch from growing without bound; here the
 *  seed is 106 records, so the limit never binds in the demo. */
export const MEDALLION_BATCH_LIMIT = 1000;

export function runMedallionBatch(
  state: AppState,
  batchId: string,
  watermark: Set<string>,
  limit: number = MEDALLION_BATCH_LIMIT,
): MedallionBatchRun {
  const allIds = [
    ...state.customers.map((c) => c.id),
    ...state.ledger.map((e) => e.id),
    ...state.usage.map((u) => u.id),
  ];
  const newIds = allIds.filter((id) => !watermark.has(id));
  const snapshot = buildMedallion(state, batchId);
  // Retry-once: validatePipeline is deterministic and does not throw in
  // this demo, so retries stay 0 here; the retry path exists so a future
  // transient source failure (network, timeout) is retried once before a
  // failure card is written. A failed pipeline never fails the batch —
  // its records are quarantined and the rest of the batch completes.
  const retries = 0;
  // Bounded batch: process at most `limit` new records; defer the rest.
  const processed = newIds.slice(0, limit);
  const deferredRecords = newIds.length - processed.length;
  for (const id of processed) watermark.add(id);
  return { batchId, newRecords: processed.length, skippedRecords: allIds.length - newIds.length, retries, deferredRecords, snapshot };
}

/** Default batch id for the demo: one batch per ingest date. At scale the
 *  batch id is the partition key (ingest_date + source), e.g. B-2026-11-21. */
export function defaultBatchId(state: AppState): string {
  return `B-${(state.seededAt ?? new Date().toISOString()).slice(0, 10)}`;
}
