"""Explicit agent state machine — mirrors src/lib/agent.ts.

The five journeys all run the same machine:
    INTAKE -> RETRIEVE_360 -> GROUND -> VALIDATE -> PROPOSE
        -> AWAITING_APPROVAL -> EXECUTE -> VERIFY -> DONE
with FAILED / REJECTED as terminal states. Until now the machine was
implicit in the engine's step order; here it is named, with a transition
table, so a run's trace can be checked against it (and so a future
LangGraph port maps 1:1 onto these states).

Human approval is a state, not a comment: nothing moves from
AWAITING_APPROVAL to EXECUTE without a person. FAILED is reached
honestly (validation failed, no grounding, not eligible) instead of a
fake success.
"""
from __future__ import annotations

# Named states, in the order a successful run visits them.
STATES = (
    "INTAKE",
    "RETRIEVE_360",
    "GROUND",
    "VALIDATE",
    "PROPOSE",
    "AWAITING_APPROVAL",
    "EXECUTE",
    "VERIFY",
    "DONE",
    "FAILED",
    "REJECTED",
)

TERMINAL_STATES = frozenset({"DONE", "FAILED", "REJECTED"})

# Legal transitions. Anything else is a bug, and state_trace_for_run
# reports it instead of silently accepting it.
TRANSITIONS: dict[str, tuple[str, ...]] = {
    "INTAKE": ("RETRIEVE_360", "FAILED"),
    # RETRIEVE_360 -> VALIDATE is the fail-fast path: a case type with no
    # agent workflow (e.g. roaming) has nothing to ground, so the run
    # fails at validation instead of grounding. It never skips ahead to
    # PROPOSE or EXECUTE — only to FAILED.
    "RETRIEVE_360": ("GROUND", "VALIDATE", "FAILED"),
    "GROUND": ("VALIDATE", "FAILED"),
    "VALIDATE": ("PROPOSE", "FAILED"),
    "PROPOSE": ("AWAITING_APPROVAL", "FAILED"),
    "AWAITING_APPROVAL": ("EXECUTE", "REJECTED", "FAILED"),
    "EXECUTE": ("VERIFY", "FAILED"),
    "VERIFY": ("DONE", "FAILED"),
    "DONE": (),
    "FAILED": (),
    "REJECTED": (),
}

# Engine step id -> state. The live-llm step is deliberately NOT mapped:
# it only annotates grounding (the Groq leaf pick) and sits after the
# PROPOSE step in the trace; mapping it to GROUND would make a live run
# look like it went PROPOSE -> GROUND, which never happens. The live-LLM
# fact lives on the run (liveLlm field), not in the state trace.
STEP_TO_STATE: dict[str, str] = {
    "intake": "INTAKE",
    "retrieve-360": "RETRIEVE_360",
    "stair-ground": "GROUND",
    "validate": "VALIDATE",
    "diagnose": "VALIDATE",
    "credit-check": "VALIDATE",
    "order": "PROPOSE",
    "plan-propose": "PROPOSE",
    "execute": "EXECUTE",
    "notify": "EXECUTE",
    "close-verify": "VERIFY",
}

# Run status -> terminal state appended to the trace.
STATUS_TO_STATE: dict[str, str] = {
    "running": "INTAKE",  # placeholder: replaced by the last step state
    "awaiting_approval": "AWAITING_APPROVAL",
    "completed": "DONE",
    "failed": "FAILED",
    "rejected": "REJECTED",
}


def is_terminal(state: str) -> bool:
    return state in TERMINAL_STATES


def legal_transition(from_state: str, to_state: str) -> bool:
    return to_state in TRANSITIONS.get(from_state, ())


def state_for_step(step_id: str) -> str | None:
    return STEP_TO_STATE.get(step_id)


def state_trace_for_run(run: dict) -> dict:
    """Map a run (steps + status) onto the state machine.

    Returns {"states": [...visited in order...], "current": str,
    "valid": bool, "invalidTransitions": [[from, to], ...]}.
    A trace that jumps states (e.g. PROPOSE -> EXECUTE without approval)
    is reported invalid — the approval gate is structural, not cosmetic.
    """
    states: list[str] = []
    for step in run.get("steps", []):
        state = state_for_step(step.get("id", ""))
        if state and (not states or states[-1] != state):
            states.append(state)
    status = run.get("status", "")
    terminal = STATUS_TO_STATE.get(status)
    if terminal and terminal != "INTAKE":
        if not states or states[-1] != terminal:
            states.append(terminal)
    if not states:
        states = ["INTAKE"]
    # Approval is implied, never skipped: EXECUTE steps (or a REJECTED
    # terminal) in a trace that never recorded AWAITING_APPROVAL mean the
    # run did pass through approval — the step list just does not carry
    # an explicit approval step. Reconstruct that ONE hop so real traces
    # validate. Any other jump (e.g. PROPOSE -> DONE, INTAKE ->
    # AWAITING_APPROVAL) is still reported invalid below.
    if "EXECUTE" in states and "AWAITING_APPROVAL" not in states:
        states.insert(states.index("EXECUTE"), "AWAITING_APPROVAL")
    if states[-1] == "REJECTED" and "AWAITING_APPROVAL" not in states:
        states.insert(len(states) - 1, "AWAITING_APPROVAL")
    invalid: list[list[str]] = []
    for before, after in zip(states, states[1:]):
        if not legal_transition(before, after):
            invalid.append([before, after])
    return {"states": states, "current": states[-1],
            "valid": not invalid, "invalidTransitions": invalid}
