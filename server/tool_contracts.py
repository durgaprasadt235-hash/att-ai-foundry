"""Per-tool contracts for the agent's tools — mirrors
src/lib/tool-contracts.ts (same tools, same timeouts, same retries).

Every tool the agent can call is listed here with its input schema
(required fields), timeout, retry policy (retry ONCE on a transient
failure, never on a validation error), rate-limit note, and whether it
mutates state. Planning tools never mutate; only `execute_approved`
mutates, and it is idempotent (keyed by the case idempotency key).
"""
from __future__ import annotations

RATE_LIMIT_NOTE = ("60 requests/min per caller (demo-grade in-memory guard; "
                   "production at the edge).")
NO_MUTATION = "Read-only / planning — changes no state."
RETRY_ONCE = 1

TOOL_CONTRACTS: dict[str, dict] = {
    "validate_case": {
        "tool": "validate_case",
        "description": "Validate the case and its idempotency key; stop if the customer or case is missing.",
        "requiredInputs": {"caseId": "string", "idempotencyKey": "string"},
        "timeoutMs": 5000, "retries": 0, "rateLimit": RATE_LIMIT_NOTE,
        "mutating": False,
        "idempotency": "A duplicate key returns the original run; no second run is created.",
    },
    "get_customer_360": {
        "tool": "get_customer_360",
        "description": "Read-only Customer 360: customer + ledger + usage + tickets + cases.",
        "requiredInputs": {"customerId": "string"},
        "timeoutMs": 5000, "retries": RETRY_ONCE, "rateLimit": RATE_LIMIT_NOTE,
        "mutating": False, "idempotency": NO_MUTATION,
    },
    "stair_retrieve": {
        "tool": "stair_retrieve",
        "description": "STAIR retrieval over the policy trees. Returns an intact leaf or \"not found in policy\".",
        "requiredInputs": {"query": "string"},
        "timeoutMs": 5000, "retries": RETRY_ONCE, "rateLimit": RATE_LIMIT_NOTE,
        "mutating": False,
        "idempotency": "Deterministic: same query + trees, same leaf. Only a TOC leaf title may be returned.",
    },
    "search_knowledge": {
        "tool": "search_knowledge",
        "description": "Chunk-RAG baseline over policy docs. Grounded answer with citations, or refusal.",
        "requiredInputs": {"query": "string"},
        "timeoutMs": 5000, "retries": RETRY_ONCE, "rateLimit": RATE_LIMIT_NOTE,
        "mutating": False, "idempotency": NO_MUTATION,
    },
    "validate_duplicate": {
        "tool": "validate_duplicate",
        "description": "Duplicate = same customer/service/amount, different invoices, ≤ 7 days apart.",
        "requiredInputs": {"customerId": "string"},
        "timeoutMs": 5000, "retries": RETRY_ONCE, "rateLimit": RATE_LIMIT_NOTE,
        "mutating": False, "idempotency": NO_MUTATION,
    },
    "check_eligibility": {
        "tool": "check_eligibility",
        "description": "Provisioning eligibility: account active and balance ≤ $100.",
        "requiredInputs": {"customerId": "string"},
        "timeoutMs": 5000, "retries": RETRY_ONCE, "rateLimit": RATE_LIMIT_NOTE,
        "mutating": False, "idempotency": NO_MUTATION,
    },
    "check_network_status": {
        "tool": "check_network_status",
        "description": "Outage confirmation: a network-confirmed outage over 4 hours is required for a credit.",
        "requiredInputs": {"caseId": "string"},
        "timeoutMs": 5000, "retries": RETRY_ONCE, "rateLimit": RATE_LIMIT_NOTE,
        "mutating": False, "idempotency": NO_MUTATION,
    },
    "compare_plans": {
        "tool": "compare_plans",
        "description": "Plan price comparison from the price table (target − current); never a hardcoded amount.",
        "requiredInputs": {"customerId": "string", "targetPlan": "string"},
        "timeoutMs": 5000, "retries": RETRY_ONCE, "rateLimit": RATE_LIMIT_NOTE,
        "mutating": False, "idempotency": NO_MUTATION,
    },
    "assess_churn_risk": {
        "tool": "assess_churn_risk",
        "description": "Churn-risk signals: 2 required for a save offer (suspended account, outstanding balance).",
        "requiredInputs": {"customerId": "string"},
        "timeoutMs": 5000, "retries": RETRY_ONCE, "rateLimit": RATE_LIMIT_NOTE,
        "mutating": False, "idempotency": NO_MUTATION,
    },
    "propose_credit": {
        "tool": "propose_credit",
        "description": "Propose a credit (amount, reason, citation). Proposal only — execution needs human approval.",
        "requiredInputs": {"amount": "number", "reason": "string", "citation": "string"},
        "timeoutMs": 5000, "retries": 0, "rateLimit": RATE_LIMIT_NOTE,
        "mutating": False,
        "idempotency": "Proposals carry the case idempotency key; a re-plan returns the same proposal.",
    },
    "groq_chat": {
        "tool": "groq_chat",
        "description": "Live Groq (openai/gpt-oss-120b): picks a STAIR leaf from the TOC allowlist, drafts a summary. Never decides amounts or eligibility.",
        "requiredInputs": {"query": "string", "allowlist": "string[] (leaf ids)"},
        "timeoutMs": 20000, "retries": RETRY_ONCE, "rateLimit": RATE_LIMIT_NOTE,
        "mutating": False,
        "idempotency": "No state. Any failure (429, timeout, invalid pick) falls back to deterministic STAIR; the circuit breaker opens after 3 consecutive failures (see groq_client.py).",
    },
    "execute_approved": {
        "tool": "execute_approved",
        "description": "Execute the approved action: post the credit / activate the line / change the plan / schedule the visit.",
        "requiredInputs": {"runId": "string", "approval": "'approved'", "idempotencyKey": "string"},
        "timeoutMs": 5000, "retries": 0, "rateLimit": RATE_LIMIT_NOTE,
        "mutating": True,
        "idempotency": "ENFORCED: a credit entry already posted for the case (LED-CR-<case>) or a seen idempotency key returns the original outcome — a credit is never posted twice.",
    },
    "notify_customer": {
        "tool": "notify_customer",
        "description": "Notify the customer of the outcome. Runs only after a verified state change.",
        "requiredInputs": {"customerId": "string", "message": "string"},
        "timeoutMs": 5000, "retries": RETRY_ONCE, "rateLimit": RATE_LIMIT_NOTE,
        "mutating": True,
        "idempotency": "One notification per executed run (keyed by run id); a replayed run does not re-notify.",
    },
    "verify_outcome": {
        "tool": "verify_outcome",
        "description": "Verify the state change against the record before closing the case.",
        "requiredInputs": {"runId": "string"},
        "timeoutMs": 5000, "retries": RETRY_ONCE, "rateLimit": RATE_LIMIT_NOTE,
        "mutating": False, "idempotency": NO_MUTATION,
    },
}


def missing_tool_inputs(tool: str, inputs: dict) -> list[str]:
    """Missing required inputs for a tool call. Empty = the call is valid.
    A non-empty result is a validation error: never retried, never faked."""
    contract = TOOL_CONTRACTS.get(tool)
    if contract is None:
        return [f"Unknown tool {tool}"]
    return [f for f in contract["requiredInputs"]
            if inputs.get(f) in (None, "")]


def is_mutating_tool(tool: str) -> bool:
    return bool(TOOL_CONTRACTS.get(tool, {}).get("mutating", False))


def contract_for_step(step_tool: str) -> dict | None:
    return TOOL_CONTRACTS.get(step_tool)
