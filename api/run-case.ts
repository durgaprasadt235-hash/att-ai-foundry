// POST /api/run-case — stateless planning phase (steps 1–5) of the agent.
// Body: { case, customers, ledger, usage, tickets, docs } — the caller posts
// its current state; the API returns the plan, proposed credit, or an honest
// failure. It never posts a credit: that happens only after human approval
// in the app. Same deterministic engine as src/lib/engine.ts.
import { planRun } from '../src/lib/engine';
import type { AppState, Case } from '../src/lib/types';

export default function handler(req: any, res: any): void {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed. Use POST.' }); return; }
  const body = req.body ?? {};
  const c = body.case as Case | undefined;
  if (!c || !c.id || !c.customerId) { res.status(400).json({ error: 'Body must include case { id, customerId, type, amount, idempotencyKey }.' }); return; }
  const state = {
    customers: body.customers ?? [], ledger: body.ledger ?? [], usage: body.usage ?? [],
    tickets: body.tickets ?? [], cases: body.cases ?? [c], runs: [], docs: body.docs ?? [],
    pipelines: [], pipelineRuns: [], evalRuns: [], audit: [], notifications: [], seededAt: '',
    orders: body.orders ?? [], stairTrees: body.stairTrees ?? [],
  } as AppState;
  const plan = planRun(state, c);
  res.status(200).json({
    caseId: c.id,
    status: plan.failureReason ? 'failed' : 'awaiting_approval',
    failureReason: plan.failureReason,
    proposedCredit: plan.proposedCredit,
    citation: plan.citation,
    steps: plan.steps,
    note: 'Planning only. A credit is posted only after human approval in the app; this endpoint moves no money.',
  });
}
