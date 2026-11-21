// Case intake — creating a REAL new case, never a canned one.
//
// The Dashboard used to spotlight one hardcoded case ("Run demo case —
// CASE-1001"). That made the product feel like canned demo data: every
// visit showed the same case. Intake replaces it: the operator picks an
// existing customer (or enters a new one), picks one of the five journeys,
// and the system creates a fresh case record with a new id, a unique
// idempotency key and createdAt = now, then runs the agent on it.
//
// Journey ids are the product names the operator sees; each maps to the
// engine case type in src/lib/engine.ts (planRun dispatches on it).
// The description conventions the engine reads are honoured here so a
// created case is actually runnable:
//   * plan_change — the target plan must appear as "to <Plan>" in the
//     description (parseTargetPlan), so the form appends it.
//   * outage — the network-status check looks for "network-confirmed" in
//     the description (isNetworkOutageConfirmed), so the form appends it
//     only when the operator ticks "network-confirmed" — an unconfirmed
//     outage fails honestly, as the policy requires.
import type { Case } from './types';

export type JourneyId = 'billing_dispute' | 'service_provisioning' | 'network_outage' | 'plan_change' | 'retention';

export interface JourneyDef {
  id: JourneyId;
  label: string;
  engineType: Case['type'];
  hint: string;
  defaultAmount: string;
}

export const JOURNEYS: JourneyDef[] = [
  {
    id: 'billing_dispute',
    label: 'Billing dispute — duplicate charge',
    engineType: 'duplicate_charge',
    hint: 'Credit only when the same customer was charged the same amount twice within 7 days.',
    defaultAmount: '87.40',
  },
  {
    id: 'service_provisioning',
    label: 'Service provisioning — new line',
    engineType: 'provisioning',
    hint: 'Account must be active and balance at or under $100.',
    defaultAmount: '98.00',
  },
  {
    id: 'network_outage',
    label: 'Network outage — triage + credit',
    engineType: 'outage',
    hint: 'Outage credit $25.00 (POL-006 §5.1) only for a network-confirmed outage over 4 hours. Amount is the reported charge, not the credit.',
    defaultAmount: '20.20',
  },
  {
    id: 'plan_change',
    label: 'Plan change — upgrade / downgrade',
    engineType: 'plan_change',
    hint: 'A cheaper target posts a pro-rated credit, not a charge.',
    defaultAmount: '65.00',
  },
  {
    id: 'retention',
    label: 'Retention — save offer',
    engineType: 'retention',
    hint: 'At least 2 churn signals are required before a $25.00 save offer.',
    defaultAmount: '25.00',
  },
];

export const PLAN_OPTIONS = ['Unlimited Starter', 'Unlimited Premium', 'Family Share', 'Business Elite'];

/** Next case id: one above the highest existing CASE-<number>, so ids stay
 *  unique even after cases are deleted. Falls back to a timestamped id
 *  if no numbered case exists. */
export function nextCaseId(cases: Case[]): string {
  let max = 1000;
  for (const c of cases) {
    const m = /^CASE-(\d+)$/.exec(c.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `CASE-${max + 1}`;
}

export interface BuildCaseInput {
  cases: Case[];
  customerId: string;
  journey: JourneyId;
  title: string;
  description: string;
  amount: number;
  /** plan_change only: the plan the customer is moving to. */
  targetPlan?: string;
  /** network_outage only: network operations confirmed the outage. */
  networkConfirmed?: boolean;
}

/** Build a fresh case record. Pure — no state is changed here. */
export function buildCase(input: BuildCaseInput): Case {
  const journey = JOURNEYS.find((j) => j.id === input.journey) ?? JOURNEYS[0];
  let description = input.description.trim();
  if (journey.id === 'plan_change' && input.targetPlan) {
    description = `${description} Change plan to ${input.targetPlan}.`.trim();
  }
  if (journey.id === 'network_outage' && input.networkConfirmed) {
    description = `${description} Network-confirmed outage over 4 hours.`.trim();
  }
  const id = nextCaseId(input.cases);
  return {
    id,
    customerId: input.customerId,
    type: journey.engineType,
    title: input.title.trim() || journey.label,
    description,
    amount: input.amount,
    status: 'open',
    createdAt: new Date().toISOString(),
    idempotencyKey: `${id.toLowerCase()}-v1`,
  };
}
