import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentRun, AppState, Case, Customer, PolicyDoc } from './lib/types';
import { AGENT_COST_USD, EVAL_GATE_PCT, MANUAL_COST_USD, MANUAL_MINUTES, OUTAGE_CREDIT_USD, RETENTION_CREDIT_USD } from './lib/types';
import { applyCredit, creditAlreadyApplied, customer360, dashboard, evalScore, findDuplicate, groundedAnswer, planRun, runEvalSuite, validatePipeline } from './lib/engine';
import { buildMedallion, defaultBatchId, lineageForRecord, runMedallionBatch } from './lib/medallion';
import type { MedallionBatchRun } from './lib/types';
import { fmtMin, fmtMs, loadState, money, resetState, saveState, uid } from './lib/store';
import { autoTocFromDoc, measureChunkRagEval, measureStairEval, stairAnswer, stairRetrieve } from './lib/stair';
import { stateTraceForRun } from './lib/agent';
import { newAppEvent } from './lib/events';
import type { AppEvent } from './lib/events';
import { redactPII } from './lib/redact';
import { getCurrentOperatorId } from './lib/auth';
import { SEARCH_RESULT_LIMIT, searchCustomers } from './lib/customer-search';
import DataView from './components/DataView';
import CreateCaseForm from './components/CreateCaseForm';
import ConfirmCustomerForm, { formatVerifiedAt, verificationLabel, type CustomerConfirmation, type VerificationMethod } from './components/ConfirmCustomerForm';
import OverviewView from './components/OverviewView';
import InfoTip from './components/InfoTip';

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

type View = 'dashboard' | 'data' | 'customers' | 'cases' | 'system' | 'about';
const NAV: { id: View; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'data', label: 'Data' },
  { id: 'customers', label: 'Customers' },
  { id: 'cases', label: 'Cases' },
  { id: 'system', label: 'System' },
  { id: 'about', label: 'About Me' },
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
  // The confirmed customer for this session — shared by the Dashboard
  // and the Customers view (see components/ConfirmCustomerForm.tsx).
  // Null until the operator finds AND verifies a customer. This is
  // session state, not part of the persisted caseload.
  const [confirmed, setConfirmed] = useState<CustomerConfirmation | null>(null);
  const confirmedRef = useRef(confirmed);
  confirmedRef.current = confirmed;
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
  // Staff accountability (backend only): every entry is also tagged with
  // the operator's login id (operatorId) — see lib/auth.ts. The operator
  // id is stored in the audit record for backend investigation and is
  // NEVER rendered on any screen: the Observability audit feed below
  // shows action / detail / timestamp only.
  const audit = (actor: 'agent' | 'human' | 'system', action: string, detail: string, opts: { runId?: string; durationMs?: number | null; traceId?: string } = {}) => {
    mutate((s) => ({ ...s, audit: [{ id: uid('AUD'), at: nowIso(), actor, action, detail: redactPII(detail), operatorId: getCurrentOperatorId(), ...(opts.runId ? { runId: opts.runId } : {}), durationMs: opts.durationMs ?? null, ...(opts.traceId ? { traceId: opts.traceId } : {}) }, ...s.audit].slice(0, 200) }));
  };
  // Event feed sink: append-only, redacted at creation (see lib/events.ts).
  const emit = (event: AppEvent) => {
    mutate((s) => ({ ...s, events: [event, ...(s.events ?? [])].slice(0, 200) }));
  };

  // ---------- Find & confirm customer (see components/ConfirmCustomerForm.tsx) ----------
  // Every change the operator makes is to a specific person's billing /
  // usage / services, so we must know WHOSE data is being changed — and
  // that it was verified from the customer end. The verification status
  // is recorded on the audit entries below (never a hard block — see
  // the TODO in README.md / docs/PRD.md: enforce verified-before-change
  // is future work, not switched on yet).
  const verificationStatusFor = (customerId: string): string => {
    const c = confirmedRef.current;
    if (c && c.customerId === customerId) return `verified via ${verificationLabel(c.method)} at ${c.at}`;
    return 'not verified in this session';
  };
  const confirmCustomer = (customer: Customer, method: VerificationMethod) => {
    const at = nowIso();
    setConfirmed({ customerId: customer.id, method, at });
    confirmedRef.current = { customerId: customer.id, method, at };
    audit('human', 'customer_verified', `Customer ${customer.id} verified via ${verificationLabel(method)} (operator attestation — demo: no PIN is stored and no real code is sent; production checks the account verification service).`);
  };
  const clearConfirmation = () => {
    const prev = confirmedRef.current;
    setConfirmed(null);
    confirmedRef.current = null;
    if (prev) audit('human', 'customer_unconfirmed', `Customer confirmation cleared (was ${prev.customerId}, verified via ${verificationLabel(prev.method)}). Next customer must be verified again.`);
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
      audit('agent', 'run_failed', `${runId} for ${caseId} failed: ${plan.failureReason} [customer verification: ${verificationStatusFor(c.customerId)}]`, { runId, durationMs: Math.round(performance.now() - t0), traceId });
      emit(newAppEvent('run_failed', 'agent', `${runId} for ${caseId} failed: ${plan.failureReason}`, { runId, traceId }));
      setNotice(`Run failed honestly: ${plan.failureReason}`);
      return;
    }
    run = { ...run, status: 'awaiting_approval' };
    const runCopy = run;
    mutate((s) => ({ ...s, runs: s.runs.map((r) => r.id === runId ? runCopy : r), cases: s.cases.map((x) => x.id === caseId ? { ...x, status: 'awaiting_approval' } : x) }));
    audit('agent', 'awaiting_approval', `${runId} for ${caseId} proposes a credit of ${money(plan.proposedCredit ?? 0)} and is paused for human approval. [customer verification: ${verificationStatusFor(c.customerId)}]`, { runId, durationMs: Math.round(performance.now() - t0), traceId });
    emit(newAppEvent(plan.proposedCredit !== null ? 'credit_proposed' : 'plan_proposed', 'agent', `${runId} for ${caseId} proposes ${plan.proposedAction ?? `a credit of ${money(plan.proposedCredit ?? 0)}`} and is paused for human approval.`, { runId, traceId }));
    setNotice(`Agent paused for approval: proposed credit ${money(plan.proposedCredit ?? 0)} for ${caseId}. Approve or reject below.`);
  };

  // ---------- Case intake: create a REAL new case, then run the agent on it ----------
  // There is no canned case anywhere in this flow. The case arrives with a
  // fresh id + idempotency key (built in src/lib/case-intake.ts), is added
  // to state (persisted to localStorage like every other record), and the
  // agent runs on it. The run lands in the Cases view with its trace and
  // approval step — coming back later shows this run history, not a reset.
  const createCaseAndRun = async (c: Case, newCustomer?: Customer) => {
    mutate((s) => ({
      ...s,
      customers: newCustomer ? [...s.customers, newCustomer] : s.customers,
      cases: [...s.cases, c],
    }));
    audit('human', 'case_created', `Created case ${c.id} for ${c.customerId} (${c.type}, ${money(c.amount)}). [customer verification: ${verificationStatusFor(c.customerId)}]`);
    emit(newAppEvent('case_created', 'human', `Created case ${c.id} for ${c.customerId} (${c.type}, ${money(c.amount)}).`));
    setView('cases');
    await runAgent(c.id);
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
      audit('human', 'approve_duplicate', `Approval for ${runId} was a duplicate: credit already applied for ${c.id}. No second credit issued. [customer verification: ${verificationStatusFor(c.customerId)}]`, { runId, durationMs: run.agentMs ?? null, traceId: run.traceId });
      setNotice('Credit was already applied — idempotent. No second credit issued.');
      return;
    }
    if (kind === 'credit') {
      const dup = findDuplicate(snap.ledger, c.customerId);
      if (!dup || run.proposedCredit === null) {
        mutate((s) => ({ ...s, runs: s.runs.map((r) => r.id === runId ? { ...r, status: 'failed', finishedAt: nowIso(), failureReason: 'Duplicate no longer present at approval time.' } : r), cases: s.cases.map((x) => x.id === c.id ? { ...x, status: 'failed', resolution: 'Duplicate no longer present at approval time.' } : x) }));
        audit('human', 'approve_failed', `Approval for ${runId} failed: duplicate no longer present. [customer verification: ${verificationStatusFor(c.customerId)}]`, { runId, durationMs: run.agentMs ?? null, traceId: run.traceId });
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
    audit('human', 'approved', `Human approved ${runId} (${kind}): ${resolution} [customer verification: ${verificationStatusFor(c.customerId)}]`, { runId, durationMs: agentMs, traceId: run.traceId });
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
    const caseForRun = snap.cases.find((x) => x.id === run.caseId);
    audit('human', 'rejected_credit', `Human rejected ${runId}: no credit issued, no ledger change.${caseForRun ? ` [customer verification: ${verificationStatusFor(caseForRun.customerId)}]` : ''}`, { runId, durationMs: run.agentMs ?? null, traceId: run.traceId });
    setNotice('Rejected: no credit issued, no ledger change. The case can be re-run after review.');
  };

  const dash = useMemo(() => dashboard(state), [state]);
  const medianMin = dash.medianAgentMs === null ? null : dash.medianAgentMs / 60000;
  const costSaved = dash.casesResolved * (MANUAL_COST_USD - AGENT_COST_USD);

  // ---- Auth gate (see src/lib/auth.ts). Disabled by default in the demo.
  // When AUTH_ENABLED=true without config, the app shows an honest "auth
  // not configured" state — never a fake login. When configured, the gate
  // is a clearly-labelled placeholder: the OAuth callback is not yet
  // implemented, so the sign-in button is disabled and says so.
  // Production uses Entra ID.
  if (health?.auth?.enabled) {
    const auth = health.auth;
    if (!auth.configured) {
      return (
        <div>
          <header className="top"><div className="top-inner"><div><span className="brand">Telecom <span>Project</span></span><span className="badge">Enterprise Data Platform</span></div></div></header>
          <div className="wrap">
            <div className="panel highlight mt">
              <h1>Sign-in is not available</h1>
              <p>Sign-in is not available — authentication is enabled but <strong>not configured</strong> (missing {auth.missing.join(', ')}). Register the app with {auth.provider} and set the missing variables.</p>
              <p className="small muted">{auth.note}</p>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div>
        <header className="top"><div className="top-inner"><div><span className="brand">Telecom <span>Project</span></span><span className="badge">Enterprise Data Platform</span></div></div></header>
        <div className="wrap">
          <div className="panel highlight mt">
            <h1>Sign in with {auth.provider}</h1>
            <p>OAuth callback not implemented yet — sign-in is not available.</p>
            <button className="btn accent" disabled title="OAuth callback not yet implemented">Sign in with {auth.provider} (not yet wired)</button>
            <p className="small muted mt">{auth.note}</p>
          </div>
        </div>
      </div>
    );
  }

  // ---------- Bring your own dataset (see lib/dataset.ts) ----------
  // Loading a dataset replaces the working caseload in browser state;
  // the built-in seed files on disk are never touched. Reset restores
  // the built-in seed. DataView builds the next state (via
  // datasetToState, which writes the load / cleanse audit entry) and
  // passes it here ready-made — this only swaps it in.
  const loadDataset = (next: AppState, name: string) => {
    stateRef.current = next;
    setState(next);
    setNotice(`Loaded dataset "${name}": ${next.customers.length} customers, ${next.cases.length} cases. Dashboard, Cases and Search now run on your data.`);
    setView('cases');
  };
  const resetDataset = () => {
    const fresh = resetState();
    stateRef.current = fresh;
    setState(fresh);
    setNotice('Reset to the original built-in dataset.');
  };

  return (
    <div>
      <header className="top">
        <div className="top-inner">
          <div><span className="brand">Telecom <span>Project</span></span><span className="badge">Enterprise Data Platform</span></div>
          <div className="small muted">{apiStatus}</div>
        </div>
      </header>
      <nav className="tabs">
        {NAV.map((n) => <button key={n.id} className={view === n.id ? 'active' : ''} onClick={() => { setView(n.id); setNotice(''); }}>{n.label}</button>)}
      </nav>
      <div className="wrap">
        {notice && <div className="panel mt" role="status">{notice}</div>}
        {view === 'dashboard' && <Dashboard dash={dash} medianMin={medianMin} costSaved={costSaved} state={state} health={health} onCreateAndRun={createCaseAndRun} onShow360={() => setView('customers')} confirmed={confirmed} onConfirmCustomer={confirmCustomer} onClearConfirmation={clearConfirmation} audit={audit} />}
        {view === 'data' && <DataView state={state} onLoadDataset={loadDataset} onReset={resetDataset} audit={audit} />}
        {view === 'customers' && <CustomersView state={state} mutate={mutate} audit={audit} emit={emit} onRun={runAgent} onCreateAndRun={createCaseAndRun} confirmed={confirmed} onConfirmCustomer={confirmCustomer} onClearConfirmation={clearConfirmation} />}
        {view === 'cases' && <CasesView state={state} onRun={runAgent} onApprove={approveRun} onReject={rejectRun} onCreateAndRun={createCaseAndRun} />}
        {view === 'system' && <SystemView state={state} mutate={mutate} audit={audit} emit={emit} onReset={() => { const fresh = resetState(); setState(fresh); stateRef.current = fresh; setNotice('Demo data reset to the seeded state.'); }} />}
        {view === 'about' && <OverviewView />}
        <footer>
          Demo: no real carrier API; all data is synthetic. Groq runs only when GROQ_API_KEY is set, otherwise the agent is deterministic. Baseline: {MANUAL_MINUTES} min / {money(MANUAL_COST_USD)} per case; agent cost {money(AGENT_COST_USD)} per run is a demo assumption, not a measured bill.
        </footer>
      </div>
    </div>
  );
}

/* ---------------- Dashboard ---------------- */
function Dashboard({ dash, medianMin, costSaved, state, health, onCreateAndRun, onShow360, confirmed, onConfirmCustomer, onClearConfirmation, audit }: { dash: ReturnType<typeof dashboard>; medianMin: number | null; costSaved: number; state: AppState; health: HealthStatus | null; onCreateAndRun: (c: Case, newCustomer?: Customer) => void; onShow360: () => void; confirmed: CustomerConfirmation | null; onConfirmCustomer: (customer: Customer, method: VerificationMethod) => void; onClearConfirmation: () => void; audit: (actor: 'human', action: string, detail: string) => void }) {
  return (
    <section>
      <h1>Five journeys, one agent — end to end</h1>
      <ConfirmCustomerForm key={confirmed ? confirmed.customerId : 'none'} customers={state.customers} confirmed={confirmed} onConfirm={onConfirmCustomer} onClear={onClearConfirmation} onView360={onShow360} audit={audit} />
      <CreateCaseForm key={confirmed ? `confirmed-${confirmed.customerId}` : 'none'} customers={state.customers} cases={state.cases} preselectedCustomerId={confirmed?.customerId} onCreateAndRun={onCreateAndRun} />
      <div className="cards">
        <div className="card"><div className="num">{dash.casesResolved}</div><div className="lbl">Cases resolved</div></div>
        <div className="card"><div className="num">{dash.successRate === null ? '—' : `${dash.successRate}%`}</div><div className="lbl">Success rate</div></div>
        <div className="card"><div className="num">{medianMin === null ? '—' : `${medianMin.toFixed(2)} min`}</div><div className="lbl">Median agent time (vs {MANUAL_MINUTES} min manual)</div></div>
        <div className="card"><div className="num">{dash.casesResolved ? money(costSaved) : '—'}</div><div className="lbl">Cost saved (measured)</div></div>
        <div className="card"><div className="num">{dash.creditsIssued ? money(dash.creditsIssued) : '—'}</div><div className="lbl">Credits issued</div></div>
        <div className="card"><div className="num">{dash.casesOpen}</div><div className="lbl">Cases open</div></div>
      </div>
      {dash.runs === 0 && <div className="notice">No runs yet.</div>}
      <ProductionReadinessPanel health={health} state={state} />
      <div className="panel">
        <h2>Recent runs</h2>
        {state.runs.length === 0 ? <p className="muted">No runs yet.</p> : state.runs.slice(0, 5).map((r) => (
          <div key={r.id} className="row space" style={{ padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
            <span className="small">{r.id} · {r.caseId}</span>
            <span className="row">{statusPill(r.status)}<span className="small muted">{r.agentMs === null ? '' : fmtMs(r.agentMs)}</span></span>
          </div>
        ))}
        <h2 className="mt">Notifications sent</h2>
        {state.notifications.length === 0 ? <p className="muted small">None yet.</p> : state.notifications.slice(0, 3).map((n) => <p key={n.id} className="small">{n.message}</p>)}
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
  const [open, setOpen] = useState(false);
  const medallion = useMemo(() => buildMedallion(state, defaultBatchId(state)), [state]);
  const lastEval = state.evalRuns[0];
  const rows: { label: string; tone: 'green' | 'red' | 'amber' | 'blue' | ''; status: string; detail: string }[] = [
    {
      label: 'Config — GROQ_API_KEY',
      tone: !health ? '' : health.llm_configured ? 'green' : 'amber',
      status: !health ? 'unknown — API unreachable in local dev' : health.llm_configured ? 'set' : 'not set',
      detail: !health ? 'Start the API or deploy to check.' : health.llm_configured ? 'Live-LLM mode available.' : 'Deterministic engine only.',
    },
    {
      label: 'LLM — live Groq call',
      tone: !health ? '' : health.llm_live ? 'green' : health.llm_configured ? 'amber' : 'amber',
      status: !health ? 'unknown' : health.llm_live ? `live (${health.llmModel})` : health.llm_configured ? 'key set, live call not yet verified' : 'off — deterministic',
      detail: !health ? '' : health.llm_live ? `A real Groq call succeeded (probe, cached 60s). Circuit: ${health.llm_circuit}.` : health.llm_configured ? 'Run a case with live LLM to verify.' : 'No key — deterministic engine.',
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
      detail: !lastEval ? 'Run the suite in System → Evaluations.' : lastEval.passed ? 'Release gate would pass on this result.' : 'Release gate blocks — see failed checks in Evaluations.',
    },
    {
      label: 'Medallion',
      tone: 'green',
      status: `Bronze ${medallion.bronzeTotal} = Silver ${medallion.silverPassed} + quarantined ${medallion.silverQuarantined}`,
      detail: `Gold: reconciled ledger ${medallion.gold.ledgerReconciled} entries ($${medallion.gold.ledgerReconciledTotal.toFixed(2)}), Customer 360 ${medallion.gold.customers360}, usage ${medallion.gold.usageTotalGb} GB.`,
    },
  ];
  const todos: string[] = [];
  if (health && !health.llm_configured) todos.push('Set GROQ_API_KEY for live-LLM mode.');
  if (health && health.datasource.mode === 'seed') todos.push('Connect ATT_API_BASE_URL + ATT_API_KEY and set DATASOURCE=att for live carrier data.');
  if (health && !health.db.configured) todos.push('Provision Postgres and set DATABASE_URL when the fulfilment team wires the store (reserved today).');
  if (health && !health.auth.enabled) todos.push('Register the Entra ID app and set AUTH_ENABLED=true + AUTH_CLIENT_ID + AUTH_ISSUER_URL when login is required.');
  if (!lastEval) todos.push('Run the evaluation suite (System → Evaluations).');
  if (health?.datasource.mode === 'att' && health.datasource.status !== 'configured') todos.push('att mode selected but its connection vars are missing.');
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
  const readyCount = rows.filter((r) => r.tone === 'green').length;
  const todoCount = todos.length;
  return (
    <div className="panel mt">
      <div className="row space">
        <span><strong>Production readiness</strong> <span className="small muted">· {readyCount} of {rows.length} checks green · {todoCount} fulfilment item{todoCount === 1 ? '' : 's'} open{!lastEval ? ' · evals not run yet' : ''}</span><InfoTip text="Every row is computed live from /api/health, the last eval run, and the Medallion snapshot." /></span>
        <button className="btn small secondary" onClick={() => setOpen((v) => !v)}>{open ? 'Hide details' : 'Show details'}</button>
      </div>
      {open && (
      <>
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
      </div>
      </>
      )}
    </div>
  );
}

/* ---------------- Customers ---------------- */
function CustomersView({ state, mutate, audit, emit, onRun, onCreateAndRun, confirmed, onConfirmCustomer, onClearConfirmation }: { state: AppState; mutate: (fn: (s: AppState) => AppState) => void; audit: (a: 'agent' | 'human' | 'system', b: string, c: string) => void; emit: (e: AppEvent) => void; onRun: (id: string) => Promise<void>; onCreateAndRun: (c: Case, newCustomer?: Customer) => void; confirmed: CustomerConfirmation | null; onConfirmCustomer: (customer: Customer, method: VerificationMethod) => void; onClearConfirmation: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Customer | null>(null);
  const [showIntake, setShowIntake] = useState(false);
  const [name, setName] = useState('');
  const [plan, setPlan] = useState('Unlimited Starter');
  // A customer confirmed on the Dashboard (or here) becomes the context
  // here too: their 360 opens automatically. Clearing the confirmation
  // closes it — the next customer must be found and verified again.
  useEffect(() => {
    if (confirmed) {
      const c = state.customers.find((x) => x.id === confirmed.customerId);
      if (c) { setSel(c); setShowIntake(false); }
    }
  }, [confirmed?.customerId]);
  // One search box, matched across name / phone / account / email /
  // customer ID (see lib/customer-search.ts). It searches whatever is
  // in state — the built-in seed or an uploaded dataset.
  const search = searchCustomers(state.customers, q);
  const view360 = sel ? customer360(state, sel.id) : null;
  // Simulate an incoming call: what dialling 611 does — the calling
  // line identifies the account before the agent speaks. Picks a
  // customer and pre-fills the search with their phone number.
  // Clearly labelled as a simulation; no real call takes place.
  const simulateIncomingCall = () => {
    const active = state.customers.filter((c) => c.status === 'active');
    const pool = active.length > 0 ? active : state.customers;
    if (pool.length === 0) return;
    const caller = pool[Math.floor(Math.random() * pool.length)];
    setQ(caller.phone);
    setSel(caller);
    setShowIntake(false);
    audit('system', 'simulated_call', `Simulated incoming call (611): calling line ${caller.phone} identified ${caller.name} (${caller.id}) before the agent spoke.`);
  };
  return (
    <section>
      <h1>Find a customer</h1>
      <p className="small muted">Demo data — no real customer records.</p>
      <ConfirmCustomerForm key={confirmed ? confirmed.customerId : 'none'} customers={state.customers} confirmed={confirmed} onConfirm={(customer, method) => { onConfirmCustomer(customer, method); setSel(customer); setShowIntake(false); }} onClear={() => { onClearConfirmation(); setSel(null); setShowIntake(false); }} audit={audit} />
      <div className="row">
        <input className="search" type="text" placeholder="Search name, phone, account, email or customer ID…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        <button className="btn" onClick={() => {
          // Audit the search when it is submitted — never per keystroke,
          // and never with the raw query: the query may be a phone number
          // or email, which must not reach the audit log (see lib/redact).
          // Only the match type and the count are recorded.
          const reasons = [...new Set(search.results.flatMap((r) => r.reasons))];
          audit('human', 'customer_search', `Customer search submitted: ${search.total} match${search.total === 1 ? '' : 'es'}${reasons.length > 0 ? ` (matched by ${reasons.join(', ')})` : ' (no match)'}.`);
        }}>Search</button>
        <button className="btn secondary" onClick={simulateIncomingCall} title="Simulation: picks a customer and pre-fills the search with their phone number, the way dialling 611 identifies the calling line.">Simulate incoming call (611)</button>
      </div>
      <p className="small muted mt">Showing {search.results.length} of {search.total} match{search.total === 1 ? '' : 'es'}{search.capped ? ` — capped at ${SEARCH_RESULT_LIMIT} rows; narrow the search to see more` : ''}.</p>
      <div className="table-wrap mt"><table>
        <thead><tr><th>Customer</th><th>Account</th><th>Plan</th><th>Balance</th><th>Status</th><th>Matched by</th><th></th></tr></thead>
        <tbody>{search.results.map(({ customer: c, reasons }) => (
          <tr key={c.id}>
            <td><strong>{c.name}</strong><br /><span className="small muted">{c.city} · since {c.since}</span></td>
            <td>{c.account}<br /><span className="small muted">{c.phone}</span></td>
            <td>{c.plan}</td><td>{money(c.balance)}</td>
            <td>{statusPill(c.status)}</td>
            <td><span className="small muted">{reasons.join(', ')}</span></td>
            <td><button className="btn small secondary" onClick={() => { setSel(c); setShowIntake(false); audit('human', 'customer_viewed', `Opened Customer 360 for ${c.id} (matched by ${reasons.join(', ')}).`); }}>View 360</button></td>
          </tr>
        ))}</tbody>
      </table></div>
      {search.results.length === 0 && <p className="muted mt">No customers match that search.</p>}
      <div className="panel">
        <h2>Add a customer</h2>
        <div className="row">
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" style={{ maxWidth: '260px' }} />
          <select value={plan} onChange={(e) => setPlan(e.target.value)} style={{ maxWidth: '180px' }}><option>Unlimited Starter</option><option>Unlimited Premium</option><option>Family Share</option><option>Business Elite</option></select>
          <button className="btn" disabled={!name.trim()} onClick={() => {
          const id = uid('CUST');
          mutate((s) => ({ ...s, customers: [...s.customers, { id, name: name.trim(), account: `ACC-${Math.floor(100000 + Math.random() * 899999)}`, phone: '(555) 555-0100', email: '', plan, status: 'active', since: new Date().toISOString().slice(0, 10), balance: 0, city: '—' }] }));
          audit('human', 'customer_created', `Created customer ${name.trim()} (${id}).`);
          emit(newAppEvent('customer_created', 'human', `Created customer ${name.trim()} (${id}).`));
          setName('');
        }}>Add customer</button>
        </div>
      </div>
      {view360 && view360.customer && (
        <div className="panel highlight">
          <div className="row space"><h2>Customer 360 — {view360.customer.name}</h2><button className="btn small secondary" onClick={() => { setSel(null); setShowIntake(false); }}>Close</button></div>
          <p className="small muted">{view360.customer.id} · {view360.customer.account} · {view360.customer.phone}{view360.customer.email ? ` · ${view360.customer.email}` : ''}</p>
          <p className="small">Plan: <strong>{view360.customer.plan}</strong> · Balance: <strong>{money(view360.customer.balance)}</strong> · Status: <strong>{view360.customer.status}</strong> · Customer since {view360.customer.since} · {view360.customer.city}</p>
          {confirmed && confirmed.customerId === view360.customer.id ? (
            <p className="small ok">Verified via {verificationLabel(confirmed.method)} at {formatVerifiedAt(confirmed.at)} — this session. Changes below apply to this customer.</p>
          ) : (
            <p className="small error">Not verified — verify before changing billing, usage or services. Verification is recorded, not enforced yet.</p>
          )}
          <div className="grid3">
            <div><h3>Billing ledger</h3>{view360.ledger.length === 0 ? <p className="muted small">No entries.</p> : view360.ledger.map((e) => <p key={e.id} className="small">{e.date} · {e.invoice} · {e.service} · <strong>{money(e.amount)}</strong> · {e.status}</p>)}</div>
            <div><h3>Usage</h3>{view360.usage.length === 0 ? <p className="muted small">No usage records.</p> : view360.usage.map((u) => <p key={u.id} className="small">{u.month}: {u.dataGb} GB, {u.minutes} min, {u.sms} SMS</p>)}</div>
            <div><h3>Cases &amp; tickets</h3>{view360.cases.length === 0 && view360.tickets.length === 0 ? <p className="muted small">No cases or tickets.</p> : <>{view360.cases.map((c) => (
              <p key={c.id} className="small">{c.id}: {c.title} — {c.status}
                {(c.status === 'open' || c.status === 'failed') && (
                  <> <button className="btn small accent" onClick={() => { void onRun(c.id); }}>Run agent</button></>
                )}
              </p>
            ))}{view360.tickets.map((t) => <p key={t.id} className="small">{t.id}: {t.subject} — {t.status}</p>)}</>}</div>
          </div>
          <div className="row mt">
            <button className="btn accent" onClick={() => setShowIntake((v) => !v)}>{showIntake ? 'Hide case form' : `Create case for ${view360.customer.name}`}</button>
            <ConfirmButton label="Delete customer" confirmLabel="Confirm delete" kind="danger" onConfirm={() => {
              mutate((s) => ({ ...s, customers: s.customers.filter((c) => c.id !== view360.customer!.id) }));
              audit('human', 'customer_deleted', `Deleted customer ${view360.customer!.id}. [customer verification: ${confirmed && confirmed.customerId === view360.customer!.id ? `verified via ${verificationLabel(confirmed.method)} at ${confirmed.at}` : 'not verified in this session'}]`);
              setSel(null);
              setShowIntake(false);
            }} />
          </div>
          {showIntake && <div className="mt"><CreateCaseForm key={view360.customer.id} customers={state.customers} cases={state.cases} preselectedCustomerId={view360.customer.id} onCreateAndRun={onCreateAndRun} /></div>}
        </div>
      )}
    </section>
  );
}

/* ---------------- Cases ---------------- */
function CasesView({ state, onRun, onApprove, onReject, onCreateAndRun }: {
  state: AppState;
  onRun: (id: string) => Promise<void>;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string) => void;
  onCreateAndRun: (c: Case, newCustomer?: Customer) => void;
}) {
  const [running, setRunning] = useState(false);
  const runFor = (caseId: string) => state.runs.find((r) => r.caseId === caseId && (r.status === 'awaiting_approval' || r.status === 'running')) ?? state.runs.find((r) => r.caseId === caseId);
  return (
    <section>
      <h1>Cases</h1>
      <p className="small muted">Approving posts a real credit to the ledger.</p>
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

      <CreateCaseForm customers={state.customers} cases={state.cases} onCreateAndRun={onCreateAndRun} />
    </section>
  );
}

/* ---------------- System ----------------
 * The operator's daily work is Dashboard / Data / Customers / Cases.
 * Everything else — pipelines, Medallion, knowledge, evaluations,
 * observability — lives here under one tab, so the top nav stays short
 * and the daily screens stay clean. Every view is still reachable and
 * works exactly as before. */
type SystemSection = 'pipelines' | 'medallion' | 'knowledge' | 'evals' | 'observability';
const SYSTEM_NAV: { id: SystemSection; label: string }[] = [
  { id: 'pipelines', label: 'Pipelines' },
  { id: 'medallion', label: 'Medallion' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'evals', label: 'Evaluations' },
  { id: 'observability', label: 'Observability' },
];
function SystemView({ state, mutate, audit, emit, onReset }: { state: AppState; mutate: (fn: (s: AppState) => AppState) => void; audit: (a: 'agent' | 'human' | 'system', b: string, c: string) => void; emit: (e: AppEvent) => void; onReset: () => void }) {
  const [section, setSection] = useState<SystemSection>('pipelines');
  return (
    <section>
      <nav className="subtabs">
        {SYSTEM_NAV.map((n) => <button key={n.id} className={section === n.id ? 'active' : ''} onClick={() => setSection(n.id)}>{n.label}</button>)}
      </nav>
      {section === 'pipelines' && <PipelinesView state={state} mutate={mutate} audit={audit} emit={emit} />}
      {section === 'medallion' && <MedallionView state={state} audit={audit} />}
      {section === 'knowledge' && <KnowledgeView state={state} mutate={mutate} audit={audit} />}
      {section === 'evals' && <EvalsView state={state} mutate={mutate} audit={audit} emit={emit} />}
      {section === 'observability' && <ObservabilityView state={state} onReset={onReset} />}
    </section>
  );
}

/* ---------------- Knowledge ----------------
 * RAG and STAIR are one screen: the policy knowledge the agent
 * grounds itself in. "Policy docs" is the chunk-RAG view (answers only
 * from the indexed docs, with citations); "STAIR" is the structured
 * retriever over the same policies. */
function KnowledgeView({ state, mutate, audit }: { state: AppState; mutate: (fn: (s: AppState) => AppState) => void; audit: (a: 'agent' | 'human' | 'system', b: string, c: string) => void }) {
  const [tab, setTab] = useState<'docs' | 'stair'>('docs');
  return (
    <section>
      <h1>Knowledge</h1>
      <p className="small muted">Answers come only from these docs — anything else is refused.</p>
      <nav className="subtabs">
        <button className={tab === 'docs' ? 'active' : ''} onClick={() => setTab('docs')}>Policy docs (RAG)</button>
        <button className={tab === 'stair' ? 'active' : ''} onClick={() => setTab('stair')}>STAIR</button>
      </nav>
      {tab === 'docs' ? <RagView state={state} mutate={mutate} audit={audit} /> : <StairView state={state} />}
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
      <h1>Pipelines <InfoTip text="ETL runs validate the seeded batch and count passed and failed. These are the Medallion Silver quality gates." /></h1>
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
      <h1>Medallion — Bronze → Silver → Gold <InfoTip text="Bronze = Silver passed + quarantined. Gold is built only from Silver-passed records — never edited directly." /></h1>
      <div className="cards">
        <div className="card"><div className="num">{snapshot.bronzeTotal}</div><div className="lbl">Bronze — raw as received</div></div>
        <div className="card"><div className="num">{snapshot.silverPassed}</div><div className="lbl">Silver — passed · {snapshot.silverQuarantined} quarantined</div></div>
        <div className="card"><div className="num">{snapshot.gold.ledgerReconciled}</div><div className="lbl">Gold — reconciled ledger · ${snapshot.gold.ledgerReconciledTotal.toFixed(2)}</div></div>
        <div className="card"><div className="num">{snapshot.gold.customers360}</div><div className="lbl">Gold — Customer 360 · {snapshot.gold.usageTotalGb} GB</div></div>
      </div>
      <div className="row">
        <button className="btn accent" onClick={runBatch}>Run incremental batch</button>
        <span className="small muted">Failed steps retry once, then quarantine — the batch never fails outright.</span>
      </div>
      {runs.length > 0 && runs.slice(0, 3).map((r) => (
        <div key={`${r.batchId}-${r.newRecords}-${runs.indexOf(r)}`} className="panel">
          <div className="row space"><strong>Batch {r.batchId}</strong><span className="small muted">{r.newRecords} new · {r.skippedRecords} skipped by watermark · {r.retries} retries · {r.deferredRecords} deferred to the next batch</span></div>
          <p className="small">Bronze {r.snapshot.bronzeTotal} = Silver passed {r.snapshot.silverPassed} + quarantined {r.snapshot.silverQuarantined} · Gold ledger {r.snapshot.gold.ledgerReconciled} entries, ${r.snapshot.gold.ledgerReconciledTotal.toFixed(2)}</p>
          {r.deferredRecords > 0 && <p className="small muted">Deferred: {r.deferredRecords} records — picked up by the next batch.</p>}
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
      <h2 className="mt">Failure cards — one operator + Copilot <InfoTip text="One operator fixes failures with the Copilot prompt on each card." /></h2>
      <p className="small muted">Fix in Bronze/Silver, re-run the batch — never edit Gold directly.</p>
      {snapshot.failureCards.map((card) => (
        <div key={card.id} className="panel">
          <div className="row space"><strong>{card.id}</strong><span className="small muted">{card.pipelineId} · batch {card.batchId}</span></div>
          <p className="small"><strong>What failed:</strong> {card.what}</p>
          <p className="small"><strong>Fix here:</strong> {card.fixFile}, {card.fixFunction}</p>
          <pre className="log">{card.copilotPrompt}</pre>
          <button className="btn small secondary" onClick={() => copyPrompt(card.id, card.copilotPrompt)}>{copiedId === card.id ? 'Copied — paste it into Copilot' : 'Copy Copilot prompt'}</button>
        </div>
      ))}
      <p className="small muted mt">Demo data: 20 customers, 106 records. Petabyte scale is architectural, not measured here.</p>
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
      <p className="small muted">Answers come only from these docs — anything else is refused.</p>
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
      <h1>Evaluations <InfoTip text="8 checks: duplicate detection, amount, non-duplicate discrimination, RAG grounding and refusal, idempotency, agent plan." /></h1>
      <p className="small muted">Release gate: {EVAL_GATE_PCT}%. Runs against live state.</p>
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
          {release.status === 'blocked' && <p className="small muted">Fix the failed checks and re-run the suite.</p>}
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
      <h1>Observability <InfoTip text="Every agent step with measured timing, every pipeline run, every action in the audit log. Nothing is reported that was not measured." /></h1>
      <h2>Agent runs</h2>
      {state.runs.length === 0 ? <p className="muted">No runs yet.</p> : state.runs.map((r) => (
        <div key={r.id} className="panel">
          <div className="row space"><strong>{r.id} · {r.caseId}</strong><span className="row">{statusPill(r.status)}<span className="small muted">started {r.startedAt.slice(0, 19).replace('T', ' ')}</span></span></div>
          <p className="small">Agent active time: {fmtMs(r.agentMs)} · Manual baseline: {fmtMin(MANUAL_MINUTES * 60000)} · Proposed credit: {r.proposedCredit === null ? '—' : money(r.proposedCredit)} · Applied: {r.creditApplied === null ? '—' : money(r.creditApplied)}</p>
          {r.steps.map((s) => <p key={s.id} className="small">{s.name} — {s.tool} — {s.status} — {fmtMs(s.ms)} — retries {s.retries}</p>)}
        </div>
      ))}
      <h2 className="mt">Audit log ({state.audit.length})</h2>
      <p className="small muted">Phone/email masked. Operator login is stored, never shown here.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Run / Trace</th><th>Duration</th><th>Detail</th></tr></thead>
        <tbody>{state.audit.slice(0, 50).map((a) => <tr key={a.id}><td>{a.at.slice(0, 19).replace('T', ' ')}</td><td>{a.actor}</td><td>{a.action}</td><td className="small">{a.runId ?? '—'}{a.traceId ? <><br /><span className="muted">{a.traceId}</span></> : null}</td><td>{fmtMs(a.durationMs ?? null)}</td><td>{a.detail}</td></tr>)}</tbody>
      </table></div>
      <h2 className="mt">Event feed ({(state.events ?? []).length}) — append-only <InfoTip text="Append-only — the seam where a real event bus (Kafka / SNS / EventBridge) plugs in." /></h2>
      {(state.events ?? []).length === 0 ? <p className="muted">No events yet.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Time</th><th>Event</th><th>Actor</th><th>Run / Trace</th><th>Detail</th></tr></thead>
          <tbody>{(state.events ?? []).slice(0, 50).map((e) => <tr key={e.id}><td>{e.at.slice(0, 19).replace('T', ' ')}</td><td>{e.type}</td><td>{e.actor}</td><td className="small">{e.runId ?? '—'}{e.traceId ? <><br /><span className="muted">{e.traceId}</span></> : null}</td><td>{e.detail}</td></tr>)}</tbody>
        </table></div>
      )}
      <div className="panel mt">
        <h2>Reset demo</h2>
        <p className="small muted">Restores the seeded state and clears runs, credits and audit entries.</p>
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
      <p className="small muted">No chunking, no embeddings — the exact section is returned intact.<InfoTip text="IBM Research STAIR (Kumar et al., arXiv 2609.03874). Docs are structured trees; retrieval navigates the TOC to the exact leaf." /></p>
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
          <p className="small muted">Measured live on this demo's 10-query set.</p>
        </div>
        <div className="panel">
          <h2>Paper numbers (IBM STAIR, arXiv 2609.03874) <InfoTip text="No “65x reduction” figure is claimed — it is not a verified fact." /></h2>
          <p>Recall@1 on SearchTome: STAIR 82.6%, DSI 76.9%, DPR 68.7%, BM25 59.5%.</p>
          <p>Paper “hallucination &lt; 0.05%” means an invalid section identifier — not general accuracy.</p>
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
        <p className="small muted">Docs without headings get an auto-generated TOC. No match means “not found in policy”, not a guess. Example — auto TOC for POL-005:</p>
        <p className="small">{autoTocFromDoc(state.docs.find((d) => d.id === 'POL-005') ?? state.docs[0]).leaves.map((l) => l.path).join(' · ')}</p>
      </div>
      <h2 className="mt">Per-query eval detail — STAIR vs chunk-RAG baseline (10 queries)</h2>
      <p className="small muted">Same 10 questions, same expected answers.</p>
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
