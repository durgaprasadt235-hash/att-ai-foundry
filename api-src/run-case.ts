// POST /api/run-case — stateless planning phase (steps 1–5) of the agent.
// Body: { case, customers, ledger, usage, tickets, docs, live_llm? } — the
// caller posts its current state; the API returns the plan, proposed credit,
// or an honest failure. It never posts a credit: that happens only after
// human approval in the app. Same deterministic engine as src/lib/engine.ts.
//
// live_llm: when the caller passes live_llm: true AND the GROQ_API_KEY
// environment variable is set (Vercel project env var — never in code, never
// in git, never in the request body), Groq (openai/gpt-oss-120b) picks each
// STAIR leaf from the TOC allowlist and drafts the customer summary. Every
// pick is validated against the allowlist again in the engine; an invalid
// pick, a rate limit, or a missing key falls back to the deterministic
// engine and the response says so (live_llm: "unavailable, deterministic
// fallback"). Human approval still gates every credit and plan change.
import { planRun } from '../src/lib/engine';
import { GroqClient, groundingQueryForCaseType } from '../src/lib/groq';
import type { AppState, Case } from '../src/lib/types';
import { enforceRateLimit, jsonError } from '../src/lib/api-utils';
import { stateTraceForRun } from '../src/lib/agent';
import { redactPII } from '../src/lib/redact';

const GROQ_MODEL = 'openai/gpt-oss-120b';

/** Grounding queries a case type needs, in order. Outage needs two. */
function groundingQueries(caseType: string): string[] {
  const first = groundingQueryForCaseType(caseType);
  if (!first) return [];
  if (caseType === 'outage') return [first, 'outage service credit'];
  return [first];
}

export default async function handler(req: any, res: any): Promise<void> {
  const runId = `RUN-${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`;
  const traceId = `TRC-${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`;
  const t0 = Date.now();
  try {
  if (req.method !== 'POST') { jsonError(res, 405, 'Method not allowed. Use POST.'); return; }
  if (!enforceRateLimit(req, res)) return;
  const body = req.body ?? {};
  const c = body.case as Case | undefined;
  if (!c || !c.id || !c.customerId) { jsonError(res, 400, 'Body must include case { id, customerId, type, amount, idempotencyKey }.'); return; }
  const state = {
    customers: body.customers ?? [], ledger: body.ledger ?? [], usage: body.usage ?? [],
    tickets: body.tickets ?? [], cases: body.cases ?? [c], runs: [], docs: body.docs ?? [],
    pipelines: [], pipelineRuns: [], evalRuns: [], audit: [], notifications: [], seededAt: '',
    orders: body.orders ?? [], stairTrees: body.stairTrees ?? [],
  } as AppState;

  let liveLlm = 'off';
  let liveLeafByQuery: Record<string, string> = {};
  let liveSummary: string | null = null;
  if (body.live_llm === true) {
    try {
      const groq = GroqClient.fromEnv();
      const leaves = (state.stairTrees ?? []).flatMap((t) => t.leaves);
      for (const query of groundingQueries(c.type)) {
        liveLeafByQuery[query] = await groq.pickLeaf(query, leaves);
      }
      liveLlm = 'groq';
    } catch (e) {
      // Any Groq failure — missing key, 429, 404, 5xx, timeout, invalid
      // pick — is a deterministic fallback, never a faked answer.
      liveLlm = 'unavailable, deterministic fallback';
      liveLeafByQuery = {};
    }
  }

  const plan = planRun(state, c, { liveLeafByQuery, liveLlm, liveSummary });

  if (liveLlm === 'groq' && !plan.failureReason && plan.proposedAction) {
    try {
      const groq = GroqClient.fromEnv();
      liveSummary = await groq.draftSummary(
        `${c.id} (${c.type}): ${c.description ?? ''}`, plan.citation ?? '', plan.proposedAction);
      plan.liveSummary = liveSummary;
    } catch {
      // A failed summary does not change the plan, which was computed
      // deterministically; the live_llm status stays 'groq' (leaf picks worked).
      liveSummary = null;
    }
  }

  // Redact phone/email from step details before responding, and map the
  // run onto the explicit agent state machine (see src/lib/agent.ts).
  const steps = plan.steps.map((s) => ({ ...s, detail: redactPII(s.detail) }));
  const agentStateTrace = stateTraceForRun({
    id: runId, caseId: c.id, traceId, startedAt: new Date().toISOString(),
    status: plan.failureReason ? 'failed' : 'awaiting_approval',
    steps: plan.steps.map((s) => ({ ...s, ms: 0, status: s.status })),
    proposedCredit: plan.proposedCredit, creditApplied: null, agentMs: null,
    idempotencyKey: c.idempotencyKey,
  });
  res.status(200).json({
    runId,
    traceId,
    durationMs: Date.now() - t0,
    caseId: c.id,
    status: plan.failureReason ? 'failed' : 'awaiting_approval',
    failureReason: plan.failureReason,
    proposedCredit: plan.proposedCredit,
    citation: plan.citation,
    steps,
    agentStateTrace,
    liveLlm,
    liveLeafPicks: liveLeafByQuery,
    liveSummary,
    llmModel: liveLlm === 'groq' ? GROQ_MODEL : null,
    audit: {
      id: `AUD-${runId.slice(4)}`, at: new Date().toISOString(), actor: 'agent',
      action: plan.failureReason ? 'run_failed' : 'awaiting_approval',
      detail: redactPII(plan.failureReason ?? `Plan proposed for ${c.id}`),
      // Staff accountability (backend only, never rendered on a screen):
      // demo mode has no signed-in operator, so the single labelled id.
      operatorId: 'demo-operator',
      runId, durationMs: Date.now() - t0, traceId,
    },
    note: 'Planning only. A credit is posted only after human approval in the app; this endpoint moves no money.',
  });
  } catch (e) {
    // Never a 500 HTML page and never an uncaught throw.
    jsonError(res, 500, 'Run failed', e instanceof Error ? e.message : String(e));
  }
}
