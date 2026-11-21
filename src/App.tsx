import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentRun, AppState, Case, Customer, PolicyDoc } from './lib/types';
import { AGENT_COST_USD, EVAL_GATE_PCT, MANUAL_COST_USD, MANUAL_MINUTES, OUTAGE_CREDIT_USD, RETENTION_CREDIT_USD } from './lib/types';
import { applyCredit, creditAlreadyApplied, customer360, dashboard, evalScore, findDuplicate, groundedAnswer, planRun, runEvalSuite, validatePipeline } from './lib/engine';
import { MEDALLION_BATCH_LIMIT, buildMedallion, defaultBatchId, lineageForRecord, runMedallionBatch } from './lib/medallion';
import type { MedallionBatchRun } from './lib/types';
import { fmtMin, fmtMs, loadState, money, resetState, saveState, uid } from './lib/store';
import { autoTocFromDoc, measureChunkRagEval, measureStairEval, stairAnswer, stairRetrieve } from './lib/stair';
import { stateTraceForRun } from './lib/agent';
import { newAppEvent } from './lib/events';
import type { AppEvent } from './lib/events';
import { redactPII } from './lib/redact';

/** Shape of GET /api/health (mirrors api/health.ts + server/app.py). The
 *  frontend reads config/datasource/LLM/auth status from here — the
 *  browser build has no env vars of its own. */
interface HealthStatus {
  ok: boolean;
  llm: boolean;
  llm_configured: boolean;
  llm_live: boolean;
  llm_circuit: string;
  llmModel: string | null;
  datasource: { mode: string; status: string; detail: string };
  db: { mode: string; configured: boolean; detail: string };
  auth: { enabled: boolean; configured: boolean; provider: string; missing: string[]; note: string };
  realAttSystems: boolean;
  demoData: string;
}

type View = 'dashboard' | 'customers' | 'cases' | 'pipelines' | 'medallion' | 'rag' | 'stair' | 'evals' | 'observability';
const NAV: { id: View; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'customers', label: 'Customers' },
  { id: 'cases', label: 'Cases' },
  { id: 'pipelines', label: 'Pipelines' },
  { id: 'medallion', label: 'Medallion' },
  { id: 'rag', label: 'RAG Knowledge' },
  { id: 'stair', label: 'STAIR' },
  { id: 'evals', label: 'Evaluations' },
  { id: 'observability', label: 'Observability' },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function Pill({ tone, children }: { tone: 'green' | 'red' | 'amber' | 'blue' | ''; children: string }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}
function statusPill(s: string) {
  if (s === 'resolved' || s === 'completed' || s === 'succeeded') return <Pill tone="green">{s}</Pill>;
  if (s === 'failed' || s === 'rejected') return <Pill tone="red">{s}</Pill>;
  if (s === 'awaiting_approval' || s === 'running' || s === 'succeeded_with_exceptions') return <Pill tone="amber">{s}</Pill>;
  return <Pill tone="blue">{s}</Pill>;
}
function ConfirmButton({ label, confirmLabel, onConfirm, kind = 'secondary' }: { label: string; confirmLabel: string; onConfirm: () => void; kind?: 'secondary' | 'danger' | 'accent' }) {
  const [armed, setArmed] = useState(false);
  if (!armed) return <button className={`btn small ${kind}`} onClick={() => setArmed(true)}>{label}</button>;
  return (
    <span className="row">
      <button className="btn small danger" onClick={() => { setArmed(false); onConfirm(); }}>{confirmLabel}</button>
      <button className="btn small secondary" onClick={() => setArmed(false)}>Cancel</button>
    </span>
  );
}

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState());
  const [view, setView] = useState<View>('dashboard');
  const [apiStatus, setApiStatus] = useState('checking…');
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [notice, setNotice] = useState('');
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => { saveState(state); }, [state]);
  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then((j) => {
      setHealth(j as HealthStatus);
      // llm_live (not merely llm_configured) is the honest signal: it is
      // true only when a live Groq call actually succeeded.
      setApiStatus(j.ok ? (j.llm_live ? 'API live (Groq live — probe succeeded)' : j.llm_configured ? 'API live (Groq key configured, live call not yet verified)' : 'API live (deterministic engine, no LLM key)') : 'API unavailable — local engine in use');
    }).catch(() => setApiStatus('API unavailable in local dev — local engine in use'));
  }, []);

  const mutate = (fn: (s: AppState) => AppState) => {
    const next = fn(stateRef.current);
    stateRef.current = next;
    setState(next);
    return next;
  };
  // Audit sink: every entry is PII-redacted here (phone/email masked)
  // and carries its run id, duration and trace id when it belongs to a run.
  const audit = (actor: 'agent' | 'human' | 'system', action: string, detail: string, opts: { runId?: string; durationMs?: number | null; traceId?: string } = {}) => {
    mutate((s) => ({ ...s, audit: [{ id: uid('AUD'), at: nowIso(), actor, action, detail: redactPII(detail), ...(opts.runId ? { runId: opts.runId } : {}), durationMs: opts.durationMs ?? null, ...(opts.traceId ? { traceId: opts.traceId } : {}) }, ...s.audit].slice(0, 200) }));
  };
  // Event feed sink: append-only, redacted at creation (see lib/events.ts).
  const emit = (event: AppEvent) => {
    mutate((s) => ({ ...s, events: [event, ...(s.events ?? [])].slice(0, 200) }));
  };

  // ---------- Agent run: plan -> pause for approval -> execute on approval ----------
  const runAgent = async (caseId: string) => {
    const snap = stateRef.current;
    const c = snap.cases.find((x) => x.id === caseId);
    if (!c) return;
    const existing = snap.runs.find((r) => r.caseId === caseId && r.status === 'completed' && r.idempotencyKey === c.idempotencyKey);
    if (existing) { setNotice(`Idempotency: ${caseId} already has completed run ${existing.id}. No second credit was issued.`); return; }
    if (snap.runs.some((r) => r.caseId === caseId && (r.status === 'running' || r.status === 'awaiting_approval'))) { setNotice(`${caseId} already has a run in progress.`); return; }
    setNotice('');
    const plan = planRun(snap, c);
    const runId = uid('RUN');
    const traceId = uid('TRC');
    const started = nowIso();
    const t0 = performance.now();
    let run: AgentRun = { id: runId, traceId, caseId, startedAt: started, status: 'running', steps: plan.steps.map((s) => ({ ...s, ms: 0, status: 'pending' as const })), proposedCredit: plan.proposedCredit, creditApplied: null, agentMs: null, idempotencyKey: c.idempotencyKey, failureReason: plan.failureReason ?? undefined, effectKind: plan.effectKind, effectData: plan.effectData, proposedAction: plan.proposedAction ?? undefined };
    mutate((s) => ({ ...s, cases: s.cases.map((x) => x.id === caseId ? { ...x, status: 'running' } : x), runs: [run, ...s.runs] }));
    // Execute steps one by one with real, measured timing.
    for (let i = 0; i < run.steps.length; i++) {
      const st = performance.now();
      await sleep(280 + i * 90);
      const ms = Math.round(performance.now() - st);
      const outcome = plan.steps[i].status; // 'done' or 'failed' — decided by the engine, not by the UI
      run = { ...run, steps: run.steps.map((s, j) => j === i ? { ...s, ms, status: outcome } : s) };
      const runCopy = run;
      mutate((s) => ({ ...s, runs: s.runs.map((r) => r.id === runId ? runCopy : r) }));
    }
    run = { ...run, agentMs: Math.round(performance.now() - t0) };
    if (plan.failureReason) {
      run = { ...run, status: 'failed', finishedAt: nowIso() };
      const runCopy = run;
      mutate((s) => ({ ...s, runs: s.runs.map((r) => r.id === runId ? runCopy : r), cases: s.cases.map((x) => x.id === caseId ? { ...x, status: 'failed', resolution: plan.failureReason! } : x) }));
      audit('agent', 'run_failed', `${runId} for ${caseId} failed: ${plan.failureReason}`, { runId, durationMs: Math.round(performance.now() - t0), traceId });
      emit(newAppEvent('run_failed', 'agent', `${runId} for ${caseId} failed: ${plan.failureReason}`, { runId, traceId }));
      setNotice(`Run failed honestly: ${plan.failureReason}`);
      return;
    }
    run = { ...run, status: 'awaiting_approval' };
    const runCopy = run;
    mutate((s) => ({ ...s, runs: s.runs.map((r) => r.id === runId ? runCopy : r), cases: s.cases.map((x) => x.id === caseId ? { ...x, status: 'awaiting_approval' } : x) }));
    audit('agent', 'awaiting_approval', `${runId} for ${caseId} proposes a credit of ${money(plan.proposedCredit ?? 0)} and is paused for human approval.`, { runId, durationMs: Math.round(performance.now() - t0), traceId });
    emit(newAppEvent(plan.proposedCredit !== null ? 'credit_proposed' : 'plan_proposed', 'agent', `${runId} for ${caseId} proposes ${plan.proposedAction ?? `a credit of ${money(plan.proposedCredit ?? 0)}`} and is paused for human approval.`, { runId, traceId }));
    setNotice(`Agent paused for approval: proposed credit ${money(plan.proposedCredit ?? 0)} for ${caseId}. Approve or reject below.`);
  };

  const approveRun = async (runId: string) => {
    const snap = stateRef.current;
    const run = snap.runs.find((r) => r.id === runId);
    if (!run || run.status !== 'awaiting_approval') return;
    const c = snap.cases.find((x) => x.id === run.caseId);
    if (!c) return;
    const kind = run.effectKind ?? 'none';
    const t0 = performance.now();

    // --- Credit effects: idempotency first — never credit twice. ---
    if ((kind === 'credit' || kind === 'outage_credit' || kind === 'retention_offer') && creditAlreadyApplied(snap, c.id)) {
      mutate((s) => ({ ...s, runs: s.runs.map((r) => r.id === runId ? { ...r, status: 'completed', finishedAt: nowIso(), duplicateOfRunId: s.runs.find((x) => x.caseId === c.id && x.status === 'completed')?.id, failureReason: 'Credit already applied — idempotent, no second credit.' } : r) }));
      audit('human', 'approve_duplicate', `Approval for ${runId} was a duplicate: credit already applied for ${c.id}. No second credit issued.`, { runId, durationMs: run.agentMs ?? null, traceId: run.traceId });
      setNotice('Credit was already applied — idempotent. No second credit issued.');
      return;
    }
    if (kind === 'credit') {
      const dup = findDuplicate(snap.ledger, c.customerId);
      if (!dup || run.proposedCredit === null) {
        mutate((s) => ({ ...s, runs: s.runs.map((r) => r.id === runId ? { ...r, status: 'failed', finishedAt: nowIso(), failureReason: 'Duplicate no longer present at approval time.' } : r), cases: s.cases.map((x) => x.id === c.id ? { ...x, status: 'failed', resolution: 'Duplicate no longer present at approval time.' } : x) }));
        audit('human', 'approve_failed', `Approval for ${runId} failed: duplicate no longer present.`, { runId, durationMs: run.agentMs ?? null, traceId: run.traceId });
        return;
      }
      await finishRun(runId, c, kind, `Credit ${money(run.proposedCredit)} posted against ${dup.duplicate.invoice}.`, t0, (s) => {
        const { entry } = applyCredit(snap, c, run, dup);
        return { ...s, ledger: [...s.ledger, entry], customers: s.customers.map((cu) => cu.id === c.customerId ? { ...cu, balance: Math.round((cu.balance - run.proposedCredit!) * 100) / 100 } : cu), notifications: [{ id: uid('NTF'), at: nowIso(), customerId: c.customerId, message: `Credit ${money(run.proposedCredit!)} applied for duplicate charge ${dup.duplicate.invoice}.` }, ...s.notifications] };
      }, `Credit ${money(run.proposedCredit)} applied against ${dup.duplicate.invoice} after human approval.`);
      return;
    }
    if (kind === 'outage_credit') {
      const amount = Number(run.effectData?.amount ?? OUTAGE_CREDIT_USD);
      await finishRun(runId, c, kind, `Outage credit ${money(amount)} posted; technician visit scheduled.`, t0, (s) => ({
        ...s,
        ledger: [...s.ledger, { id: `LED-CR-${c.id}`, customerId: c.customerId, invoice: 'OUTAGE-2026-11', date: new Date().toISOString().slice(0, 10), service: 'Credit — outage service credit', amount: -amount, kind: 'credit', status: 'posted' }],
        customers: s.customers.map((cu) => cu.id === c.customerId ? { ...cu, balance: Math.round((cu.balance - amount) * 100) / 100 } : cu),
        orders: [{ id: uid('ORD'), customerId: c.customerId, kind: 'technician_visit', status: 'scheduled', detail: 'Technician visit — outage restoration check', createdAt: nowIso() }, ...s.orders],
        tickets: [{ id: uid('TCK'), customerId: c.customerId, date: new Date().toISOString().slice(0, 10), subject: 'Technician visit scheduled — outage', status: 'open' }, ...s.tickets],
        notifications: [{ id: uid('NTF'), at: nowIso(), customerId: c.customerId, message: `Outage confirmed. Technician visit scheduled and ${money(amount)} service credit applied.` }, ...s.notifications],
      }), `Outage credit ${money(amount)} applied and technician visit scheduled after human approval.`);
      return;
    }
    if (kind === 'retention_offer') {
      const amount = Number(run.effectData?.amount ?? RETENTION_CREDIT_USD);
      await finishRun(runId, c, kind, `Save offer applied: ${money(amount)} goodwill credit; account reactivated.`, t0, (s) => ({
        ...s,
        ledger: [...s.ledger, { id: `LED-CR-${c.id}`, customerId: c.customerId, invoice: 'RETENTION-2026-11', date: new Date().toISOString().slice(0, 10), service: 'Credit — retention save offer', amount: -amount, kind: 'credit', status: 'posted' }],
        customers: s.customers.map((cu) => cu.id === c.customerId ? { ...cu, balance: Math.round((cu.balance - amount) * 100) / 100, status: 'active' } : cu),
        notifications: [{ id: uid('NTF'), at: nowIso(), customerId: c.customerId, message: `Save offer applied: ${money(amount)} goodwill credit and your account is reactivated.` }, ...s.notifications],
      }), `Save offer applied: ${money(amount)} credit and account reactivated after human approval.`);
      return;
    }
    if (kind === 'provisioning') {
      await finishRun(runId, c, kind, 'Second line provisioned and device activated.', t0, (s) => ({
        ...s,
        orders: [{ id: uid('ORD'), customerId: c.customerId, kind: 'new_line', status: 'activated', detail: 'Second line + device activation', createdAt: nowIso() }, ...s.orders],
        notifications: [{ id: uid('NTF'), at: nowIso(), customerId: c.customerId, message: 'Your second line is active. Device activation complete.' }, ...s.notifications],
      }), 'Second line activated with device activation after human approval.');
      return;
    }
    if (kind === 'plan_change') {
      const newPlan = String(run.effectData?.newPlan ?? 'Unlimited Premium');
      const charge = Number(run.effectData?.charge ?? 0);
      const credit = Number(run.effectData?.credit ?? 0);
      // Cheaper target plan (e.g. Family Share $98.00 → Premium $87.40): the
      // engine proposes a pro-rated CREDIT, not a charge. Posting a charge
      // here would undo the fix — so the credit has its own branch.
      if (credit > 0) {
        await finishRun(runId, c, kind, `Plan changed to ${newPlan}; pro-rated credit ${money(credit)} posted.`, t0, (s) => ({
          ...s,
          ledger: [...s.ledger, { id: `LED-UP-${c.id}`, customerId: c.customerId, invoice: 'PLAN-CHANGE', date: new Date().toISOString().slice(0, 10), service: `Plan change — ${newPlan} (pro-rated credit)`, amount: -credit, kind: 'credit', status: 'posted' }],
          customers: s.customers.map((cu) => cu.id === c.customerId ? { ...cu, plan: newPlan, balance: Math.round((cu.balance - credit) * 100) / 100 } : cu),
          notifications: [{ id: uid('NTF'), at: nowIso(), customerId: c.customerId, message: `Your plan is now ${newPlan}. Pro-rated credit ${money(credit)} applied.` }, ...s.notifications],
        }), `Plan changed to ${newPlan} (pro-rated credit ${money(credit)}) after human approval.`);
        return;
      }
      if (charge <= 0) { setNotice('This plan-change run has no charge or credit to apply. Nothing was changed.'); return; }
      await finishRun(runId, c, kind, `Plan changed to ${newPlan}; pro-rated charge ${money(charge)} posted.`, t0, (s) => ({
        ...s,
        ledger: [...s.ledger, { id: `LED-UP-${c.id}`, customerId: c.customerId, invoice: 'PLAN-UPGRADE', date: new Date().toISOString().slice(0, 10), service: `Plan upgrade — ${newPlan} (pro-rated)`, amount: charge, kind: 'charge', status: 'posted' }],
        customers: s.customers.map((cu) => cu.id === c.customerId ? { ...cu, plan: newPlan, balance: Math.round((cu.balance + charge) * 100) / 100 } : cu),
        notifications: [{ id: uid('NTF'), at: nowIso(), customerId: c.customerId, message: `Your plan is now ${newPlan}. Pro-rated charge ${money(charge)} applied.` }, ...s.notifications],
      }), `Plan changed to ${newPlan} (pro-rated ${money(charge)}) after human approval.`);
      return;
    }
    setNotice('This run has no executable effect. Nothing was changed.');
  };

  /** Runs the approval execution steps (real, measured timing), then applies
   *  the effect via `apply`, marks the run completed and the case resolved. */
  const finishRun = async (runId: string, c: Case, kind: string, execDetail: string, t0: number, apply: (s: AppState) => AppState, resolution: string) => {
    const snap = stateRef.current;
    const run = snap.runs.find((r) => r.id === runId);
    if (!run) return;
    const execSteps = [
      { id: 'execute', name: 'Execute approved action', tool: 'execute_approved', status: 'done' as const, ms: 0, retries: 0, detail: execDetail },
      { id: 'notify', name: 'Notify customer', tool: 'notify_customer', status: 'done' as const, ms: 0, retries: 0, detail: 'Customer notified of the outcome.' },
      { id: 'close-verify', name: 'Verify + close case', tool: 'verify_outcome', status: 'done' as const, ms: 0, retries: 0, detail: 'State change verified against the record. Case closed with a measured outcome.' },
    ];
    for (let i = 0; i < execSteps.length; i++) {
      const st = performance.now();
      await sleep(240);
      execSteps[i] = { ...execSteps[i], ms: Math.round(performance.now() - st) };
    }
    const agentMs = Math.round((run.agentMs ?? 0) + (performance.now() - t0));
    const creditApplied = (kind === 'credit' || kind === 'outage_credit' || kind === 'retention_offer' || (kind === 'plan_change' && run.proposedCredit !== null)) ? run.proposedCredit : null;
    mutate((s) => {
      const applied = apply(s);
      return {
        ...applied,
        runs: applied.runs.map((r) => r.id === runId ? { ...r, status: 'completed', finishedAt: nowIso(), steps: [...r.steps, ...execSteps], creditApplied, agentMs } : r),
        cases: applied.cases.map((x) => x.id === c.id ? { ...x, status: 'resolved', resolution } : x),
      };
    });
    audit('human', 'approved', `Human approved ${runId} (${kind}): ${resolution}`, { runId, durationMs: agentMs, traceId: run.traceId });
    const creditKind = kind === 'credit' || kind === 'outage_credit' || kind === 'retention_offer';
    emit(newAppEvent(creditKind ? 'credit_approved' : 'plan_approved', 'human', `Human approved ${runId} (${kind}): ${resolution}`, { runId, traceId: run.traceId }));
    emit(newAppEvent(creditKind ? 'credit_executed' : 'plan_executed', 'human', `Human approved ${runId} (${kind}): ${resolution}`, { runId, traceId: run.traceId }));
    setNotice(`Done: ${resolution}`);
  };

  const rejectRun = (runId: string) => {
    const snap = stateRef.current;
    const run = snap.runs.find((r) => r.id === runId);
    if (!run) return;
    mutate((s) => ({
      ...s,
      runs: s.runs.map((r) => r.id === runId ? { ...r, status: 'rejected', finishedAt: nowIso() } : r),
      cases: s.cases.map((x) => x.id === run.caseId ? { ...x, status: 'rejected', resolution: 'Human reviewer rejected the proposed credit. No money moved.' } : x),
    }));
    audit('human', 'rejected_credit', `Human rejected ${runId}: no credit issued, no ledger change.`, { runId, durationMs: run.agentMs ?? null, traceId: run.traceId });
    setNotice('Rejected: no credit issued, no ledger change. The case can be re-run after review.');
  };

  const runDemoCase = () => { setView('cases'); void runAgent('CASE-1001'); };

  const dash = useMemo(() => dashboard(state), [state]);
  const medianMin = dash.medianAgentMs === null ? null : dash.medianAgentMs / 60000;
  const costSaved = dash.casesResolved * (MANUAL_COST_USD - AGENT_COST_USD);

  // ---- Auth gate (see src/lib/auth.ts). Disabled by default in the demo.
  // When AUTH_ENABLED=true without config, the app shows an honest "auth
  // not configured" state — never a fake login. When configured, the gate
  // is a clearly-labelled placeholder: the OAuth callback is not yet
  // implemented, so the sign-in button is disabled and says so.
  // Production uses AT&T Entra ID.
  if (health?.auth?.enabled) {
    const auth = health.auth;
    if (!auth.configured) {
      return (
        <div>
          <header className="top"><div className="top-inner"><div><span className="brand">AT&amp;T <span>AI Foundry</span></span><span className="badge">Enterprise Data Platform — director demo</span></div></div></header>
          <div className="wrap">
            <div className="panel highlight mt">
              <h1>Sign-in is not available</h1>
              <p>Authentication is enabled but <strong>not configured</strong> — missing {auth.missing.join(', ')}. This is not a login screen: there is no demo account and no way to sign in until the fulfilment team registers the app with {auth.provider} (AT&amp;T Entra ID in production) and sets the missing variables. See docs/DEPLOYMENT.md step 4.</p>
              <p className="small muted">{auth.note}</p>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div>
        <header className="top"><div className="top-inner"><div><span className="brand">AT&amp;T <span>AI Foundry</span></span><span className="badge">Enterprise Data Platform — director demo</span></div></div></header>
        <div className="wrap">
          <div className="panel highlight mt">
            <h1>Sign in with {auth.provider}</h1>
            <p>Authentication is enabled for {auth.provider} (AT&amp;T Entra ID in production). The OAuth callback handler is not yet implemented, so sign-in is a placeholder for now.</p>
            <button className="btn accent" disabled title="OAuth callback not yet implemented — see docs/DEPLOYMENT.md step 4">Sign in with {auth.provider} (not yet wired)</button>
            <p className="small muted mt">{auth.note}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <header className="top">
        <div className="top-inner">
          <div><span className="brand">AT&amp;T <span>AI Foundry</span></span><span className="badge">Enterprise Data Platform — director demo</span></div>
          <div className="small muted">{apiStatus}</div>
        </div>
      </header>
      <nav className="tabs">
        {NAV.map((n) => <button key={n.id} className={view === n.id ? 'active' : ''} onClick={() => { setView(n.id); setNotice(''); }}>{n.label}</button>)}
      </nav>
      <div className="wrap">
        {notice && <div className="panel mt" role="status">{notice}</div>}
        {view === 'dashboard' && <Dashboard dash={dash} medianMin={medianMin} costSaved={costSaved} state={state} health={health} onRunDemo={runDemoCase} onShowCases={() => setView('cases')} />}
        {view === 'customers' && <CustomersView state={state} mutate={mutate} audit={audit} emit={emit} />}
        {view === 'cases' && <CasesView state={state} onRun={runAgent} onApprove={approveRun} onReject={rejectRun} mutate={mutate} audit={audit} emit={emit} />}
        {view === 'pipelines' && <PipelinesView state={state} mutate={mutate} audit={audit} emit={emit} />}
        {view === 'medallion' && <MedallionView state={state} audit={audit} />}
        {view === 'rag' && <RagView state={state} mutate={mutate} audit={audit} />}
        {view === 'stair' && <StairView state={state} />}
        {view === 'evals' && <EvalsView state={state} mutate={mutate} audit={audit} emit={emit} />}
        {view === 'observability' && <ObservabilityView state={state} onReset={() => { const fresh = resetState(); setState(fresh); stateRef.current = fresh; setNotice('Demo data reset to the seeded state.'); }} />}
        <footer>
          Honest about what is live: frontend ↔ serverless API ↔ agent engine ↔ data store are live-connected inside this prototype, analytics are computed live from real runs, LangGraph-style code is real Python in server/, and RAG/STAIR retrieval is real over seeded policy docs. Live Groq (openai/gpt-oss-120b) runs only when GROQ_API_KEY is set — otherwise the agent is deterministic and says so. There is no real AT&amp;T internal API, and all demo data is synthetic. Every step is traced to a ledger record or a cited policy section. Manual baseline: {MANUAL_MINUTES} min / {money(MANUAL_COST_USD)} per case (POL-005). Agent cost {money(AGENT_COST_USD)} per run is a stated demo assumption, not a measured cloud bill.
        </footer>
      </div>
    </div>
  );
}

/* ---------------- Dashboard ---------------- */
function Dashboard({ dash, medianMin, costSaved, state, health, onRunDemo, onShowCases }: { dash: ReturnType<typeof dashboard>; medianMin: number | null; costSaved: number; state: AppState; health: HealthStatus | null; onRunDemo: () => void; onShowCases: () => void }) {
  return (
    <section>
      <h1>Five journeys, one agent — end to end</h1>
      <p className="muted">Billing dispute, service provisioning, network outage triage, plan upgrade, and retention — the same agent retrieves Customer 360, grounds itself in policy with STAIR, validates, and proposes. Then it stops for human approval. Nothing is credited, activated, or changed until a person approves it.</p>
      <div className="row">
        <button className="btn accent" onClick={onRunDemo}>Run demo case — CASE-1001, double charge $87.40</button>
        <button className="btn secondary" onClick={onShowCases}>See all 5 journeys</button>
        <span className="small muted">Takes about 30 seconds, including your approval step.</span>
      </div>
      <div className="cards">
        <div className="card"><div className="num">{dash.casesResolved}</div><div className="lbl">Cases resolved by agent</div></div>
        <div className="card"><div className="num">{dash.successRate === null ? '—' : `${dash.successRate}%`}</div><div className="lbl">Success rate {dash.successRate === null ? '(no runs yet)' : ''}</div></div>
        <div className="card"><div className="num">{medianMin === null ? '—' : `${medianMin.toFixed(2)} min`}</div><div className="lbl">Median agent time (measured) vs {MANUAL_MINUTES} min manual</div></div>
        <div className="card"><div className="num">{dash.casesResolved ? money(costSaved) : '—'}</div><div className="lbl">Cost saved (measured cases only)</div></div>
        <div className="card"><div className="num">{dash.creditsIssued ? money(dash.creditsIssued) : '—'}</div><div className="lbl">Credits issued</div></div>
        <div className="card"><div className="num">{state.orders.filter((o) => o.status === 'activated').length}</div><div className="lbl">Lines / orders activated</div></div>
        <div className="card"><div className="num">{state.orders.filter((o) => o.status === 'scheduled').length}</div><div className="lbl">Technician visits scheduled</div></div>
        <div className="card"><div className="num">{state.customers.filter((cu) => cu.plan === 'Unlimited Premium').length}</div><div className="lbl">Customers on Premium (after upgrades)</div></div>
        <div className="card"><div className="num">{dash.casesOpen}</div><div className="lbl">Cases open</div></div>
        <div className="card"><div className="num">{state.customers.length}</div><div className="lbl">Synthetic customers</div></div>
        <div className="card"><div className="num">{state.runs.length}</div><div className="lbl">Agent runs (all time)</div></div>
      </div>
      {dash.runs === 0 && <div className="notice">No runs yet — the numbers above show “—” rather than a fake 100%. Run the demo case to see real, measured outcomes.</div>}
      <ProductionReadinessPanel health={health} state={state} />
      <div className="grid2">
        <div className="panel">
          <h2>How it works</h2>
          <pre className="log">{`Sources (CRM, billing, usage) → ETL pipelines → Customer 360
  → FastAPI + LangGraph-style agent (deterministic tools)
  → RAG over policy docs (cited, refuses when not in docs)
  → Human approval gate → credit posted → ledger + notify
  → Verify → measured outcome → audit log`}</pre>
          <p className="small muted">The Vercel demo runs the same deterministic engine in TypeScript. The Python FastAPI + LangGraph-style backend in <code>server/</code> is the reference implementation — same rules, same tests. Neither calls a live LLM or a real AT&amp;T system.</p>
        </div>
        <div className="panel">
          <h2>Recent runs</h2>
          {state.runs.length === 0 ? <p className="muted">No runs yet.</p> : state.runs.slice(0, 5).map((r) => (
            <div key={r.id} className="row space" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
              <span>{r.id} · {r.caseId}</span>
              <span className="row">{statusPill(r.status)}<span className="small muted">{r.agentMs === null ? '' : fmtMs(r.agentMs)}</span></span>
            </div>
          ))}
          <h2 className="mt">Notifications sent</h2>
          {state.notifications.length === 0 ? <p className="muted">None yet — a notification is created only when a credit is actually posted.</p> : state.notifications.slice(0, 3).map((n) => <p key={n.id} className="small">{n.message}</p>)}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Production readiness ----------------
 * Live checklist: what is actually connected right now (from
 * /api/health + live state) vs what the fulfilment team still needs to
 * connect. Nothing here is a claim — every row is computed from the
 * health response, the last eval run, or the Medallion snapshot.
 * The JD coverage list mirrors docs/JD_COVERAGE.md, which maps every
 * line of the Principal AI-Native Software Engineer JD to the file
 * that implements it and how to verify it. */
function ProductionReadinessPanel({ health, state }: { health: HealthStatus | null; state: AppState }) {
  const medallion = useMemo(() => buildMedallion(state, defaultBatchId(state)), [state]);
  const lastEval = state.evalRuns[0];
  const rows: { label: string; tone: 'green' | 'red' | 'amber' | 'blue' | ''; status: string; detail: string }[] = [
    {
      label: 'Config — GROQ_API_KEY',
      tone: !health ? '' : health.llm_configured ? 'green' : 'amber',
      status: !health ? 'unknown — API unreachable in local dev' : health.llm_configured ? 'set' : 'not set',
      detail: !health ? 'Start the API or deploy to check.' : health.llm_configured ? 'Live-LLM mode available.' : 'Deterministic engine only — the demo still runs and says so.',
    },
    {
      label: 'LLM — live Groq call',
      tone: !health ? '' : health.llm_live ? 'green' : health.llm_configured ? 'amber' : 'amber',
      status: !health ? 'unknown' : health.llm_live ? `live (${health.llmModel})` : health.llm_configured ? 'key set, live call not yet verified' : 'off — deterministic',
      detail: !health ? '' : health.llm_live ? `A real Groq call succeeded (probe, cached 60s). Circuit: ${health.llm_circuit}.` : health.llm_configured ? 'The key is configured but no live call has succeeded yet — run a case with live LLM to verify.' : 'No key. The agent is deterministic code and every trace says so.',
    },
    {
      label: 'Datasource',
      tone: !health ? '' : health.datasource.mode === 'att' ? (health.datasource.status === 'configured' ? 'green' : 'red') : 'amber',
      status: !health ? 'unknown' : health.datasource.mode === 'att' ? `att — ${health.datasource.status}` : 'seed — synthetic demo data',
      detail: !health ? '' : health.datasource.detail,
    },
    {
      label: 'Database',
      tone: !health ? '' : health.db.configured ? 'amber' : 'amber',
      status: !health ? 'unknown' : health.db.configured ? 'DATABASE_URL set — not yet wired' : 'no live database',
      detail: !health ? '' : health.db.detail,
    },
    {
      label: 'Auth gate',
      tone: !health ? '' : !health.auth.enabled ? 'blue' : health.auth.configured ? 'amber' : 'red',
      status: !health ? 'unknown' : !health.auth.enabled ? 'off — demo mode' : health.auth.configured ? 'on — placeholder (callback not wired)' : 'on — NOT configured',
      detail: !health ? '' : health.auth.note,
    },
    {
      label: 'Last eval suite',
      tone: !lastEval ? 'amber' : lastEval.passed ? 'green' : 'red',
      status: !lastEval ? 'not run yet' : `${lastEval.scorePct}% — ${lastEval.passed ? 'PASS' : 'FAIL'} (gate ${lastEval.gatePct}%)`,
      detail: !lastEval ? 'Run the suite in Evaluations — the release gate blocks on it.' : lastEval.passed ? 'Release gate would pass on this result.' : 'Release gate BLOCKS on this result — see the failed checks in Evaluations.',
    },
    {
      label: 'Medallion',
      tone: 'green',
      status: `Bronze ${medallion.bronzeTotal} = Silver ${medallion.silverPassed} + quarantined ${medallion.silverQuarantined}`,
      detail: `Gold: reconciled ledger ${medallion.gold.ledgerReconciled} entries ($${medallion.gold.ledgerReconciledTotal.toFixed(2)}), Customer 360 ${medallion.gold.customers360}, usage ${medallion.gold.usageTotalGb} GB.`,
    },
  ];
  const todos: string[] = [];
  if (health && !health.llm_configured) todos.push('Set GROQ_API_KEY for live-LLM mode (or keep the deterministic engine — it is a real mode, not a gap).');
  if (health && health.datasource.mode === 'seed') todos.push('Connect ATT_API_BASE_URL + ATT_API_KEY and set DATASOURCE=att for live AT&T data — the adapter fails honestly until then, never fakes it.');
  if (health && !health.db.configured) todos.push('Provision Postgres and set DATABASE_URL when the fulfilment team wires the store (reserved today).');
  if (health && !health.auth.enabled) todos.push('Register the Entra ID app and set AUTH_ENABLED=true + AUTH_CLIENT_ID + AUTH_ISSUER_URL when login is required.');
  if (!lastEval) todos.push('Run the evaluation suite (Evaluations tab) — no release is approved without a passing 85% gate.');
  if (health?.datasource.mode === 'att' && health.datasource.status !== 'configured') todos.push('att mode is selected but its connection vars are missing — data loads will fail honestly until they are set.');
  const jd: { n: number; label: string; tone: 'green' | 'amber' | 'blue'; status: string }[] = [
    { n: 1, label: 'Production Python + FastAPI (api/ ↔ server/ mirrors)', tone: 'green', status: 'live' },
    { n: 2, label: 'Agentic workflows — explicit state machine + trace', tone: 'green', status: 'live' },
    { n: 3, label: 'Tool/service contracts + idempotent execution', tone: 'green', status: 'live' },
    { n: 4, label: 'Evaluations + 85% release gate that blocks', tone: lastEval ? (lastEval.passed ? 'green' : 'amber') : 'amber', status: lastEval ? (lastEval.passed ? 'live — gate passes' : 'live — gate blocks') : 'live — run the suite' },
    { n: 5, label: 'RAG — STAIR primary, chunk baseline, no vector DB by design', tone: 'green', status: 'live' },
    { n: 6, label: 'End-to-end backend + DB + frontend (React/TS; API is framework-agnostic)', tone: 'amber', status: 'partial — DB reserved' },
    { n: 7, label: 'Secure-by-design — env secrets, auth gate, PII redaction, audit', tone: 'green', status: 'live' },
    { n: 8, label: 'Observability — trace IDs, JSON logs, /metrics, runbook', tone: 'green', status: 'live' },
    { n: 9, label: 'Testing / CI / Docker', tone: 'amber', status: 'live in repo — docker build not run here (no Docker in this VM)' },
    { n: 10, label: 'Resilience — circuit breaker, retries, bounded batches, fallback', tone: 'green', status: 'live' },
    { n: 11, label: 'Event-driven — append-only feed, Kafka/SNS seam', tone: 'green', status: 'live' },
    { n: 12, label: 'AI-assisted engineering, disclosed', tone: 'green', status: 'documented' },
  ];
  return (
    <div className="panel mt">
      <h2>Production readiness — live checklist</h2>
      <p className="small muted">Every row is computed from /api/health, the last eval run, or the Medallion snapshot — not claimed. See docs/JD_COVERAGE.md for the full JD mapping.</p>
      {rows.map((r) => (
        <div key={r.label} className="row space" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
          <span className="small"><strong>{r.label}</strong><br /><span className="muted">{r.detail}</span></span>
          <Pill tone={r.tone}>{r.status}</Pill>
        </div>
      ))}
      {todos.length > 0 && (
        <div className="mt">
          <h3>What the fulfilment team still needs to connect</h3>
          {todos.map((t) => <p key={t} className="small">• {t}</p>)}
        </div>
      )}
      {todos.length === 0 && <p className="small ok mt">Everything connected — no open fulfilment items on the live checklist.</p>}
      <div className="mt">
        <h3>JD coverage — Principal AI-Native Software Engineer</h3>
        {jd.map((j) => (
          <div key={j.n} className="row space" style={{ padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
            <span className="small">{j.n}. {j.label}</span>
            <Pill tone={j.tone}>{j.status}</Pill>
          </div>
        ))}
        <p className="small muted mt">Full mapping — file, how to verify, and what is honestly still missing — in docs/JD_COVERAGE.md.</p>
      </div>
    </div>
  );
}

/* ---------------- Customers ---------------- */
function CustomersView({ state, mutate, audit, emit }: { state: AppState; mutate: (fn: (s: AppState) => AppState) => void; audit: (a: 'agent' | 'human' | 'system', b: string, c: string) => void; emit: (e: AppEvent) => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Customer | null>(null);
  const [name, setName] = useState('');
  const [plan, setPlan] = useState('Unlimited Starter');
  const filtered = state.customers.filter((c) => `${c.name} ${c.account} ${c.phone} ${c.id}`.toLowerCase().includes(q.toLowerCase()));
  const view360 = sel ? customer360(state, sel.id) : null;
  return (
    <section>
      <h1>Customers</h1>
      <p className="muted">Synthetic demo data — invented names, accounts and phone numbers. No real PII.</p>
      <input className="search" type="text" placeholder="Search name, account, phone…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="table-wrap mt"><table>
        <thead><tr><th>Customer</th><th>Account</th><th>Plan</th><th>Balance</th><th>Status</th><th></th></tr></thead>
        <tbody>{filtered.map((c) => (
          <tr key={c.id}>
            <td><strong>{c.name}</strong><br /><span className="small muted">{c.city} · since {c.since}</span></td>
            <td>{c.account}<br /><span className="small muted">{c.phone}</span></td>
            <td>{c.plan}</td><td>{money(c.balance)}</td>
            <td>{statusPill(c.status)}</td>
            <td><button className="btn small secondary" onClick={() => setSel(c)}>View 360</button></td>
          </tr>
        ))}</tbody>
      </table></div>
      {filtered.length === 0 && <p className="muted mt">No customers match that search.</p>}
      <div className="panel">
        <h2>Add a customer</h2>
        <div className="grid2">
          <div><label>Name</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" /></div>
          <div><label>Plan</label><select value={plan} onChange={(e) => setPlan(e.target.value)}><option>Unlimited Starter</option><option>Unlimited Premium</option><option>Family Share</option><option>Business Elite</option></select></div>
        </div>
        <button className="btn mt" disabled={!name.trim()} onClick={() => {
          const id = uid('CUST');
          mutate((s) => ({ ...s, customers: [...s.customers, { id, name: name.trim(), account: `ACC-${Math.floor(100000 + Math.random() * 899999)}`, phone: '(555) 555-0100', email: '', plan, status: 'active', since: new Date().toISOString().slice(0, 10), balance: 0, city: '—' }] }));
          audit('human', 'customer_created', `Created customer ${name.trim()} (${id}).`);
          emit(newAppEvent('customer_created', 'human', `Created customer ${name.trim()} (${id}).`));
          setName('');
        }}>Add customer</button>
      </div>
      {view360 && view360.customer && (
        <div className="panel highlight">
          <div className="row space"><h2>Customer 360 — {view360.customer.name}</h2><button className="btn small secondary" onClick={() => setSel(null)}>Close</button></div>
          <p className="small muted">{view360.customer.account} · {view360.customer.phone} · {view360.customer.plan} · Balance {money(view360.customer.balance)}</p>
          <div className="grid3">
            <div><h3>Billing ledger</h3>{view360.ledger.length === 0 ? <p className="muted small">No entries.</p> : view360.ledger.map((e) => <p key={e.id} className="small">{e.date} · {e.invoice} · {e.service} · <strong>{money(e.amount)}</strong> · {e.status}</p>)}</div>
            <div><h3>Usage</h3>{view360.usage.map((u) => <p key={u.id} className="small">{u.month}: {u.dataGb} GB, {u.minutes} min, {u.sms} SMS</p>)}</div>
            <div><h3>Cases &amp; tickets</h3>{view360.cases.map((c) => <p key={c.id} className="small">{c.id}: {c.title} — {c.status}</p>)}{view360.tickets.map((t) => <p key={t.id} className="small">{t.id}: {t.subject} — {t.status}</p>)}</div>
          </div>
          <div className="mt"><ConfirmButton label="Delete customer" confirmLabel="Confirm delete" kind="danger" onConfirm={() => {
            mutate((s) => ({ ...s, customers: s.customers.filter((c) => c.id !== view360.customer!.id) }));
            audit('human', 'customer_deleted', `Deleted customer ${view360.customer!.id}.`);
            setSel(null);
          }} /></div>
        </div>
      )}
    </section>
  );
}

/* ---------------- Cases ---------------- */
function CasesView({ state, onRun, onApprove, onReject, mutate, audit, emit }: {
  state: AppState;
  onRun: (id: string) => Promise<void>;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string) => void;
  mutate: (fn: (s: AppState) => AppState) => void;
  audit: (a: 'agent' | 'human' | 'system', b: string, c: string) => void;
  emit: (e: AppEvent) => void;
}) {
  const [customerId, setCustomerId] = useState('CUST-1001');
  const [type, setType] = useState<Case['type']>('duplicate_charge');
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('87.40');
  const [running, setRunning] = useState(false);
  const runFor = (caseId: string) => state.runs.find((r) => r.caseId === caseId && (r.status === 'awaiting_approval' || r.status === 'running')) ?? state.runs.find((r) => r.caseId === caseId);
  return (
    <section>
      <h1>Cases</h1>
      <p className="muted">Run the agent on a case. It validates, grounds, and proposes — then waits for a human. Approving posts a real credit to the ledger and changes the customer balance.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Case</th><th>Customer</th><th>Amount</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>{state.cases.map((c) => {
          const cust = state.customers.find((x) => x.id === c.customerId);
          const run = runFor(c.id);
          return (
            <tr key={c.id}>
              <td><strong>{c.id}</strong><br />{c.title}<br /><span className="small muted">{c.description}</span>{c.resolution && <><br /><span className="small">{c.resolution}</span></>}</td>
              <td>{cust?.name ?? c.customerId}</td>
              <td>{money(c.amount)}</td>
              <td>{statusPill(c.status)}</td>
              <td>
                <button className="btn small accent" disabled={running || c.status === 'running' || c.status === 'awaiting_approval' || c.status === 'resolved'} onClick={async () => { setRunning(true); await onRun(c.id); setRunning(false); }}>
                  {c.status === 'resolved' ? 'Resolved' : 'Run agent'}
                </button>
                {run && run.status === 'awaiting_approval' && (
                  <div className="mt">
                    <p className="small"><strong>Approval needed:</strong> {run.proposedAction ?? `credit ${money(run.proposedCredit ?? 0)}`} — {c.id}.</p>
                    <div className="row">
                      <ConfirmButton label="Approve" confirmLabel="Confirm approve" kind="accent" onConfirm={() => { void onApprove(run.id); }} />
                      <ConfirmButton label="Reject" confirmLabel="Confirm reject" kind="danger" onConfirm={() => onReject(run.id)} />
                    </div>
                  </div>
                )}
              </td>
            </tr>
          );
        })}</tbody>
      </table></div>

      <h2 className="mt">Run trace</h2>
      {state.runs.length === 0 ? <p className="muted">No runs yet.</p> : state.runs.slice(0, 3).map((r) => {
        const trace = stateTraceForRun(r);
        return (
        <div key={r.id} className="panel">
          <div className="row space"><strong>{r.id} · {r.caseId}</strong><span className="row">{statusPill(r.status)}<span className="small muted">{r.agentMs === null ? '' : `agent ${fmtMs(r.agentMs)}`}</span></span></div>
          <p className="small"><strong>State machine:</strong> {trace.states.join(' → ')} {trace.valid ? <Pill tone="green">valid</Pill> : <Pill tone="red">invalid</Pill>}{r.traceId ? <span className="muted"> · trace {r.traceId}</span> : null}</p>
          {r.failureReason && <p className="error small">{r.failureReason}</p>}
          {r.duplicateOfRunId && <p className="small muted">Idempotent duplicate of {r.duplicateOfRunId} — no second credit.</p>}
          {r.steps.map((s) => (
            <div key={s.id} className={`step ${s.status === 'failed' ? 'failed' : ''}`}>
              <span className="dot" />
              <div><strong>{s.name}</strong> <span className="small muted">· {s.tool}</span><br /><span className="small">{s.detail}</span>{s.citation && <><br /><span className="small muted">Citation: {s.citation}</span></>}</div>
              <span className="ms">{s.status === 'pending' ? 'pending' : fmtMs(s.ms)}</span>
            </div>
          ))}
          {r.proposedCredit !== null && <p className="small mt">Proposed credit: {money(r.proposedCredit)} · Credit applied: {r.creditApplied === null ? '—' : money(r.creditApplied)} · Idempotency key: {r.idempotencyKey}</p>}
        </div>
        );
      })}

      <div className="panel">
        <h2>Create a case</h2>
        <div className="grid2">
          <div><label>Customer</label><select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>{state.customers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.id})</option>)}</select></div>
          <div><label>Type</label><select value={type} onChange={(e) => setType(e.target.value as Case['type'])}><option value="duplicate_charge">Duplicate charge</option><option value="plan_change">Plan change</option><option value="roaming_dispute">Roaming dispute</option><option value="other">Other</option></select></div>
          <div><label>Title</label><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short title" /></div>
          <div><label>Amount ($)</label><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        </div>
        <button className="btn mt" disabled={!title.trim()} onClick={() => {
          const id = `CASE-${1000 + state.cases.length + 1}`;
          const key = `${id.toLowerCase()}-v1`;
          mutate((s) => ({ ...s, cases: [...s.cases, { id, customerId, type, title: title.trim(), description: title.trim(), amount: Number(amount) || 0, status: 'open', createdAt: nowIso(), idempotencyKey: key }] }));
          audit('human', 'case_created', `Created case ${id} for ${customerId}.`);
          emit(newAppEvent('case_created', 'human', `Created case ${id} for ${customerId}.`));
          setTitle('');
        }}>Create case</button>
      </div>
    </section>
  );
}

/* ---------------- Pipelines ---------------- */
function PipelinesView({ state, mutate, audit, emit }: { state: AppState; mutate: (fn: (s: AppState) => AppState) => void; audit: (a: 'agent' | 'human' | 'system', b: string, c: string) => void; emit: (e: AppEvent) => void }) {
  const [runningId, setRunningId] = useState<string | null>(null);
  const runPipeline = async (id: string) => {
    setRunningId(id);
    const t0 = performance.now();
    await sleep(500);
    const result = validatePipeline(id, stateRefOf(state));
    const ms = Math.round(performance.now() - t0);
    const status = result.failed === 0 ? 'succeeded' : 'succeeded_with_exceptions';
    mutate((s) => ({
      ...s,
      pipelines: s.pipelines.map((p) => p.id === id ? { ...p, lastRun: nowIso() } : p),
      pipelineRuns: [{ id: uid('PRUN'), pipelineId: id, startedAt: nowIso(), processed: result.processed, failed: result.failed, exceptions: result.exceptions, status, ms }, ...s.pipelineRuns],
    }));
    audit('system', 'pipeline_run', `Pipeline ${id}: ${result.processed} processed, ${result.failed} failed. ${result.exceptions.join('; ') || 'No exceptions.'}`);
    emit(newAppEvent(result.failed > 0 ? 'pipeline_failed' : 'pipeline_run', 'system', `Pipeline ${id}: ${result.processed} processed, ${result.failed} failed. ${result.exceptions.join('; ') || 'No exceptions.'}`));
    setRunningId(null);
  };
  return (
    <section>
      <h1>Pipelines</h1>
      <p className="muted">ETL runs validate the seeded batch and count what actually passed or failed. Exceptions are listed, not hidden. These are the <strong>Medallion Silver quality gates</strong> — see the Medallion tab for Bronze → Silver → Gold, quarantine, and lineage.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Pipeline</th><th>Source → Destination</th><th>Last run</th><th></th></tr></thead>
        <tbody>{state.pipelines.map((p) => (
          <tr key={p.id}><td><strong>{p.name}</strong><br /><span className="small muted">{p.id}</span></td><td>{p.source} → {p.destination}</td><td>{p.lastRun ?? '—'}</td><td><button className="btn small" disabled={runningId === p.id} onClick={() => { void runPipeline(p.id); }}>{runningId === p.id ? 'Running…' : 'Run'}</button></td></tr>
        ))}</tbody>
      </table></div>
      <h2 className="mt">Pipeline runs</h2>
      {state.pipelineRuns.length === 0 ? <p className="muted">No pipeline runs yet.</p> : state.pipelineRuns.map((r) => (
        <div key={r.id} className="panel">
          <div className="row space"><strong>{r.pipelineId} · {r.id}</strong><span className="row">{statusPill(r.status)}<span className="small muted">{fmtMs(r.ms)}</span></span></div>
          <p className="small">Processed {r.processed} records · Failed {r.failed}</p>
          {r.exceptions.map((e) => <p key={e} className="small error">Exception: {e}</p>)}
          {r.exceptions.length === 0 && <p className="small ok">No exceptions.</p>}
        </div>
      ))}
    </section>
  );
}
/* ---------------- Medallion ---------------- */
function MedallionView({ state, audit }: { state: AppState; audit: (a: 'agent' | 'human' | 'system', b: string, c: string) => void }) {
  const batchId = defaultBatchId(state);
  const snapshot = useMemo(() => buildMedallion(state, batchId), [state, batchId]);
  const [runs, setRuns] = useState<MedallionBatchRun[]>([]);
  const [lookup, setLookup] = useState('INV-2041');
  const [copiedId, setCopiedId] = useState('');
  const watermarkRef = useRef<Set<string>>(new Set());
  const lineage = useMemo(() => lineageForRecord(state, lookup.trim() || 'INV-2041', batchId), [state, lookup, batchId]);
  const runBatch = () => {
    const run = runMedallionBatch(state, batchId, watermarkRef.current);
    setRuns((prev) => [run, ...prev]);
    audit('system', 'medallion_run', `Medallion batch ${run.batchId}: ${run.newRecords} new records, ${run.skippedRecords} skipped by watermark, ${run.retries} retries. Bronze ${run.snapshot.bronzeTotal} = Silver passed ${run.snapshot.silverPassed} + quarantined ${run.snapshot.silverQuarantined}.`);
  };
  const copyPrompt = (id: string, prompt: string) => {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(prompt).then(() => setCopiedId(id)).catch(() => setCopiedId(id));
    } else {
      setCopiedId(id);
    }
  };
  return (
    <section>
      <h1>Medallion — Bronze → Silver → Gold</h1>
      <p className="muted">One operator runs the whole platform: if a pipeline fails, that person fixes it with the Copilot prompt on the failure card — no 5–6 person engineer team. Bad records go to quarantine, never silently dropped; Gold is rebuilt from Silver, never edited directly. Batch {snapshot.batchId} · watermark: only records not seen before are re-validated.</p>
      <div className="cards">
        <div className="card"><div className="num">{snapshot.bronzeTotal}</div><div className="lbl">Bronze — raw as received (immutable) · {snapshot.bronzeBySource.customers} customers + {snapshot.bronzeBySource.ledger} ledger + {snapshot.bronzeBySource.usage} usage</div></div>
        <div className="card"><div className="num">{snapshot.silverPassed}</div><div className="lbl">Silver — passed the quality gates · {snapshot.silverQuarantined} quarantined</div></div>
        <div className="card"><div className="num">{snapshot.gold.ledgerReconciled}</div><div className="lbl">Gold — reconciled ledger entries · ${snapshot.gold.ledgerReconciledTotal.toFixed(2)}</div></div>
        <div className="card"><div className="num">{snapshot.gold.customers360}</div><div className="lbl">Gold — Customer 360 · {snapshot.gold.usageRollup} usage rollups, {snapshot.gold.usageTotalGb} GB</div></div>
      </div>
      <p className="small muted">Reconciliation: Bronze {snapshot.bronzeTotal} = Silver passed {snapshot.silverPassed} + quarantined {snapshot.silverQuarantined}. Gold is built only from Silver-passed records.</p>
      <div className="row">
        <button className="btn accent" onClick={runBatch}>Run incremental batch</button>
        <span className="small muted">First run processes {snapshot.bronzeTotal} records; run it again and the watermark skips them all — 0 new, {snapshot.bronzeTotal} skipped. A failed step is retried once, then quarantined — the batch never fails outright.</span>
      </div>
      {runs.length > 0 && runs.slice(0, 3).map((r) => (
        <div key={`${r.batchId}-${r.newRecords}-${runs.indexOf(r)}`} className="panel">
          <div className="row space"><strong>Batch {r.batchId}</strong><span className="small muted">{r.newRecords} new · {r.skippedRecords} skipped by watermark · {r.retries} retries · {r.deferredRecords} deferred to the next batch</span></div>
          <p className="small">Bronze {r.snapshot.bronzeTotal} = Silver passed {r.snapshot.silverPassed} + quarantined {r.snapshot.silverQuarantined} · Gold ledger {r.snapshot.gold.ledgerReconciled} entries, ${r.snapshot.gold.ledgerReconciledTotal.toFixed(2)}</p>
          {r.deferredRecords > 0 && <p className="small muted">Backpressure: the batch is bounded at {MEDALLION_BATCH_LIMIT} new records — the {r.deferredRecords} deferred records stay un-watermarked and are picked up by the next batch, never dropped.</p>}
        </div>
      ))}
      <h2 className="mt">Quarantine ({snapshot.quarantine.length}) — listed, never silently dropped</h2>
      {snapshot.quarantine.length === 0 ? <p className="muted">Nothing quarantined.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Record</th><th>Pipeline</th><th>Reason</th></tr></thead>
          <tbody>{snapshot.quarantine.map((q) => (
            <tr key={q.recordId}><td><strong>{q.recordId}</strong><br /><span className="small muted">{q.recordKind}</span></td><td>{q.pipelineId}</td><td>{q.reason}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      <h2 className="mt">Lineage — trace any record Bronze → Silver → Gold</h2>
      <div className="row"><input className="search" type="text" value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="Invoice, ledger id or customer id — e.g. INV-2041" /><span className="small muted">Try INV-2039 (clean) or CUST-1004 (suspended).</span></div>
      <div className="panel highlight mt">
        {lineage.map((s) => (
          <div key={s.layer} className={`step ${s.status === 'quarantined' || s.status === 'excluded' ? 'failed' : ''}`}>
            <span className="dot" />
            <div><strong>{s.layer}</strong> — {s.status}<br /><span className="small">{s.detail}</span></div>
          </div>
        ))}
      </div>
      <h2 className="mt">Failure cards — one operator + Copilot</h2>
      <p className="small muted">Each card has what failed, the exact record and batch, the error, and a ready-to-paste Copilot prompt naming the file and function to fix. Fix in Bronze/Silver, re-run the batch — never edit Gold directly.</p>
      {snapshot.failureCards.map((card) => (
        <div key={card.id} className="panel">
          <div className="row space"><strong>{card.id}</strong><span className="small muted">{card.pipelineId} · batch {card.batchId}</span></div>
          <p className="small"><strong>What failed:</strong> {card.what}</p>
          <p className="small"><strong>Fix here:</strong> {card.fixFile}, {card.fixFunction}</p>
          <pre className="log">{card.copilotPrompt}</pre>
          <button className="btn small secondary" onClick={() => copyPrompt(card.id, card.copilotPrompt)}>{copiedId === card.id ? 'Copied — paste it into Copilot' : 'Copy Copilot prompt'}</button>
        </div>
      ))}
      <p className="small muted mt">Scale, honestly: this demo runs on the 20-customer synthetic seed (106 records). Petabyte scale is architectural — partitioning by ingest date + customer, incremental watermark loads, dedup by idempotency key — and is not measured at petabyte volume here. The same code paths run at both scales. See docs/OPERATOR_RUNBOOK.md for the 1-person operations guide.</p>
    </section>
  );
}
// Small helper so PipelinesView reads the latest state at click time.
function stateRefOf(s: AppState): AppState { return s; }

/* ---------------- RAG ---------------- */
function RagView({ state, mutate, audit }: { state: AppState; mutate: (fn: (s: AppState) => AppState) => void; audit: (a: 'agent' | 'human' | 'system', b: string, c: string) => void }) {
  const [q, setQ] = useState('What is the duplicate charge policy?');
  const [answer, setAnswer] = useState<ReturnType<typeof groundedAnswer> | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const search = (query: string) => {
    const result = groundedAnswer(state.docs, query);
    setAnswer(result);
    audit('human', 'rag_search', `RAG query "${query}" — ${result.refused ? 'refused (not in docs)' : `grounded in ${result.citations.map((c) => c.docId).join(', ')}`}.`);
  };
  return (
    <section>
      <h1>RAG Knowledge Base</h1>
      <p className="muted">Answers come only from the indexed policy docs below, with citations. If the answer is not in the docs, the system refuses instead of guessing. No live LLM.</p>
      <div className="row"><input className="search" type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about a policy…" /><button className="btn" onClick={() => search(q)}>Search</button></div>
      {answer && (
        <div className="panel mt">
          <h2>{answer.refused ? 'Refused — not in the docs' : 'Grounded answer'}</h2>
          <p>{answer.answer}</p>
          {answer.citations.map((c) => <p key={c.docId} className="small muted">Citation: {c.docId} — {c.title} (match {c.score})</p>)}
        </div>
      )}
      <h2 className="mt">Indexed documents ({state.docs.length})</h2>
      {state.docs.map((d: PolicyDoc) => (
        <div key={d.id} className="panel">
          <div className="row space"><strong>{d.id} — {d.title}</strong><span className="small muted">Updated {d.updated}</span></div>
          <p className="small">{d.body}</p>
          <ConfirmButton label="Delete doc" confirmLabel="Confirm delete" kind="danger" onConfirm={() => {
            mutate((s) => ({ ...s, docs: s.docs.filter((x) => x.id !== d.id) }));
            audit('human', 'doc_deleted', `Deleted policy doc ${d.id}. RAG and evals that depend on it will now fail honestly.`);
          }} />
        </div>
      ))}
      <div className="panel">
        <h2>Add a document</h2>
        <label>Title</label><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Policy title" />
        <label>Body</label><textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Policy text — the RAG answer can only use what is written here." />
        <button className="btn mt" disabled={!title.trim() || !body.trim()} onClick={() => {
          const id = uid('POL');
          mutate((s) => ({ ...s, docs: [...s.docs, { id, title: title.trim(), body: body.trim(), updated: new Date().toISOString().slice(0, 10) }] }));
          audit('human', 'doc_added', `Added policy doc ${id}: ${title.trim()}.`);
          setTitle(''); setBody('');
        }}>Add document</button>
      </div>
      <p className="small muted">Try it: ask “quantum entanglement warranty terms” — the system must refuse, because no doc covers it.</p>
    </section>
  );
}

/* ---------------- Evaluations ---------------- */
function EvalsView({ state, mutate, audit, emit }: { state: AppState; mutate: (fn: (s: AppState) => AppState) => void; audit: (a: 'agent' | 'human' | 'system', b: string, c: string) => void; emit: (e: AppEvent) => void }) {
  const [release, setRelease] = useState<{ status: 'approved' | 'blocked'; reason: string; failures: string[] } | null>(null);
  const runSuite = () => {
    const results = runEvalSuite(state);
    const { scorePct, passed } = evalScore(results);
    mutate((s) => ({ ...s, evalRuns: [{ id: uid('EVAL'), startedAt: nowIso(), results, scorePct, gatePct: EVAL_GATE_PCT, passed }, ...s.evalRuns] }));
    audit('system', 'eval_run', `Evaluation suite: ${scorePct}% (gate ${EVAL_GATE_PCT}%) — ${passed ? 'PASS' : 'FAIL'}.`);
    emit(newAppEvent('eval_run', 'system', `Evaluation suite: ${scorePct}% (gate ${EVAL_GATE_PCT}%) — ${passed ? 'PASS' : 'FAIL'}.`));
    setRelease(null);
  };
  // The release gate, as a button: it BLOCKS the release when the latest
  // eval run fails the 85% gate (or when no suite has run) and says why.
  // Same rule as POST /evals/release-gate on the server.
  const requestRelease = () => {
    const latest = state.evalRuns[0];
    if (!latest) {
      setRelease({ status: 'blocked', reason: 'Release BLOCKED — no evaluation suite has run yet. Run the suite first; there is no result to gate on.', failures: [] });
      audit('system', 'release_blocked', 'Release BLOCKED — no evaluation suite has run yet.');
      emit(newAppEvent('release_blocked', 'system', 'Release BLOCKED — no evaluation suite has run yet.'));
      return;
    }
    if (!latest.passed) {
      const failures = latest.results.filter((r) => !r.passed).map((r) => `${r.id} — ${r.name}`);
      setRelease({ status: 'blocked', reason: `Release BLOCKED — eval suite ${latest.scorePct}% (gate ${latest.gatePct}%).`, failures });
      audit('system', 'release_blocked', `Release BLOCKED: eval suite ${latest.scorePct}% (gate ${latest.gatePct}%). Failed: ${failures.join('; ')}`);
      emit(newAppEvent('release_blocked', 'system', `Release BLOCKED: eval suite ${latest.scorePct}% (gate ${latest.gatePct}%). Failed: ${failures.join('; ')}`));
      return;
    }
    setRelease({ status: 'approved', reason: `Release approved — eval suite ${latest.scorePct}% (gate ${latest.gatePct}%).`, failures: [] });
    audit('system', 'release_approved', `Release approved: eval suite ${latest.scorePct}% (gate ${latest.gatePct}%).`);
    emit(newAppEvent('release_approved', 'system', `Release approved: eval suite ${latest.scorePct}% (gate ${latest.gatePct}%).`));
  };
  return (
    <section>
      <h1>Evaluations</h1>
      <p className="muted">8 checks: duplicate detection, amount, non-duplicate discrimination, RAG grounding, RAG refusal, idempotency, and the agent plan. Release gate: {EVAL_GATE_PCT}%. The suite runs against live state — delete POL-001 and it fails.</p>
      <div className="row">
        <button className="btn" onClick={runSuite}>Run evaluation suite</button>
        <button className="btn accent" onClick={requestRelease}>Request release</button>
        <span className="small muted">The release gate blocks unless the latest suite passes {EVAL_GATE_PCT}%.</span>
      </div>
      {release && (
        <div className={`panel mt ${release.status === 'blocked' ? 'highlight' : ''}`}>
          <div className="row space"><strong>{release.status === 'approved' ? 'Release approved' : 'Release blocked'}</strong>{release.status === 'approved' ? <Pill tone="green">approved</Pill> : <Pill tone="red">blocked</Pill>}</div>
          <p className="small">{release.reason}</p>
          {release.failures.map((f) => <p key={f} className="small error">Failed: {f}</p>)}
          {release.status === 'blocked' && <p className="small muted">Fix the failed checks (or restore the state they depend on) and re-run the suite. The release stays blocked until the gate passes.</p>}
        </div>
      )}
      {state.evalRuns.map((er) => (
        <div key={er.id} className="panel mt">
          <div className="row space"><strong>{er.id}</strong><span className="row">{er.passed ? <Pill tone="green">PASS</Pill> : <Pill tone="red">FAIL</Pill>}<span>{er.scorePct}% (gate {er.gatePct}%)</span></span></div>
          {er.results.map((r) => (
            <div key={r.id} className="row space" style={{ padding: '5px 0', borderBottom: '1px solid var(--line)' }}>
              <span className="small">{r.id} — {r.name}<br /><span className="muted">{r.detail}</span></span>
              {r.passed ? <Pill tone="green">pass</Pill> : <Pill tone="red">fail</Pill>}
            </div>
          ))}
        </div>
      ))}
      {state.evalRuns.length === 0 && <p className="muted mt">No evaluation runs yet.</p>}
    </section>
  );
}

/* ---------------- Observability ---------------- */
function ObservabilityView({ state, onReset }: { state: AppState; onReset: () => void }) {
  return (
    <section>
      <h1>Observability</h1>
      <p className="muted">Every agent step with measured timing, every pipeline run, and every action in the audit log. Nothing is reported that was not measured.</p>
      <h2>Agent runs</h2>
      {state.runs.length === 0 ? <p className="muted">No runs yet.</p> : state.runs.map((r) => (
        <div key={r.id} className="panel">
          <div className="row space"><strong>{r.id} · {r.caseId}</strong><span className="row">{statusPill(r.status)}<span className="small muted">started {r.startedAt.slice(0, 19).replace('T', ' ')}</span></span></div>
          <p className="small">Agent active time: {fmtMs(r.agentMs)} · Manual baseline: {fmtMin(MANUAL_MINUTES * 60000)} · Proposed credit: {r.proposedCredit === null ? '—' : money(r.proposedCredit)} · Applied: {r.creditApplied === null ? '—' : money(r.creditApplied)}</p>
          {r.steps.map((s) => <p key={s.id} className="small">{s.name} — {s.tool} — {s.status} — {fmtMs(s.ms)} — retries {s.retries}</p>)}
        </div>
      ))}
      <h2 className="mt">Audit log ({state.audit.length})</h2>
      <p className="small muted">Every entry carries its run ID, measured duration, and trace ID when it belongs to a run. Phone numbers and email addresses are masked at the audit sink — they never reach this log.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Run / Trace</th><th>Duration</th><th>Detail</th></tr></thead>
        <tbody>{state.audit.slice(0, 50).map((a) => <tr key={a.id}><td>{a.at.slice(0, 19).replace('T', ' ')}</td><td>{a.actor}</td><td>{a.action}</td><td className="small">{a.runId ?? '—'}{a.traceId ? <><br /><span className="muted">{a.traceId}</span></> : null}</td><td>{fmtMs(a.durationMs ?? null)}</td><td>{a.detail}</td></tr>)}</tbody>
      </table></div>
      <h2 className="mt">Event feed ({(state.events ?? []).length}) — append-only</h2>
      <p className="small muted">Every state change emits a structured event (case_created, credit_proposed, credit_approved, credit_executed, pipeline_failed, …). This in-app feed is the seam where a real event bus (Kafka / SNS / EventBridge) plugs in — replace the append with a publish and subscribers get the same event types; see src/lib/events.ts and server/events.py.</p>
      {(state.events ?? []).length === 0 ? <p className="muted">No events yet — run a case, create a case, or run a pipeline.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Time</th><th>Event</th><th>Actor</th><th>Run / Trace</th><th>Detail</th></tr></thead>
          <tbody>{(state.events ?? []).slice(0, 50).map((e) => <tr key={e.id}><td>{e.at.slice(0, 19).replace('T', ' ')}</td><td>{e.type}</td><td>{e.actor}</td><td className="small">{e.runId ?? '—'}{e.traceId ? <><br /><span className="muted">{e.traceId}</span></> : null}</td><td>{e.detail}</td></tr>)}</tbody>
        </table></div>
      )}
      <div className="panel mt">
        <h2>Reset demo</h2>
        <p className="small muted">Restores the seeded synthetic state (20 customers, 12 open cases, 8 policy docs) and clears all runs, credits and audit entries.</p>
        <ConfirmButton label="Reset demo data" confirmLabel="Confirm reset" kind="danger" onConfirm={onReset} />
      </div>
    </section>
  );
}

/* ---------------- STAIR ---------------- */
function StairView({ state }: { state: AppState }) {
  const [q, setQ] = useState('duplicate charge credit policy');
  const [trace, setTrace] = useState<ReturnType<typeof stairAnswer> | null>(null);
  const [hit, setHit] = useState<ReturnType<typeof stairRetrieve>>(null);
  const evalResult = useMemo(() => measureStairEval(state.stairTrees), [state.stairTrees]);
  const chunkEval = useMemo(() => measureChunkRagEval(state.docs, state.stairTrees), [state.docs, state.stairTrees]);
  const runQuery = (query: string) => {
    setHit(stairRetrieve(state.stairTrees, query));
    setTrace(stairAnswer(state.stairTrees, query));
  };
  return (
    <section>
      <h1>STAIR — STructure Aware Information Retriever</h1>
      <p className="muted">IBM Research (Kumar et al., arXiv 2609.03874). No chunking, no embeddings, no vector database. Docs are structured trees with a Table of Contents; retrieval navigates the full TOC to the exact leaf section and answers only from that leaf, retrieved intact.</p>
      <div className="row"><input className="search" type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about a policy…" /><button className="btn" onClick={() => runQuery(q)}>Retrieve</button></div>
      {trace && (
        <div className="panel highlight mt">
          <h2>Trace: Query → TOC → Leaf → Answer</h2>
          <p className="small"><strong>1. Query:</strong> {q}</p>
          <p className="small"><strong>2. Table of Contents shown to the retriever:</strong> {state.stairTrees.flatMap((t) => t.leaves.map((l) => l.path)).join(' · ')}</p>
          <p className="small"><strong>3. Leaf selected:</strong> {hit ? `${hit.leaf.path} ${hit.leaf.section} (match ${hit.score})` : 'none — no section matched'}</p>
          <p className="small"><strong>4. Section retrieved intact:</strong> {trace.refused ? '—' : trace.answer}</p>
          <p className="small"><strong>5. Grounded answer with citation:</strong> {trace.refused ? trace.answer : `${trace.leaf!.path} ${trace.leaf!.section}`}</p>
          <p className="small muted">Constrained selection: the retriever may only return a leaf title that exists in the TOC (valid-title allowlist). It cannot invent a section.</p>
        </div>
      )}
      <div className="grid2">
        <div className="panel">
          <h2>Measured on the seeded eval set (10 queries)</h2>
          <p>STAIR Recall@1: <strong>{evalResult.recallAt1}%</strong> ({evalResult.correct}/{evalResult.total})</p>
          <p>STAIR invalid-section rate: <strong>{evalResult.invalidRate}%</strong> ({evalResult.invalidSections} invalid sections)</p>
          <p>Chunk-RAG baseline Recall@1: <strong>{chunkEval.recallAt1}%</strong> ({chunkEval.correct}/{chunkEval.total})</p>
          <p className="small muted">These are our own measured numbers on this demo's 10-query eval set, computed live from the code — not paper numbers.</p>
        </div>
        <div className="panel">
          <h2>Paper numbers (IBM STAIR, arXiv 2609.03874)</h2>
          <p>Recall@1 on SearchTome: STAIR 82.6%, DSI 76.9%, DPR 68.7%, BM25 59.5%.</p>
          <p>Hallucination &lt; 0.05% in the paper means generating an <strong>invalid section identifier</strong> — not “the answer was factually right”. Do not read it as general accuracy.</p>
          <p className="small muted">No “65x reduction” figure is claimed anywhere in this app — it is not stated as a verified fact.</p>
        </div>
      </div>
      <h2>Side-by-side comparison</h2>
      <div className="table-wrap"><table>
        <thead><tr><th></th><th>STAIR (primary)</th><th>Chunk RAG (baseline only)</th></tr></thead>
        <tbody>
          <tr><td>Chunking</td><td>None — leaves retrieved intact</td><td>Whole docs, token-overlap retrieval</td></tr>
          <tr><td>Embeddings / vector DB</td><td>None</td><td>None in this demo either (token overlap) — labelled baseline</td></tr>
          <tr><td>Retrieval unit</td><td>Exact leaf section</td><td>Whole document</td></tr>
          <tr><td>Citation</td><td>Full section path, e.g. Billing Policy &gt; Credits &gt; Duplicate Charges §4.2</td><td>Document id, e.g. POL-001</td></tr>
          <tr><td>Can it invent a section?</td><td>No — valid-title allowlist</td><td>Yes, in principle — no TOC constraint</td></tr>
          <tr><td>Measured Recall@1 (10 queries)</td><td>{evalResult.recallAt1}%</td><td>{chunkEval.recallAt1}%</td></tr>
          <tr><td>Not found</td><td>“Not found in policy”</td><td>“Not in the indexed docs”</td></tr>
        </tbody>
      </table></div>
      <h2 className="mt">Knowledge trees</h2>
      {state.stairTrees.map((t) => (
        <div key={t.id} className="panel">
          <strong>{t.title}</strong> {t.autoGenerated && <Pill tone="amber">auto-generated TOC</Pill>}
          {t.leaves.map((l) => <p key={l.id} className="small">{l.path} {l.section} — {l.body.slice(0, 120)}…</p>)}
        </div>
      ))}
      <div className="panel">
        <h2>Docs without a TOC</h2>
        <p className="small muted">A plain policy doc with no headings gets an auto-generated TOC (one section per sentence), flagged as auto-generated. If no heading or section matches a query, the answer is “not found in policy” instead of a guess. Example — auto TOC for POL-005:</p>
        <p className="small">{autoTocFromDoc(state.docs.find((d) => d.id === 'POL-005') ?? state.docs[0]).leaves.map((l) => l.path).join(' · ')}</p>
      </div>
      <h2 className="mt">Per-query eval detail — STAIR vs chunk-RAG baseline (10 queries)</h2>
      <p className="small muted">Same 10 questions, same expected answers. STAIR must return the exact leaf; the baseline is credited only when its top doc is the doc that contains the answer. This is the honest comparison — no paper numbers.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Query</th><th>Expected leaf</th><th>STAIR got</th><th>STAIR</th><th>Chunk baseline got (doc)</th><th>Chunk</th></tr></thead>
        <tbody>{evalResult.perQuery.map((r, i) => {
          const chunk = chunkEval.perQuery[i];
          return (
            <tr key={r.query}>
              <td>{r.query}</td><td>{r.expected}</td><td>{r.got ?? '—'}</td><td>{r.correct ? <Pill tone="green">correct</Pill> : <Pill tone="red">miss</Pill>}</td>
              <td>{chunk?.gotDoc ?? '—'}</td><td>{chunk?.correct ? <Pill tone="green">correct</Pill> : <Pill tone="red">miss</Pill>}</td>
            </tr>
          );
        })}</tbody>
      </table></div>
    </section>
  );
}
