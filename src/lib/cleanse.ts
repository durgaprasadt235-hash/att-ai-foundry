// Raw-upload auto-cleanse — the Bronze → Silver step of the upload flow.
//
// The user's process: a file needs to be uploaded anyway, raw or
// cleansed — that IS the process. Raw data goes through automated
// cleansing and comes out as a production-ready usage file. So the Data
// view never rejects a file for data errors: the validation report
// (rules D1–D12, lib/dataset.ts) is a pre-check, and this module turns
// the raw tables into a cleansed dataset that passes validation with
// 0 errors. The raw file is never edited — cleansing produces a new,
// separate tables object; the original file on the user's disk and the
// built-in seed are never touched.
//
// Cleansing rules CL1–CL8 (the Python mirror server/cleanse.py
// implements the SAME rules with the SAME numbering):
//
//   CL1 Duplicate ids — keep the first occurrence, quarantine the rest.
//       Applies per table (customers, ledger, usage, tickets, cases,
//       docs, stairTrees) and to STAIR leaf ids across trees.
//   CL2 Invalid record — a missing/invalid required field or an unknown
//       enum value (D4/D5) quarantines the record. Nothing is guessed:
//       a customer without a name, a ledger entry with an unknown kind,
//       a usage row with a negative number — all quarantined, listed.
//   CL3 Dangling reference — a ledger / usage / ticket / case whose
//       customerId names no kept customer (D6) is quarantined. This
//       runs after CL2, so records of a quarantined customer cascade
//       here and are listed with that reason.
//   CL4 Balance mismatch — the ledger is the source of truth. A
//       customer's balance is recomputed from their kept POSTED ledger
//       entries (kind-based signs: charge adds, credit/payment
//       subtract) and corrected; every correction is recorded as
//       old → new. This is a fix, not a silent one — it is listed.
//   CL5 Zero-amount ledger entries — kept (they contribute $0.00),
//       noted in the report.
//   CL6 Suspended-with-balance customers — kept (Silver quarantines
//       them at run time), noted in the report.
//   CL7 Duplicate charges — kept (they drive the billing journey),
//       noted in the report.
//   CL8 Unfixable — anything the rules above cannot make valid is
//       quarantined, never guessed. The cleansed tables are re-validated
//       (D1–D12) before they are returned: if they still fail, the
//       cleanse is refused and the remaining errors are reported.
//
// What can never be cleansed (the load is refused, nothing half-loaded):
//   - D1 structural failure — not an object, a required table missing
//     or not an array, a CSV that cannot be parsed (no raw tables to
//     start from), a file over 5 MB (D12, rejected at upload).
//   - D2 — no customers at all, or no valid customers left after
//     quarantining.
//
// Every correction and every quarantined record is listed in the
// CleanseReport. Nothing is fixed silently, nothing is dropped silently.
import {
  CASE_TYPES,
  signedLedgerAmount,
  validateDatasetJson,
  type DatasetTables,
  type DatasetValidation,
} from './dataset';
import { sortCustomersByName } from './customer-search';

export interface CleanseCorrection {
  table: string;
  id: string;
  field: string;
  oldValue: string;
  newValue: string;
  rule: string;
}

export interface QuarantinedRecord {
  table: string;
  id: string;
  rule: string;
  reason: string;
}

export interface CleanseReport {
  /** False when the file cannot be cleansed (see blockedReason). */
  canCleanse: boolean;
  blockedReason?: string;
  sourceCounts: Record<string, number>;
  cleansedCounts: Record<string, number>;
  /** Balance corrections (CL4) — old → new, one entry per customer. */
  corrected: CleanseCorrection[];
  /** Records removed from the cleansed set, with the rule and reason. */
  quarantined: QuarantinedRecord[];
  /** Kept-but-noted items (CL5/CL6/CL7, auto-fills, re-validation
   *  warnings on the cleansed set) — shown, never hidden. */
  notes: string[];
  /** The raw file's validation errors (the pre-check report). */
  rawErrors: string[];
  /** The raw file's validation warnings. */
  rawWarnings: string[];
  /** Validation of the cleansed tables — 0 errors whenever canCleanse. */
  validation: DatasetValidation | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const CUSTOMER_STATUSES = ['active', 'suspended', 'closed'];
const LEDGER_KINDS = ['charge', 'credit', 'payment'];
const LEDGER_STATUSES = ['posted', 'reversed'];
const TICKET_STATUSES = ['open', 'resolved'];

const TABLE_KEYS = ['customers', 'ledger', 'usage', 'tickets', 'cases', 'docs', 'stairTrees'] as const;

function countsOf(t: DatasetTables): Record<string, number> {
  return {
    customers: t.customers.length, ledger: t.ledger.length, usage: t.usage.length,
    tickets: t.tickets.length, cases: t.cases.length, docs: t.docs.length,
    orders: (t.orders ?? []).length, stairTrees: t.stairTrees.length,
  };
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** One deterministic validity check per table, mirroring the
 *  validator's D4/D5. Returns null when the record is usable, or the
 *  reason it must be quarantined (CL2). */
function recordProblem(table: string, row: unknown): string | null {
  if (!isObj(row)) return 'record is not an object';
  switch (table) {
    case 'customers':
      if (!isNonEmptyStr(row.id)) return 'missing "id"';
      if (!isNonEmptyStr(row.name)) return 'missing "name"';
      if (!isNonEmptyStr(row.account)) return 'missing "account"';
      if (!isNonEmptyStr(row.plan)) return 'missing "plan"';
      if (!isFiniteNum(row.balance)) return 'non-numeric "balance"';
      if (!CUSTOMER_STATUSES.includes(row.status as string)) return `unknown status ${JSON.stringify(row.status)}`;
      if (!isNonEmptyStr(row.since)) return 'missing "since"';
      return null;
    case 'ledger':
      if (!isNonEmptyStr(row.id)) return 'missing "id"';
      if (!isNonEmptyStr(row.customerId)) return 'missing "customerId"';
      if (!isNonEmptyStr(row.invoice)) return 'missing "invoice"';
      if (!isNonEmptyStr(row.service)) return 'missing "service"';
      if (!isFiniteNum(row.amount)) return 'non-numeric "amount"';
      if (!LEDGER_KINDS.includes(row.kind as string)) return `unknown kind ${JSON.stringify(row.kind)}`;
      if (!LEDGER_STATUSES.includes(row.status as string)) return `unknown status ${JSON.stringify(row.status)}`;
      return null;
    case 'usage':
      if (!isNonEmptyStr(row.id)) return 'missing "id"';
      if (!isNonEmptyStr(row.customerId)) return 'missing "customerId"';
      if (!isNonEmptyStr(row.month)) return 'missing "month"';
      for (const f of ['dataGb', 'minutes', 'sms']) {
        if (!isFiniteNum(row[f])) return `non-numeric "${f}"`;
        if ((row[f] as number) < 0) return `negative "${f}" (${row[f]})`;
      }
      return null;
    case 'tickets':
      if (!isNonEmptyStr(row.id)) return 'missing "id"';
      if (!isNonEmptyStr(row.customerId)) return 'missing "customerId"';
      if (!isNonEmptyStr(row.subject)) return 'missing "subject"';
      if (!TICKET_STATUSES.includes(row.status as string)) return `unknown status ${JSON.stringify(row.status)}`;
      return null;
    case 'cases':
      if (!isNonEmptyStr(row.id)) return 'missing "id"';
      if (!isNonEmptyStr(row.customerId)) return 'missing "customerId"';
      if (!CASE_TYPES.includes(row.type as never)) return `unknown type ${JSON.stringify(row.type)}`;
      if (!isNonEmptyStr(row.title)) return 'missing "title"';
      if (!isFiniteNum(row.amount)) return 'non-numeric "amount"';
      return null;
    case 'docs':
      if (!isNonEmptyStr(row.id)) return 'missing "id"';
      if (!isNonEmptyStr(row.title)) return 'missing "title"';
      if (!isNonEmptyStr(row.body)) return 'missing "body"';
      return null;
    case 'stairTrees':
      if (!isNonEmptyStr(row.id)) return 'missing "id"';
      if (!isNonEmptyStr(row.title)) return 'missing "title"';
      if (!Array.isArray(row.leaves)) return 'missing "leaves" array';
      return null;
    default:
      return null;
  }
}

function leafProblem(leaf: unknown): string | null {
  if (!isObj(leaf)) return 'leaf is not an object';
  if (!isNonEmptyStr(leaf.id)) return 'missing "id"';
  if (!isNonEmptyStr(leaf.title)) return 'missing "title"';
  if (!isNonEmptyStr(leaf.path)) return 'missing "path"';
  if (!isNonEmptyStr(leaf.body)) return 'missing "body"';
  return null;
}

function rowId(row: unknown): string {
  return isObj(row) && isNonEmptyStr(row.id) ? row.id : '?';
}

/** Cleanse raw tables into a production-ready dataset. The input is
 *  never mutated — the cleansed tables are a deep copy. Returns
 *  cleansed: null when the file cannot be cleansed (blockedReason). */
export function cleanseTables(raw: DatasetTables): { cleansed: DatasetTables | null; report: CleanseReport } {
  const report: CleanseReport = {
    canCleanse: false,
    sourceCounts: countsOf(raw),
    cleansedCounts: { customers: 0, ledger: 0, usage: 0, tickets: 0, cases: 0, docs: 0, orders: 0, stairTrees: 0 },
    corrected: [],
    quarantined: [],
    notes: [],
    rawErrors: [],
    rawWarnings: [],
    validation: null,
  };

  // D2 — nothing to cleanse without customers.
  if (!Array.isArray(raw.customers) || raw.customers.length === 0) {
    report.blockedReason = 'D2: the file has no customers — there is nothing to cleanse.';
    return { cleansed: null, report };
  }

  // Work on a deep copy; the raw tables (and the user's file) are never
  // modified. JSON round-trip is safe here: tables are plain JSON data
  // (undefined-valued keys are dropped, which the validator treats as
  // missing and fills deterministically).
  const work = JSON.parse(JSON.stringify(raw)) as DatasetTables;
  for (const k of TABLE_KEYS) {
    if (!Array.isArray((work as unknown as Record<string, unknown>)[k])) (work as unknown as Record<string, unknown>)[k] = [];
  }
  if (!Array.isArray(work.orders)) work.orders = [];
  // Cleansed output loads A–Z by customer name, like every other load
  // path — the production-ready file is sorted too.
  work.customers = sortCustomersByName(work.customers);

  // Raw validation = the pre-check report. It also applies the
  // deterministic fills (case status, idempotencyKey, createdAt, ticket
  // status/date, doc updated, stair autoGenerated) to the working copy;
  // those fills are listed in the report, never silent.
  const { validation: rawV } = validateDatasetJson(work);
  report.rawErrors = rawV.errors;
  report.rawWarnings = rawV.warnings;
  for (const f of rawV.filled) report.notes.push(`Auto-filled: ${f}`);

  // Fast path — already valid: nothing to correct or quarantine.
  if (rawV.valid) {
    report.canCleanse = true;
    report.validation = rawV;
    report.cleansedCounts = countsOf(work);
    // The file's own warnings (duplicate charges, suspended-with-balance)
    // are still notes: those records are kept, and the report says so.
    for (const w of rawV.warnings) report.notes.push(w);
    return { cleansed: work, report };
  }

  // CL1 — duplicate ids: keep the first occurrence, quarantine the rest.
  for (const key of TABLE_KEYS) {
    const seen = new Set<string>();
    const kept: unknown[] = [];
    for (const row of (work[key] as unknown[])) {
      if (isObj(row) && isNonEmptyStr(row.id)) {
        if (seen.has(row.id)) {
          report.quarantined.push({ table: key, id: row.id, rule: 'CL1', reason: `duplicate id "${row.id}" in ${key} — kept the first occurrence.` });
          continue;
        }
        seen.add(row.id);
      }
      kept.push(row);
    }
    (work as unknown as Record<string, unknown[]>)[key] = kept;
  }
  // CL1 — STAIR leaf ids are unique across trees: keep the first leaf.
  {
    const seenLeafIds = new Set<string>();
    for (const tree of work.stairTrees) {
      if (!isObj(tree) || !Array.isArray(tree.leaves)) continue;
      const keptLeaves: unknown[] = [];
      for (const leaf of tree.leaves) {
        if (isObj(leaf) && isNonEmptyStr(leaf.id)) {
          if (seenLeafIds.has(leaf.id)) {
            report.quarantined.push({ table: 'stairTrees', id: leaf.id, rule: 'CL1', reason: `duplicate STAIR leaf id "${leaf.id}" across trees — kept the first occurrence.` });
            continue;
          }
          seenLeafIds.add(leaf.id);
        }
        keptLeaves.push(leaf);
      }
      tree.leaves = keptLeaves as never;
    }
  }

  // CL2 — invalid records are quarantined, never guessed.
  for (const key of TABLE_KEYS) {
    const kept: unknown[] = [];
    for (const row of (work[key] as unknown[])) {
      const problem = recordProblem(key, row);
      if (problem) {
        report.quarantined.push({ table: key, id: rowId(row), rule: 'CL2', reason: problem });
        continue;
      }
      // A STAIR tree whose leaves are all invalid loses the tree itself.
      if (key === 'stairTrees' && isObj(row) && Array.isArray(row.leaves)) {
        const keptLeaves: unknown[] = [];
        for (const leaf of row.leaves as unknown[]) {
          const lp = leafProblem(leaf);
          if (lp) {
            report.quarantined.push({ table: 'stairTrees', id: rowId(leaf), rule: 'CL2', reason: `STAIR leaf in tree ${rowId(row)}: ${lp}` });
            continue;
          }
          keptLeaves.push(leaf);
        }
        if (keptLeaves.length === 0) {
          report.quarantined.push({ table: 'stairTrees', id: rowId(row), rule: 'CL2', reason: 'no valid leaves remain after quarantining invalid leaves' });
          continue;
        }
        row.leaves = keptLeaves as never;
      }
      kept.push(row);
    }
    (work as unknown as Record<string, unknown[]>)[key] = kept;
  }

  // No valid customers left → nothing to cleanse (D2).
  if (work.customers.length === 0) {
    report.blockedReason = 'D2: no valid customers remain after quarantining invalid records — there is nothing to cleanse.';
    return { cleansed: null, report };
  }

  // CL3 — dangling references: quarantine records naming a customer that
  // is not in the kept set (including customers quarantined above).
  const customerIds = new Set(work.customers.map((c) => c.id));
  for (const key of ['ledger', 'usage', 'tickets', 'cases'] as const) {
    const kept: unknown[] = [];
    for (const row of (work[key] as unknown[])) {
      const cid = isObj(row) ? row.customerId : undefined;
      if (typeof cid === 'string' && !customerIds.has(cid)) {
        report.quarantined.push({ table: key, id: rowId(row), rule: 'CL3', reason: `references unknown customer ${cid}` });
        continue;
      }
      kept.push(row);
    }
    (work as unknown as Record<string, unknown[]>)[key] = kept;
  }

  // CL4 — balances: the ledger is the source of truth. Recompute each
  // kept customer's balance from their kept POSTED ledger entries and
  // correct it, recording old → new.
  for (const c of work.customers) {
    const computed = work.ledger
      .filter((e) => e.customerId === c.id && e.status === 'posted')
      .reduce((s, e) => s + signedLedgerAmount(e), 0);
    const rounded = Math.round(computed * 100) / 100;
    if (Math.abs(rounded - c.balance) >= 0.01) {
      report.corrected.push({
        table: 'customers', id: c.id, field: 'balance',
        oldValue: money(c.balance), newValue: money(rounded), rule: 'CL4',
      });
      c.balance = rounded;
    }
  }

  // CL8 — re-validate the cleansed tables. They must pass D1–D12 with
  // 0 errors, or the cleanse is refused and the remaining errors are
  // reported. (CL5/CL6/CL7 are the kept-but-noted items: zero-amount
  // entries, suspended-with-balance customers and duplicate charges
  // stay in the cleansed set — the re-validation lists them as
  // warnings, which become report notes below.)
  const { validation: cleanV, tables: cleanTables } = validateDatasetJson(work);
  report.validation = cleanV;
  if (!cleanV.valid || !cleanTables) {
    const remaining = cleanV.errors.slice(0, 5).join(' | ');
    report.blockedReason = `Cleansing could not produce a valid dataset — remaining errors: ${remaining}${cleanV.errors.length > 5 ? ` (+${cleanV.errors.length - 5} more)` : ''}`;
    return { cleansed: null, report };
  }
  for (const w of cleanV.warnings) report.notes.push(w);
  report.canCleanse = true;
  report.cleansedCounts = countsOf(cleanTables);
  return { cleansed: cleanTables, report };
}

/** One-line summary for the audit log (operatorId-tagged, backend
 *  only): what the cleanser changed, so any load is traceable. */
export function cleanseSummary(report: CleanseReport): string {
  return `Auto-cleansed on load: ${report.corrected.length} balance correction(s), ${report.quarantined.length} record(s) quarantined, ${report.notes.length} note(s). ` +
    `Raw: ${report.sourceCounts.customers} customers, ${report.sourceCounts.ledger} ledger entries. ` +
    `Cleansed: ${report.cleansedCounts.customers} customers, ${report.cleansedCounts.ledger} ledger entries. ` +
    `Corrections and quarantines are listed in the Data view cleansing report; the raw file was not modified.`;
}
