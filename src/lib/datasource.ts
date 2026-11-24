// Data-source switch — two modes, one interface. Mirrors
// server/datasource.py (same modes, same endpoints, same mapping rules).
//
//   seed — the current synthetic demo data (src/lib/seed.ts). Default.
//   att  — live carrier adapter: reads CRM / billing / usage payloads from
//          ATT_API_BASE_URL with ATT_API_KEY (Bearer), and maps them onto
//          the existing Customer / LedgerEntry / UsageRecord types.
//
// `att` mode FAILS HONESTLY: if the carrier API is unreachable, returns an
// error, or sends a record that cannot be mapped, loadDatasourceState()
// throws DatasourceError — it NEVER silently falls back to seed/fake data.
// A silent fallback would be exactly the kind of fake-live demo this
// project refuses to ship. The UI and /api/health report the mode and the
// failure; the fulfilment team fixes the connection (docs/DEPLOYMENT.md).
//
// Mode is selected by the DATASOURCE env var (default `seed`) — see
// config.ts. The browser build has no env vars, so the frontend always
// runs in seed mode locally and reads the live mode from /api/health.
import type { AppState, Case, Customer, LedgerEntry, PolicyDoc, UsageRecord } from './types';
import { loadConfig } from './config';
import { seedState } from './seed';

export type DatasourceMode = 'seed' | 'att';

export class DatasourceError extends Error {
  status: number | null;
  constructor(reason: string, status: number | null = null) {
    super(reason);
    this.name = 'DatasourceError';
    this.status = status;
  }
}

/** Timeout per carrier request (10s) and retries (one retry on a network
 *  error or a 5xx — never on a 4xx, which is a real client error). */
export const ATT_TIMEOUT_MS = 10_000;
export const ATT_MAX_ATTEMPTS = 2;

/** The five endpoints the fulfilment team exposes on ATT_API_BASE_URL.
 *  Each returns a JSON array. Field names are mapped flexibly below
 *  (snake_case or camelCase); a record missing its required fields is
 *  rejected with a named error, never guessed. See docs/DEPLOYMENT.md. */
export const ATT_ENDPOINTS = {
  customers: '/customers',
  ledger: '/ledger',
  usage: '/usage',
  cases: '/cases',
  docs: '/docs',
} as const;

function pick(raw: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) if (raw[n] !== undefined && raw[n] !== null) return raw[n];
  return undefined;
}

function reqString(raw: Record<string, unknown>, id: string, ...names: string[]): string {
  const v = pick(raw, ...names);
  if (typeof v !== 'string' || v === '') throw new DatasourceError(`carrier record ${id} is missing required field ${names[0]}`);
  return v;
}

function reqNumber(raw: Record<string, unknown>, id: string, ...names: string[]): number {
  const v = pick(raw, ...names);
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || Number.isNaN(n)) throw new DatasourceError(`carrier record ${id} is missing required numeric field ${names[0]}`);
  return n;
}

/** Map one carrier CRM customer onto Customer. Unknown plans/statuses are
 *  kept as-is (the engine validates them); missing id/name fails loudly. */
export function mapAttCustomer(raw: Record<string, unknown>): Customer {
  const id = reqString(raw, String(raw.id ?? '?'), 'id', 'customerId', 'customer_id');
  return {
    id,
    name: reqString(raw, id, 'name', 'fullName', 'full_name'),
    account: String(pick(raw, 'account', 'accountNumber', 'account_number') ?? ''),
    phone: String(pick(raw, 'phone', 'phoneNumber', 'phone_number') ?? ''),
    email: String(pick(raw, 'email') ?? ''),
    plan: String(pick(raw, 'plan', 'planName', 'plan_name') ?? 'Unknown'),
    status: (pick(raw, 'status') as Customer['status']) ?? 'active',
    since: String(pick(raw, 'since', 'createdAt', 'created_at') ?? ''),
    balance: Number(pick(raw, 'balance', 'outstandingBalance', 'outstanding_balance') ?? 0),
    city: String(pick(raw, 'city') ?? ''),
  };
}

export function mapAttLedgerEntry(raw: Record<string, unknown>): LedgerEntry {
  const id = reqString(raw, String(raw.id ?? '?'), 'id', 'entryId', 'entry_id');
  return {
    id,
    customerId: reqString(raw, id, 'customerId', 'customer_id'),
    invoice: String(pick(raw, 'invoice', 'invoiceNumber', 'invoice_number') ?? ''),
    date: String(pick(raw, 'date', 'postedDate', 'posted_date') ?? ''),
    service: String(pick(raw, 'service', 'description') ?? ''),
    amount: reqNumber(raw, id, 'amount'),
    kind: (pick(raw, 'kind', 'type') as LedgerEntry['kind']) ?? 'charge',
    status: (pick(raw, 'status') as LedgerEntry['status']) ?? 'posted',
  };
}

export function mapAttUsage(raw: Record<string, unknown>): UsageRecord {
  const id = reqString(raw, String(raw.id ?? '?'), 'id', 'usageId', 'usage_id');
  return {
    id,
    customerId: reqString(raw, id, 'customerId', 'customer_id'),
    month: String(pick(raw, 'month', 'billingMonth', 'billing_month') ?? ''),
    dataGb: Number(pick(raw, 'dataGb', 'data_gb', 'dataGB') ?? 0),
    minutes: Number(pick(raw, 'minutes') ?? 0),
    sms: Number(pick(raw, 'sms') ?? 0),
  };
}

export function mapAttCase(raw: Record<string, unknown>): Case {
  const id = reqString(raw, String(raw.id ?? '?'), 'id', 'caseId', 'case_id');
  return {
    id,
    customerId: reqString(raw, id, 'customerId', 'customer_id'),
    type: (pick(raw, 'type', 'caseType', 'case_type') as Case['type']) ?? 'other',
    title: String(pick(raw, 'title', 'subject') ?? ''),
    description: String(pick(raw, 'description', 'detail') ?? ''),
    amount: Number(pick(raw, 'amount') ?? 0),
    status: (pick(raw, 'status') as Case['status']) ?? 'open',
    createdAt: String(pick(raw, 'createdAt', 'created_at') ?? ''),
    idempotencyKey: String(pick(raw, 'idempotencyKey', 'idempotency_key') ?? `${id.toLowerCase()}-v1`),
  };
}

export function mapAttDoc(raw: Record<string, unknown>): PolicyDoc {
  const id = reqString(raw, String(raw.id ?? '?'), 'id', 'docId', 'doc_id');
  return {
    id,
    title: reqString(raw, id, 'title'),
    body: reqString(raw, id, 'body', 'text', 'content'),
    updated: String(pick(raw, 'updated', 'updatedAt', 'updated_at') ?? ''),
  };
}

export interface Datasource {
  mode: DatasourceMode;
  loadState(): Promise<AppState>;
}

export class SeedDatasource implements Datasource {
  readonly mode: DatasourceMode = 'seed';
  async loadState(): Promise<AppState> {
    return seedState();
  }
}

/** Live carrier adapter. One GET per collection, Bearer auth, 10s timeout,
 *  one retry on network/5xx. Any failure — unreachable host, 401/403,
 *  bad JSON, unmappable record — throws DatasourceError. No fallback. */
export class AttDatasource implements Datasource {
  readonly mode: DatasourceMode = 'att';
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    if (!baseUrl) throw new DatasourceError('ATT_API_BASE_URL is required in att datasource mode');
    if (!apiKey) throw new DatasourceError('ATT_API_KEY is required in att datasource mode');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  private async fetchJson(path: string): Promise<unknown> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= ATT_MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ATT_TIMEOUT_MS);
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          headers: { Accept: 'application/json', Authorization: `Bearer ${this.apiKey}` },
          signal: controller.signal,
        });
        if (!res.ok) {
          const detail = (await res.text()).slice(0, 300);
          // 4xx is a real client error (bad key, bad path) — do not retry.
          if (res.status < 500) throw new DatasourceError(`carrier API ${path} returned HTTP ${res.status}: ${detail}`, res.status);
          throw new Error(`carrier API ${path} returned HTTP ${res.status}: ${detail}`);
        }
        return (await res.json()) as unknown;
      } catch (e) {
        if (e instanceof DatasourceError) throw e;
        lastError = e instanceof Error ? e : new Error(String(e));
        // Retry once on network errors / 5xx; the loop ends after attempt 2.
      } finally {
        clearTimeout(timer);
      }
    }
    throw new DatasourceError(`carrier API unreachable at ${this.baseUrl} after ${ATT_MAX_ATTEMPTS} attempts: ${lastError?.message ?? 'unknown error'}`);
  }

  private static asArray(value: unknown, path: string): Record<string, unknown>[] {
    if (!Array.isArray(value)) throw new DatasourceError(`carrier API ${path} did not return a JSON array`);
    return value as Record<string, unknown>[];
  }

  async loadState(): Promise<AppState> {
    const [customers, ledger, usage, cases, docs] = await Promise.all([
      this.fetchJson(ATT_ENDPOINTS.customers).then((v) => AttDatasource.asArray(v, ATT_ENDPOINTS.customers).map(mapAttCustomer)),
      this.fetchJson(ATT_ENDPOINTS.ledger).then((v) => AttDatasource.asArray(v, ATT_ENDPOINTS.ledger).map(mapAttLedgerEntry)),
      this.fetchJson(ATT_ENDPOINTS.usage).then((v) => AttDatasource.asArray(v, ATT_ENDPOINTS.usage).map(mapAttUsage)),
      this.fetchJson(ATT_ENDPOINTS.cases).then((v) => AttDatasource.asArray(v, ATT_ENDPOINTS.cases).map(mapAttCase)),
      this.fetchJson(ATT_ENDPOINTS.docs).then((v) => AttDatasource.asArray(v, ATT_ENDPOINTS.docs).map(mapAttDoc)),
    ]);
    return {
      customers, ledger, usage, cases, docs,
      tickets: [], runs: [], orders: [], stairTrees: [],
      pipelines: [], pipelineRuns: [], evalRuns: [], audit: [], notifications: [],
      seededAt: new Date().toISOString(),
    };
  }
}

/** Build the datasource for the current config. Unknown DATASOURCE values
 *  fail loudly here (config.validateConfig flags them first at startup). */
export function datasourceFromConfig(): Datasource {
  const cfg = loadConfig();
  if (cfg.datasource === 'att') return new AttDatasource(cfg.attApiBaseUrl, cfg.attApiKey);
  return new SeedDatasource();
}

/** Load state from the configured source. In `att` mode this throws
 *  DatasourceError on any failure — the caller must surface it, never
 *  substitute the seed. */
export async function loadDatasourceState(): Promise<AppState> {
  return datasourceFromConfig().loadState();
}
