// Per-tool contracts for the agent's tools — mirrors
// server/tool_contracts.py (same tools, same timeouts, same retries).
//
// Every tool the agent can call is listed here with its input schema
// (required fields), timeout, retry policy (retry ONCE on a transient
// failure, never on a validation error), rate-limit note, and whether it
// mutates state. Planning tools never mutate; only `execute_approved`
// mutates, and it is idempotent (keyed by the case idempotency key — a
// posted credit is never posted twice).
//
// Timeouts: deterministic local tools 5s (they do no network); Groq
// 20s (GROQ_TIMEOUT_MS in groq.ts). Rate limit: the demo-grade guard
// (60 requests/min per caller) in api-utils.ts / server/app.py; the
// production contract is 60/min at the edge. Access control: the demo
// runs open (synthetic data, auth gate off by default); production
// calls go through the Entra ID gate (see auth.ts) and the API key
// (ATT_API_KEY) on the carrier adapter.

export interface ToolContract {
  tool: string;
  description: string;
  /** Required input fields: field name → type / meaning. */
  requiredInputs: Record<string, string>;
  timeoutMs: number;
  /** Retries on TRANSIENT failure only (timeout, 5xx, network). A
   *  validation failure (bad input, no grounding) is never retried. */
  retries: number;
  rateLimit: string;
  /** Does this tool change state? Only execute_approved does. */
  mutating: boolean;
  /** Idempotency: how a repeated call is made safe. */
  idempotency: string;
}

const RATE_LIMIT_NOTE = '60 requests/min per caller (demo-grade in-memory guard; production at the edge).';
const NO_MUTATION = 'Read-only / planning — changes no state.';
const RETRY_ONCE = 1;

export const TOOL_CONTRACTS: Record<string, ToolContract> = {
  validate_case: {
    tool: 'validate_case',
    description: 'Validate the case and its idempotency key; stop if the customer or case is missing.',
    requiredInputs: { caseId: 'string', idempotencyKey: 'string' },
    timeoutMs: 5000, retries: 0, rateLimit: RATE_LIMIT_NOTE, mutating: false,
    idempotency: 'A duplicate key returns the original run; no second run is created.',
  },
  get_customer_360: {
    tool: 'get_customer_360',
    description: 'Read-only Customer 360: customer + ledger + usage + tickets + cases.',
    requiredInputs: { customerId: 'string' },
    timeoutMs: 5000, retries: RETRY_ONCE, rateLimit: RATE_LIMIT_NOTE, mutating: false,
    idempotency: NO_MUTATION,
  },
  stair_retrieve: {
    tool: 'stair_retrieve',
    description: 'STAIR retrieval over the policy trees. Returns an intact leaf or "not found in policy".',
    requiredInputs: { query: 'string' },
    timeoutMs: 5000, retries: RETRY_ONCE, rateLimit: RATE_LIMIT_NOTE, mutating: false,
    idempotency: 'Deterministic: same query + trees, same leaf. Only a TOC leaf title may be returned.',
  },
  search_knowledge: {
    tool: 'search_knowledge',
    description: 'Chunk-RAG baseline over policy docs. Grounded answer with citations, or refusal.',
    requiredInputs: { query: 'string' },
    timeoutMs: 5000, retries: RETRY_ONCE, rateLimit: RATE_LIMIT_NOTE, mutating: false,
    idempotency: NO_MUTATION,
  },
  validate_duplicate: {
    tool: 'validate_duplicate',
    description: 'Duplicate = same customer/service/amount, different invoices, ≤ 7 days apart.',
    requiredInputs: { customerId: 'string' },
    timeoutMs: 5000, retries: RETRY_ONCE, rateLimit: RATE_LIMIT_NOTE, mutating: false,
    idempotency: NO_MUTATION,
  },
  check_eligibility: {
    tool: 'check_eligibility',
    description: 'Provisioning eligibility: account active and balance ≤ $100.',
    requiredInputs: { customerId: 'string' },
    timeoutMs: 5000, retries: RETRY_ONCE, rateLimit: RATE_LIMIT_NOTE, mutating: false,
    idempotency: NO_MUTATION,
  },
  check_network_status: {
    tool: 'check_network_status',
    description: 'Outage confirmation: a network-confirmed outage over 4 hours is required for a credit.',
    requiredInputs: { caseId: 'string' },
    timeoutMs: 5000, retries: RETRY_ONCE, rateLimit: RATE_LIMIT_NOTE, mutating: false,
    idempotency: NO_MUTATION,
  },
  compare_plans: {
    tool: 'compare_plans',
    description: 'Plan price comparison from the price table (target − current); never a hardcoded amount.',
    requiredInputs: { customerId: 'string', targetPlan: 'string' },
    timeoutMs: 5000, retries: RETRY_ONCE, rateLimit: RATE_LIMIT_NOTE, mutating: false,
    idempotency: NO_MUTATION,
  },
  assess_churn_risk: {
    tool: 'assess_churn_risk',
    description: 'Churn-risk signals: 2 required for a save offer (suspended account, outstanding balance).',
    requiredInputs: { customerId: 'string' },
    timeoutMs: 5000, retries: RETRY_ONCE, rateLimit: RATE_LIMIT_NOTE, mutating: false,
    idempotency: NO_MUTATION,
  },
  propose_credit: {
    tool: 'propose_credit',
    description: 'Propose a credit (amount, reason, citation). Proposal only — execution needs human approval.',
    requiredInputs: { amount: 'number', reason: 'string', citation: 'string' },
    timeoutMs: 5000, retries: 0, rateLimit: RATE_LIMIT_NOTE, mutating: false,
    idempotency: 'Proposals carry the case idempotency key; a re-plan returns the same proposal.',
  },
  groq_chat: {
    tool: 'groq_chat',
    description: 'Live Groq (openai/gpt-oss-120b): picks a STAIR leaf from the TOC allowlist, drafts a summary. Never decides amounts or eligibility.',
    requiredInputs: { query: 'string', allowlist: 'string[] (leaf ids)' },
    timeoutMs: 20000, retries: RETRY_ONCE, rateLimit: RATE_LIMIT_NOTE, mutating: false,
    idempotency: 'No state. Any failure (429, timeout, invalid pick) falls back to deterministic STAIR; the circuit breaker opens after 3 consecutive failures (see groq.ts).',
  },
  execute_approved: {
    tool: 'execute_approved',
    description: 'Execute the approved action: post the credit / activate the line / change the plan / schedule the visit.',
    requiredInputs: { runId: 'string', approval: "'approved'", idempotencyKey: 'string' },
    timeoutMs: 5000, retries: 0, rateLimit: RATE_LIMIT_NOTE, mutating: true,
    idempotency: 'ENFORCED: a credit entry already posted for the case (LED-CR-<case>) or a seen idempotency key returns the original outcome — a credit is never posted twice.',
  },
  notify_customer: {
    tool: 'notify_customer',
    description: 'Notify the customer of the outcome. Runs only after a verified state change.',
    requiredInputs: { customerId: 'string', message: 'string' },
    timeoutMs: 5000, retries: RETRY_ONCE, rateLimit: RATE_LIMIT_NOTE, mutating: true,
    idempotency: 'One notification per executed run (keyed by run id); a replayed run does not re-notify.',
  },
  verify_outcome: {
    tool: 'verify_outcome',
    description: 'Verify the state change against the record before closing the case.',
    requiredInputs: { runId: 'string' },
    timeoutMs: 5000, retries: RETRY_ONCE, rateLimit: RATE_LIMIT_NOTE, mutating: false,
    idempotency: NO_MUTATION,
  },
};

/** Missing required inputs for a tool call. Empty = the call is valid.
 *  A non-empty result is a validation error: never retried, never faked. */
export function missingToolInputs(tool: string, input: Record<string, unknown>): string[] {
  const contract = TOOL_CONTRACTS[tool];
  if (!contract) return [`Unknown tool ${tool}`];
  return Object.keys(contract.requiredInputs).filter((f) => input[f] === undefined || input[f] === null || input[f] === '');
}

/** The one mutating tool, and the rule that guards it. */
export function isMutatingTool(tool: string): boolean {
  return TOOL_CONTRACTS[tool]?.mutating ?? false;
}

/** Convenience: the contract for a run's steps (used by the UI run view
 *  to show timeout / retry / idempotency per step). */
export function contractForStep(stepTool: string): ToolContract | null {
  return TOOL_CONTRACTS[stepTool] ?? null;
}
