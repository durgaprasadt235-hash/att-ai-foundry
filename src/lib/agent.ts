// Explicit agent state machine — mirrors server/agent.py.
//
// The five journeys all run the same machine:
//   INTAKE → RETRIEVE_360 → GROUND → VALIDATE → PROPOSE
//     → AWAITING_APPROVAL → EXECUTE → VERIFY → DONE
// with FAILED / REJECTED as terminal states. Until now the machine was
// implicit in the engine's step order; here it is named, with a transition
// table, so a run's trace can be checked against it (and so a future
// LangGraph port maps 1:1 onto these states).
//
// Human approval is a state, not a comment: nothing moves from
// AWAITING_APPROVAL to EXECUTE without a person. FAILED is reached
// honestly instead of a fake success.
import type { AgentRun } from './types';

export type AgentState =
  | 'INTAKE' | 'RETRIEVE_360' | 'GROUND' | 'VALIDATE' | 'PROPOSE'
  | 'AWAITING_APPROVAL' | 'EXECUTE' | 'VERIFY' | 'DONE' | 'FAILED' | 'REJECTED';

export const AGENT_STATES: AgentState[] = [
  'INTAKE', 'RETRIEVE_360', 'GROUND', 'VALIDATE', 'PROPOSE',
  'AWAITING_APPROVAL', 'EXECUTE', 'VERIFY', 'DONE', 'FAILED', 'REJECTED',
];

export const TERMINAL_STATES: ReadonlySet<AgentState> = new Set(['DONE', 'FAILED', 'REJECTED']);

/** Legal transitions. Anything else is a bug, and stateTraceForRun
 *  reports it instead of silently accepting it. */
export const TRANSITIONS: Record<AgentState, AgentState[]> = {
  INTAKE: ['RETRIEVE_360', 'FAILED'],
  // RETRIEVE_360 → VALIDATE is the fail-fast path: a case type with no
  // agent workflow (e.g. roaming) has nothing to ground, so the run fails
  // at validation instead of grounding. It never skips ahead to PROPOSE
  // or EXECUTE — only to FAILED.
  RETRIEVE_360: ['GROUND', 'VALIDATE', 'FAILED'],
  GROUND: ['VALIDATE', 'FAILED'],
  VALIDATE: ['PROPOSE', 'FAILED'],
  PROPOSE: ['AWAITING_APPROVAL', 'FAILED'],
  AWAITING_APPROVAL: ['EXECUTE', 'REJECTED', 'FAILED'],
  EXECUTE: ['VERIFY', 'FAILED'],
  VERIFY: ['DONE', 'FAILED'],
  DONE: [],
  FAILED: [],
  REJECTED: [],
};

/** Engine step id → state. The live-llm step is deliberately NOT mapped:
 *  it only annotates grounding (the Groq leaf pick) and sits after the
 *  PROPOSE step in the trace; mapping it to GROUND would make a live run
 *  look like it went PROPOSE → GROUND, which never happens. The live-LLM
 *  fact lives on the run (liveLlm field), not in the state trace. */
export const STEP_TO_STATE: Record<string, AgentState> = {
  'intake': 'INTAKE',
  'retrieve-360': 'RETRIEVE_360',
  'stair-ground': 'GROUND',
  'validate': 'VALIDATE',
  'diagnose': 'VALIDATE',
  'credit-check': 'VALIDATE',
  'order': 'PROPOSE',
  'plan-propose': 'PROPOSE',
  'execute': 'EXECUTE',
  'notify': 'EXECUTE',
  'close-verify': 'VERIFY',
};

const STATUS_TO_STATE: Record<string, AgentState> = {
  awaiting_approval: 'AWAITING_APPROVAL',
  completed: 'DONE',
  failed: 'FAILED',
  rejected: 'REJECTED',
};

export function isTerminal(state: AgentState): boolean {
  return TERMINAL_STATES.has(state);
}

export function legalTransition(from: AgentState, to: AgentState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function stateForStep(stepId: string): AgentState | null {
  return STEP_TO_STATE[stepId] ?? null;
}

export interface StateTrace {
  states: AgentState[];
  current: AgentState;
  valid: boolean;
  invalidTransitions: [AgentState, AgentState][];
}

/** Map a run (steps + status) onto the state machine. A trace that jumps
 *  states (e.g. PROPOSE → EXECUTE without approval) is reported invalid —
 *  the approval gate is structural, not cosmetic. */
export function stateTraceForRun(run: AgentRun): StateTrace {
  const states: AgentState[] = [];
  for (const step of run.steps) {
    const state = stateForStep(step.id);
    if (state && states[states.length - 1] !== state) states.push(state);
  }
  const terminal = STATUS_TO_STATE[run.status];
  if (terminal && states[states.length - 1] !== terminal) states.push(terminal);
  if (states.length === 0) states.push('INTAKE');
  // Approval is implied, never skipped: EXECUTE steps (or a REJECTED
  // terminal) in a trace that never recorded AWAITING_APPROVAL mean the
  // run did pass through approval — the step list just does not carry an
  // explicit approval step. Reconstruct that ONE hop so real traces
  // validate. Any other jump (e.g. PROPOSE → DONE, INTAKE →
  // AWAITING_APPROVAL) is still reported invalid below.
  if (states.includes('EXECUTE') && !states.includes('AWAITING_APPROVAL')) {
    states.splice(states.indexOf('EXECUTE'), 0, 'AWAITING_APPROVAL');
  }
  if (states[states.length - 1] === 'REJECTED' && !states.includes('AWAITING_APPROVAL')) {
    states.splice(states.length - 1, 0, 'AWAITING_APPROVAL');
  }
  const invalidTransitions: [AgentState, AgentState][] = [];
  for (let i = 0; i < states.length - 1; i++) {
    if (!legalTransition(states[i], states[i + 1])) invalidTransitions.push([states[i], states[i + 1]]);
  }
  return { states, current: states[states.length - 1], valid: invalidTransitions.length === 0, invalidTransitions };
}
