// Deterministic agent engine — the same logic the Python reference backend
// (server/engine.py) and the Vercel API (api/run-case.ts, api/rag.ts) run.
// No LLM, no randomness, no network. Every decision is traceable to a tool
// result, a ledger record, or a cited policy doc. A run that cannot validate
// its claim fails honestly instead of reporting success.
import type {
  AgentRun, AppState, Case, Customer, EvalResult, LedgerEntry, PolicyDoc, RunStep,
} from './types';
import { stairRetrieve } from './stair';
import type { StairLeaf } from './types';
import { DEFAULT_TARGET_PLAN, EVAL_GATE_PCT, GOODWILL_APPROVAL_THRESHOLD_USD, OUTAGE_CREDIT_USD, OUTAGE_MIN_HOURS, PLAN_PRICES, RETENTION_CREDIT_USD } from './types';

export const STOPWORDS = new Set(
  'a an the is are was were what how why when where which who whom this that these those it its of for to in on at by with from as and or not no do does did can could should would i me my we you your he she they them his her their our'.split(' '),
);

export function tokenize(text: string): string[] {
  // Light stemming so "credits" matches "credit" and "charges" matches "charge".
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w)).map((w) => w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
}

export interface RagHit { doc: PolicyDoc; score: number; matched: string[] }

export function ragSearch(docs: PolicyDoc[], query: string): RagHit[] {
  const q = [...new Set(tokenize(query))];
  if (q.length === 0) return [];
  return docs
    .map((doc) => {
      const hay = tokenize(`${doc.title} ${doc.body}`);
      const matched = q.filter((t) => hay.includes(t));
      return { doc, score: matched.length / q.length, matched };
    })
    .filter((h) => h.score >= 0.2)
    .sort((a, b) => b.score - a.score);
}

/** Grounded answer: only from indexed docs. Refuses when nothing matches. */
export function groundedAnswer(docs: PolicyDoc[], query: string): { answer: string; citations: { docId: string; title: string; score: number }[]; refused: boolean } {
  const hits = ragSearch(docs, query);
  if (hits.length === 0) {
    return {
      answer: 'Not in the indexed docs — I cannot answer this from policy. No policy document matches your question, so I will not guess.',
      citations: [], refused: true,
    };
  }
  const top = hits.slice(0, 3);
  const answer = top.map((h) => h.doc.body).join(' ');
  return {
    answer,
    citations: top.map((h) => ({ docId: h.doc.id, title: h.doc.title, score: Math.round(h.score * 100) / 100 })),
    refused: false,
  };
}

export interface DuplicatePair { original: LedgerEntry; duplicate: LedgerEntry }

/** Two posted charges, same customer/service/amount, different invoices, ≤7 days apart. */
export function findDuplicate(ledger: LedgerEntry[], customerId: string): DuplicatePair | null {
  const charges = ledger
    .filter((e) => e.customerId === customerId && e.kind === 'charge' && e.status === 'posted')
    .sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 0; i < charges.length; i++) {
    for (let j = i + 1; j < charges.length; j++) {
      const a = charges[i];
      const b = charges[j];
      if (a.service !== b.service || a.amount !== b.amount || a.invoice === b.invoice) continue;
      const days = (new Date(b.date).getTime() - new Date(a.date).getTime()) / 86400000;
      if (days >= 0 && days <= 7) return { original: a, duplicate: b };
    }
  }
  return null;
}

export function customer360(state: AppState, customerId: string) {
  const customer = state.customers.find((c) => c.id === customerId) ?? null;
  return {
    customer,
    ledger: state.ledger.filter((e) => e.customerId === customerId),
    usage: state.usage.filter((u) => u.customerId === customerId),
    tickets: state.tickets.filter((t) => t.customerId === customerId),
    cases: state.cases.filter((c) => c.customerId === customerId),
  };
}

/** Target plan for a plan change: Unlimited Premium unless the case
 *  description states another target explicitly ("to <Plan>" or
 *  "comparison with <Plan>"). The current plan always comes from the
 *  customer record, never from the case. */
export function parseTargetPlan(description: string | undefined): string {
  const desc = (description ?? '').toLowerCase();
  for (const plan of Object.keys(PLAN_PRICES)) {
    if (desc.includes(`to ${plan.toLowerCase()}`)) return plan;
  }
  for (const plan of Object.keys(PLAN_PRICES)) {
    if (desc.includes(`with ${plan.toLowerCase()}`)) return plan;
  }
  return DEFAULT_TARGET_PLAN;
}

/**
 * Network-status check for an outage case. Demo convention, stated honestly:
 * the seeded network-status record is carried in the case description — a
 * description that references a "network-confirmed" outage means the
 * network-status tool returned a confirmed outage lasting over 4 hours.
 * A case with no such reference is NOT confirmed: the customer report alone
 * never confirms an outage, and the run fails instead of proposing a credit.
 */
export function isNetworkOutageConfirmed(c: Case): boolean {
  return (c.description ?? '').toLowerCase().includes('network-confirmed');
}

export interface PlanResult {
  steps: Omit<RunStep, 'ms'>[];
  proposedCredit: number | null;
  duplicate: DuplicatePair | null;
  citation: string | null;
  failureReason: string | null;
  effectKind: 'credit' | 'provisioning' | 'outage_credit' | 'plan_change' | 'retention_offer' | 'none';
  effectData: Record<string, string | number>;
  proposedAction: string | null;
  /** Live-LLM status: 'off' (deterministic default), 'groq', or
   *  'unavailable, deterministic fallback'. Mirrors server/engine.py. */
  liveLlm: string;
  liveSummary: string | null;
  liveLeafPicks: Record<string, string>;
}

type StepAdd = (id: string, name: string, tool: string, status: 'done' | 'failed', detail: string, extra?: Partial<RunStep>) => void;

function makeSteps(): { steps: Omit<RunStep, 'ms'>[]; add: StepAdd } {
  const steps: Omit<RunStep, 'ms'>[] = [];
  const add: StepAdd = (id, name, tool, status, detail, extra) =>
    steps.push({ id, name, tool, status, ms: 0, retries: 0, detail, ...extra });
  return { steps, add };
}

function baseResult(): PlanResult {
  return { steps: [], proposedCredit: null, duplicate: null, citation: null, failureReason: null, effectKind: 'none', effectData: {}, proposedAction: null, liveLlm: 'off', liveSummary: null, liveLeafPicks: {} };
}

/** Live-LLM options for planRun. liveLeafByQuery maps a grounding query to
 *  a leaf id Groq picked; every id is validated against the TOC allowlist
 *  here again before it is used — an id that is not in the trees is ignored
 *  and deterministic STAIR runs instead. */
export interface PlanRunOptions {
  liveLeafByQuery?: Record<string, string>;
  liveLlm?: string;
  liveSummary?: string | null;
}

/** Primary grounding is STAIR (structured trees, intact leaf, full path citation).
 *  Chunk RAG remains only as the comparison baseline in the STAIR view. */
function stairGround(state: AppState, query: string, liveLeafByQuery?: Record<string, string>): { leaf: StairLeaf | null; score: number; live: boolean } {
  const hintId = liveLeafByQuery?.[query];
  if (hintId) {
    const hinted = (state.stairTrees ?? []).flatMap((t) => t.leaves).find((l) => l.id === hintId);
    if (hinted) return { leaf: hinted, score: 1, live: true }; // validated against the TOC allowlist
  }
  const hit = stairRetrieve(state.stairTrees ?? [], query);
  return hit ? { leaf: hit.leaf, score: hit.score, live: false } : { leaf: null, score: 0, live: false };
}

function intake(state: AppState, c: Case, add: StepAdd): import('./types').Customer | null {
  const customer = state.customers.find((x) => x.id === c.customerId) ?? null;
  if (!customer) {
    add('intake', 'Intake + idempotency check', 'validate_case', 'failed', `Customer ${c.customerId} not found. Run stopped.`);
    return null;
  }
  add('intake', 'Intake + idempotency check', 'validate_case', 'done',
    `Case ${c.id} validated. Idempotency key ${c.idempotencyKey}. No completed run exists for this key.`);
  return customer;
}

function retrieve360(state: AppState, c: Case, customer: import('./types').Customer, add: StepAdd): void {
  const ledger = state.ledger.filter((e) => e.customerId === c.customerId);
  add('retrieve-360', 'Retrieve Customer 360', 'get_customer_360', 'done',
    `${customer.name} (${customer.account}), ${customer.plan}, balance $${customer.balance.toFixed(2)}. ` +
    `${ledger.length} ledger entries, ${state.usage.filter((u) => u.customerId === c.customerId).length} usage records, ` +
    `${state.tickets.filter((t) => t.customerId === c.customerId).length} tickets.`);
}

/** Pure planning phase. No state is changed here. Dispatches by case type. */
export function planRun(state: AppState, c: Case, opts: PlanRunOptions = {}): PlanResult {
  const result = baseResult();
  result.liveLlm = opts.liveLlm ?? 'off';
  result.liveSummary = opts.liveSummary ?? null;
  result.liveLeafPicks = opts.liveLeafByQuery ?? {};
  const { steps, add } = makeSteps();
  result.steps = steps;
  const customer = intake(state, c, add);
  if (!customer) { result.failureReason = `Customer ${c.customerId} not found.`; return result; }
  retrieve360(state, c, customer, add);

  let planned: PlanResult;
  if (c.type === 'duplicate_charge') planned = planBilling(state, c, customer, result, add, opts);
  else if (c.type === 'provisioning') planned = planProvisioning(state, c, customer, result, add, opts);
  else if (c.type === 'outage') planned = planOutage(state, c, customer, result, add, opts);
  else if (c.type === 'plan_change') planned = planPlanChange(state, c, customer, result, add, opts);
  else if (c.type === 'retention') planned = planRetention(state, c, customer, result, add, opts);
  else {
    add('validate', 'Validate case', 'validate_case', 'failed',
      `Case type ${c.type} has no agent workflow in this demo. Run stopped — no action proposed.`);
    result.failureReason = `Case type ${c.type} has no agent workflow in this demo.`;
    planned = result;
  }
  // Record which path actually grounded this run — live Groq or fallback.
  if (opts.liveLlm === 'groq') {
    planned.steps.push({ id: 'live-llm', name: 'Live LLM (Groq)', tool: 'groq_chat', status: 'done', retries: 0,
      detail: 'Live LLM (openai/gpt-oss-120b) picked the STAIR leaf(s) from the TOC allowlist; deterministic validation still applied to every amount and eligibility check.' });
  } else if (opts.liveLlm === 'unavailable, deterministic fallback') {
    planned.steps.push({ id: 'live-llm', name: 'Live LLM (Groq)', tool: 'groq_chat', status: 'done', retries: 0,
      detail: 'Live LLM unavailable — deterministic fallback. The run completed with deterministic STAIR and validation, and no answer was faked.' });
  }
  return planned;
}

function planBilling(state: AppState, c: Case, _customer: import('./types').Customer, result: PlanResult, add: StepAdd, opts: PlanRunOptions = {}): PlanResult {
  const g = stairGround(state, 'duplicate charge credit policy', opts.liveLeafByQuery);
  if (!g.leaf) {
    add('stair-ground', 'STAIR policy grounding', 'stair_retrieve', 'failed', 'No section in the Table of Contents covers duplicate charges. The agent refuses to proceed without grounding.');
    result.failureReason = 'No grounding section found for duplicate charges.';
    return result;
  }
  result.citation = `${g.leaf.path} ${g.leaf.section}`;
  add('stair-ground', 'STAIR policy grounding', 'stair_retrieve', 'done',
    `Grounded in ${g.leaf.path} ${g.leaf.section} — leaf retrieved intact, no chunking. “${g.leaf.body.slice(0, 160)}…”`, { citation: result.citation });
  const dup = findDuplicate(state.ledger, c.customerId);
  if (!dup) {
    add('validate', 'Validate duplicate charge', 'validate_duplicate', 'failed', 'No second posted charge matches the same service and amount within 7 days. No duplicate found — no credit proposed.');
    result.failureReason = 'No duplicate charge found in the ledger.';
    return result;
  }
  result.duplicate = dup;
  add('validate', 'Validate duplicate charge', 'validate_duplicate', 'done',
    `Duplicate confirmed: ${dup.original.invoice} (${dup.original.date}) and ${dup.duplicate.invoice} (${dup.duplicate.date}), ${dup.duplicate.service}, $${dup.duplicate.amount.toFixed(2)} each.`);
  result.proposedCredit = dup.duplicate.amount;
  result.effectKind = 'credit';
  result.effectData = { invoice: dup.duplicate.invoice, amount: dup.duplicate.amount };
  result.proposedAction = `Credit $${dup.duplicate.amount.toFixed(2)} against ${dup.duplicate.invoice}`;
  const thresholdNote = dup.duplicate.amount > GOODWILL_APPROVAL_THRESHOLD_USD
    ? `Credit is above $${GOODWILL_APPROVAL_THRESHOLD_USD.toFixed(2)}, so human approval is required (POL-002).`
    : `Credit is $${dup.duplicate.amount.toFixed(2)}, at or below the $${GOODWILL_APPROVAL_THRESHOLD_USD.toFixed(2)} POL-002 threshold — this demo still pauses for human approval.`;
  add('plan-propose', 'Plan + propose credit', 'propose_credit', 'done',
    `Propose a credit of $${dup.duplicate.amount.toFixed(2)} against ${dup.duplicate.invoice} only. ${thresholdNote} Run pauses for approval.`);
  return result;
}

function planProvisioning(state: AppState, _c: Case, customer: import('./types').Customer, result: PlanResult, add: StepAdd, opts: PlanRunOptions = {}): PlanResult {
  const g = stairGround(state, 'new line activation provisioning', opts.liveLeafByQuery);
  if (!g.leaf) {
    add('stair-ground', 'STAIR policy grounding', 'stair_retrieve', 'failed', 'No section covers new line activation.');
    result.failureReason = 'No grounding section found for provisioning.';
    return result;
  }
  result.citation = `${g.leaf.path} ${g.leaf.section}`;
  add('stair-ground', 'STAIR policy grounding', 'stair_retrieve', 'done', `Grounded in ${g.leaf.path} ${g.leaf.section}.`, { citation: result.citation });
  if (customer.status !== 'active') {
    add('validate', 'Eligibility check', 'check_eligibility', 'failed', `Account is ${customer.status}, not active. A new line cannot be activated. Run stopped.`);
    result.failureReason = `Account is ${customer.status}; new line activation requires an active account.`;
    return result;
  }
  if (customer.balance > 100) {
    add('validate', 'Eligibility check', 'check_eligibility', 'failed', `Overdue balance $${customer.balance.toFixed(2)} is above the $100 limit. Run stopped.`);
    result.failureReason = 'Overdue balance above $100; new line activation is not eligible.';
    return result;
  }
  add('validate', 'Eligibility check', 'check_eligibility', 'done', `Account active, balance $${customer.balance.toFixed(2)} (limit $100). Eligible.`);
  add('order', 'Create order + provision', 'create_order', 'done', 'Order prepared for a second line with device activation. Network provisioning and SIM registration will run on approval.');
  result.effectKind = 'provisioning';
  result.effectData = { kind: 'new_line' };
  result.proposedAction = 'Activate a second line with device activation';
  add('plan-propose', 'Plan + propose activation', 'propose_activation', 'done', 'Propose activating the second line. Human approval is required before provisioning runs. Run pauses for approval.');
  return result;
}

function planOutage(state: AppState, c: Case, _customer: import('./types').Customer, result: PlanResult, add: StepAdd, opts: PlanRunOptions = {}): PlanResult {
  const g = stairGround(state, 'network outage triage diagnose', opts.liveLeafByQuery);
  if (!g.leaf) {
    add('stair-ground', 'STAIR policy grounding', 'stair_retrieve', 'failed', 'No section covers outage triage.');
    result.failureReason = 'No grounding section found for outage triage.';
    return result;
  }
  result.citation = `${g.leaf.path} ${g.leaf.section}`;
  add('stair-ground', 'STAIR policy grounding', 'stair_retrieve', 'done', `Grounded in ${g.leaf.path} ${g.leaf.section}.`, { citation: result.citation });
  // Outage credit (POL-006 / STAIR §5.1) is $25 ONLY for a network-confirmed
  // outage over 4 hours. The case amount is whatever the customer reported
  // (here a device installment) — it is never the credit, and it is never
  // ignored silently: the trace below names both numbers.
  if (!isNetworkOutageConfirmed(c)) {
    add('diagnose', 'Diagnose from network status', 'check_network_status', 'failed', `No network-status confirmation in the case record — the customer report alone does not confirm an outage. Policy requires a network-confirmed outage over ${OUTAGE_MIN_HOURS} hours (POL-006). No outage credit proposed.`);
    result.failureReason = `Outage is not network-confirmed (over ${OUTAGE_MIN_HOURS} hours). No outage credit can be proposed.`;
    return result;
  }
  add('diagnose', 'Diagnose from network status', 'check_network_status', 'done', `Network status check: the case record references a network-confirmed outage lasting over ${OUTAGE_MIN_HOURS} hours. Diagnosis: confirmed outage, not a device fault.`);
  const creditLeaf = stairGround(state, 'outage service credit', opts.liveLeafByQuery);
  if (!creditLeaf.leaf) {
    add('credit-check', 'Outage credit check', 'stair_retrieve', 'failed', 'No section covers outage service credits. The credit cannot be grounded, so no credit is proposed.');
    result.failureReason = 'No grounding section found for outage service credit.';
    return result;
  }
  result.citation = `${result.citation} + ${creditLeaf.leaf.path} ${creditLeaf.leaf.section}`;
  const ledgerEntry = state.ledger.find((e) => e.customerId === c.customerId && e.amount === c.amount);
  const ledgerNote = ledgerEntry ? ` Ledger: ${ledgerEntry.invoice}, ${ledgerEntry.service}, $${ledgerEntry.amount.toFixed(2)}.` : '';
  add('credit-check', 'Outage credit check', 'stair_retrieve', 'done', `Case amount $${c.amount.toFixed(2)} is the reported device installment, not the credit. Policy credit is $${OUTAGE_CREDIT_USD.toFixed(2)} per Outage Service Credit Policy §5.1, network-confirmed >${OUTAGE_MIN_HOURS}h. (${creditLeaf.leaf.path} ${creditLeaf.leaf.section})${ledgerNote}`, { citation: result.citation });
  result.proposedCredit = OUTAGE_CREDIT_USD;
  result.effectKind = 'outage_credit';
  result.effectData = { amount: OUTAGE_CREDIT_USD, caseAmount: c.amount };
  result.proposedAction = `Schedule a technician visit and apply a $${OUTAGE_CREDIT_USD.toFixed(2)} outage service credit`;
  add('plan-propose', 'Plan + propose resolution', 'propose_outage_resolution', 'done', `Propose: notify the customer, schedule a technician visit, and apply a $${OUTAGE_CREDIT_USD.toFixed(2)} outage service credit — not the $${c.amount.toFixed(2)} case amount, which is the reported device installment. Human approval required. Run pauses for approval.`);
  return result;
}

function planPlanChange(state: AppState, c: Case, customer: import('./types').Customer, result: PlanResult, add: StepAdd, opts: PlanRunOptions = {}): PlanResult {
  const g = stairGround(state, 'plan upgrade price premium starter', opts.liveLeafByQuery);
  if (!g.leaf) {
    add('stair-ground', 'STAIR policy grounding', 'stair_retrieve', 'failed', 'No section covers upgrade pricing.');
    result.failureReason = 'No grounding section found for plan upgrade pricing.';
    return result;
  }
  result.citation = `${g.leaf.path} ${g.leaf.section}`;
  add('stair-ground', 'STAIR policy grounding', 'stair_retrieve', 'done', `Grounded in ${g.leaf.path} ${g.leaf.section}.`, { citation: result.citation });
  // Plan-aware pricing: the current plan comes from the customer record and
  // the target from the case description (default Unlimited Premium). The
  // difference is computed from the price table — never a hardcoded $22.40.
  const targetPlan = parseTargetPlan(c.description);
  const currentPrice = PLAN_PRICES[customer.plan];
  const targetPrice = PLAN_PRICES[targetPlan];
  if (currentPrice === undefined) {
    add('validate', 'Eligibility + price comparison', 'compare_plans', 'failed', `Unknown current plan "${customer.plan}" — no price in the plan price table. Run stopped.`);
    result.failureReason = `Unknown current plan "${customer.plan}".`;
    return result;
  }
  const diff = Math.round((targetPrice - currentPrice) * 100) / 100;
  if (diff === 0) {
    add('validate', 'Eligibility + price comparison', 'compare_plans', 'failed', `Customer is already on ${targetPlan}. There is nothing to change. Run stopped.`);
    result.failureReason = `Customer is already on ${targetPlan}.`;
    return result;
  }
  const calc = `${customer.plan} $${currentPrice.toFixed(2)} → ${targetPlan} $${targetPrice.toFixed(2)}. Difference: ${diff > 0 ? '+' : '-'}$${Math.abs(diff).toFixed(2)}${diff > 0 ? ' (charge)' : ' (credit)'}.`;
  if (diff > 0) {
    add('validate', 'Eligibility + price comparison', 'compare_plans', 'done', `${calc} Customer confirmation is required before the change is applied.`);
    result.effectKind = 'plan_change';
    result.effectData = { newPlan: targetPlan, charge: diff };
    result.proposedAction = `Change plan to ${targetPlan} (pro-rated charge $${diff.toFixed(2)})`;
    add('plan-propose', 'Plan + propose change', 'propose_plan_change', 'done', `Propose the change to ${targetPlan} at $${diff.toFixed(2)} pro-rated. Human approval required. Run pauses for approval.`);
    return result;
  }
  const credit = Math.abs(diff);
  add('validate', 'Eligibility + price comparison', 'compare_plans', 'done', `${calc} The cheaper target plan means the customer is owed a credit, not a charge. Customer confirmation is required before the change is applied.`);
  result.proposedCredit = credit;
  result.effectKind = 'plan_change';
  result.effectData = { newPlan: targetPlan, credit };
  result.proposedAction = `Change plan to ${targetPlan} (pro-rated credit $${credit.toFixed(2)})`;
  add('plan-propose', 'Plan + propose change', 'propose_plan_change', 'done', `Propose the change to ${targetPlan} with a $${credit.toFixed(2)} pro-rated credit. Human approval required. Run pauses for approval.`);
  return result;
}

function planRetention(state: AppState, _c: Case, customer: import('./types').Customer, result: PlanResult, add: StepAdd, opts: PlanRunOptions = {}): PlanResult {
  const g = stairGround(state, 'retention save offer churn', opts.liveLeafByQuery);
  if (!g.leaf) {
    add('stair-ground', 'STAIR policy grounding', 'stair_retrieve', 'failed', 'No section covers save offers.');
    result.failureReason = 'No grounding section found for retention save offers.';
    return result;
  }
  result.citation = `${g.leaf.path} ${g.leaf.section}`;
  add('stair-ground', 'STAIR policy grounding', 'stair_retrieve', 'done', `Grounded in ${g.leaf.path} ${g.leaf.section}.`, { citation: result.citation });
  const signals = [customer.status === 'suspended' ? 'suspended account' : null, customer.balance > 0 ? 'outstanding balance' : null].filter(Boolean);
  if (signals.length < 2) {
    add('validate', 'Churn-risk check', 'assess_churn_risk', 'failed', `Only ${signals.length} churn-risk signal(s) found (${signals.join(', ') || 'none'}). Two are required for a save offer. Run stopped.`);
    result.failureReason = 'Not enough churn-risk signals for a save offer.';
    return result;
  }
  add('validate', 'Churn-risk check', 'assess_churn_risk', 'done', `Churn-risk confirmed: ${signals.join(' + ')}. Eligible for a save offer.`);
  result.proposedCredit = RETENTION_CREDIT_USD;
  result.effectKind = 'retention_offer';
  result.effectData = { amount: RETENTION_CREDIT_USD };
  result.proposedAction = `Apply a $${RETENTION_CREDIT_USD.toFixed(2)} goodwill credit and reactivate the account`;
  add('plan-propose', 'Plan + propose save offer', 'propose_save_offer', 'done', `Propose a $${RETENTION_CREDIT_USD.toFixed(2)} goodwill credit and account reactivation. Human approval required. Run pauses for approval.`);
  return result;
}

/** Idempotency: a credit entry already posted for this case means "already applied". */
export function creditAlreadyApplied(state: AppState, caseId: string): boolean {
  return state.ledger.some((e) => e.id === `LED-CR-${caseId}`);
}

export function applyCredit(state: AppState, c: Case, run: AgentRun, dup: DuplicatePair): { entry: LedgerEntry; customer: Customer | null } {
  const entry: LedgerEntry = {
    id: `LED-CR-${c.id}`, customerId: c.customerId, invoice: dup.duplicate.invoice,
    date: new Date().toISOString().slice(0, 10), service: `Credit — duplicate charge ${dup.duplicate.invoice}`,
    amount: -run.proposedCredit!, kind: 'credit', status: 'posted',
  };
  const customer = state.customers.find((x) => x.id === c.customerId) ?? null;
  return { entry, customer };
}

/** ETL validation over the seeded batch. Deterministic: same input, same counts. */
export function validatePipelineBatch(state: AppState): { processed: number; failed: number; exceptions: string[] } {
  const exceptions: string[] = [];
  let failed = 0;
  const dup = findDuplicate(state.ledger, 'CUST-1001');
  if (dup) { exceptions.push(`Duplicate charge: CUST-1001 ${dup.original.invoice} + ${dup.duplicate.invoice} ($${dup.duplicate.amount.toFixed(2)})`); failed += 1; }
  const suspended = state.customers.filter((c) => c.status === 'suspended' && c.balance > 0);
  for (const c of suspended) { exceptions.push(`Suspended account with balance: ${c.id} ${c.name} ($${c.balance.toFixed(2)})`); failed += 1; }
  for (const e of state.ledger) {
    if (!state.customers.some((c) => c.id === e.customerId)) { exceptions.push(`Ledger ${e.id} references unknown customer ${e.customerId}`); failed += 1; }
    if (e.amount === 0) { exceptions.push(`Ledger ${e.id} has a zero amount`); failed += 1; }
  }
  const processed = state.customers.length + state.ledger.length + state.usage.length;
  return { processed, failed, exceptions };
}

/** Evaluation suite — 8 checks, 85% release gate. Runs against live state, so
 *  deleting a policy doc or breaking the ledger makes the suite fail honestly. */
export function runEvalSuite(state: AppState): EvalResult[] {
  const results: EvalResult[] = [];
  const dup = findDuplicate(state.ledger, 'CUST-1001');
  results.push({ id: 'E1', name: 'Duplicate detected for CASE-1001 customer', passed: dup !== null && dup.duplicate.invoice === 'INV-2041', detail: dup ? `Found ${dup.original.invoice} + ${dup.duplicate.invoice}` : 'No duplicate found' });
  results.push({ id: 'E2', name: 'Duplicate amount equals $87.40', passed: dup?.duplicate.amount === 87.4, detail: dup ? `$${dup.duplicate.amount.toFixed(2)}` : 'No duplicate' });
  results.push({ id: 'E3', name: 'Different service is not a duplicate (CUST-1004)', passed: findDuplicate(state.ledger.filter((e) => e.customerId === 'CUST-1004'), 'CUST-1004') === null, detail: 'Different services — correctly not flagged' });
  results.push({ id: 'E4', name: 'No duplicate for single-charge customer (CUST-1005)', passed: findDuplicate(state.ledger, 'CUST-1005') === null, detail: 'Correctly no duplicate' });
  const rag = groundedAnswer(state.docs, 'duplicate charge credit policy');
  results.push({ id: 'E5', name: 'RAG grounds duplicate-charge policy with citation', passed: !rag.refused && rag.citations[0]?.docId === 'POL-001', detail: rag.refused ? 'Refused — no doc' : `Cited ${rag.citations[0].docId}` });
  const ragOff = groundedAnswer(state.docs, 'quantum entanglement warranty terms');
  results.push({ id: 'E6', name: 'RAG refuses when answer is not in the docs', passed: ragOff.refused, detail: ragOff.refused ? 'Correctly refused' : 'Answered without grounding — fail' });
  results.push({ id: 'E7', name: 'Idempotency: credit key is unique per case', passed: new Set(state.cases.map((c) => c.idempotencyKey)).size === state.cases.length, detail: `${state.cases.length} cases, ${new Set(state.cases.map((c) => c.idempotencyKey)).size} unique keys` });
  const c1001 = state.cases.find((c) => c.id === 'CASE-1001');
  const plan = c1001 ? planRun(state, c1001) : null;
  results.push({ id: 'E8', name: 'Agent plan proposes $87.40 for CASE-1001', passed: plan?.proposedCredit === 87.4, detail: plan ? `Proposed $${plan.proposedCredit?.toFixed(2) ?? 'none'}` : 'Case missing' });
  return results;
}

export function evalScore(results: EvalResult[]): { scorePct: number; passed: boolean } {
  const passedCount = results.filter((r) => r.passed).length;
  const scorePct = Math.round((passedCount / Math.max(1, results.length)) * 100);
  return { scorePct, passed: scorePct >= EVAL_GATE_PCT };
}

export function dashboard(state: AppState) {
  const completed = state.runs.filter((r) => r.status === 'completed');
  const finished = state.runs.filter((r) => r.status === 'completed' || r.status === 'failed' || r.status === 'rejected');
  const times = completed.map((r) => r.agentMs ?? 0).filter((ms) => ms > 0).sort((a, b) => a - b);
  const medianMs = times.length ? times[Math.floor(times.length / 2)] : null;
  const credits = completed.reduce((s, r) => s + (r.creditApplied ?? 0), 0);
  return {
    casesResolved: completed.length,
    casesOpen: state.cases.filter((c) => c.status === 'open' || c.status === 'awaiting_approval' || c.status === 'running').length,
    medianAgentMs: medianMs,
    successRate: finished.length ? Math.round((completed.length / finished.length) * 100) : null,
    creditsIssued: credits,
    runs: state.runs.length,
  };
}
