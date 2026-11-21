"""Deterministic agent engine — Python port of src/lib/engine.ts.

Same rules, same outcomes: duplicate detection (same service + amount,
different invoices, <=7 days), grounded RAG over indexed policy docs with
refusal, idempotency by case key, and an 8-check evaluation suite with an
85% release gate. No LLM, no randomness, no network calls.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date

from stair_retriever import retrieve as stair_retrieve

STOPWORDS = set(
    "a an the is are was were what how why when where which who whom this that "
    "these those it its of for to in on at by with from as and or not no do does "
    "did can could should would i me my we you your he she they them his her "
    "their our".split()
)
EVAL_GATE_PCT = 85
MANUAL_MINUTES = 38
MANUAL_COST_USD = 28.50
AGENT_COST_USD = 0.85

# Plan price table — the single source of truth for plan prices in the engine
# (POL-004 / STAIR §7.1). Prices come from the 20-customer test data:
# Business Elite is $112.00 there, NOT the $206.30 of the old 8-customer seed.
# Never hardcode a plan price in the engine.
PLAN_PRICES = {
    "Unlimited Starter": 65.00,
    "Unlimited Premium": 87.40,
    "Family Share": 98.00,
    "Business Elite": 112.00,
}
# Policy credits (POL-006 §5.1 outage, POL-007 §8.1 retention save offer).
OUTAGE_CREDIT_USD = 25.0
RETENTION_CREDIT_USD = 25.0
# POL-002: credits above this amount require human approval.
GOODWILL_APPROVAL_THRESHOLD_USD = 25.0
# Outage credit requires a network-confirmed outage over this many hours.
OUTAGE_MIN_HOURS = 4
# Default plan-change target when the case states no other target.
DEFAULT_TARGET_PLAN = "Unlimited Premium"


def parse_target_plan(description):
    """Target plan: Unlimited Premium unless the case description states
    another target explicitly ("to <Plan>" or "comparison with <Plan>").
    The current plan always comes from the customer record, never the case."""
    desc = (description or "").lower()
    for plan in PLAN_PRICES:
        if f"to {plan.lower()}" in desc:
            return plan
    for plan in PLAN_PRICES:
        if f"with {plan.lower()}" in desc:
            return plan
    return DEFAULT_TARGET_PLAN


def is_network_outage_confirmed(case):
    """Network-status check for an outage case. Demo convention, stated
    honestly: the seeded network-status record is carried in the case
    description — a description that references a "network-confirmed" outage
    means the network-status tool returned a confirmed outage lasting over
    4 hours. A case with no such reference is NOT confirmed: the customer
    report alone never confirms an outage, and the run fails instead of
    proposing a credit."""
    return "network-confirmed" in (case.get("description") or "").lower()


def tokenize(text: str) -> list[str]:
    # Light stemming so "credits" matches "credit" and "charges" matches "charge".
    words = re.sub(r"[^a-z0-9\s]", " ", text.lower()).split()
    out = [w for w in words if len(w) > 2 and w not in STOPWORDS]
    return [w[:-1] if len(w) > 3 and w.endswith("s") else w for w in out]


def rag_search(docs: list[dict], query: str) -> list[dict]:
    q = list(dict.fromkeys(tokenize(query)))
    if not q:
        return []
    hits = []
    for doc in docs:
        hay = tokenize(f"{doc['title']} {doc['body']}")
        matched = [t for t in q if t in hay]
        score = len(matched) / len(q)
        if score >= 0.2:
            hits.append({"doc": doc, "score": round(score, 2), "matched": matched})
    return sorted(hits, key=lambda h: -h["score"])


def grounded_answer(docs: list[dict], query: str) -> dict:
    hits = rag_search(docs, query)
    if not hits:
        return {
            "answer": "Not in the indexed docs — I cannot answer this from policy.",
            "citations": [],
            "refused": True,
        }
    top = hits[:3]
    return {
        "answer": " ".join(h["doc"]["body"] for h in top),
        "citations": [
            {"docId": h["doc"]["id"], "title": h["doc"]["title"], "score": h["score"]}
            for h in top
        ],
        "refused": False,
    }


def find_duplicate(ledger: list[dict], customer_id: str) -> dict | None:
    charges = sorted(
        [e for e in ledger if e["customerId"] == customer_id and e["kind"] == "charge" and e["status"] == "posted"],
        key=lambda e: e["date"],
    )
    for i, a in enumerate(charges):
        for b in charges[i + 1:]:
            if a["service"] != b["service"] or a["amount"] != b["amount"] or a["invoice"] == b["invoice"]:
                continue
            days = (date.fromisoformat(b["date"]) - date.fromisoformat(a["date"])).days
            if 0 <= days <= 7:
                return {"original": a, "duplicate": b}
    return None


@dataclass
class PlanResult:
    steps: list[dict] = field(default_factory=list)
    proposed_credit: float | None = None
    duplicate: dict | None = None
    citation: str | None = None
    failure_reason: str | None = None
    effect_kind: str = "none"
    effect_data: dict = field(default_factory=dict)
    proposed_action: str | None = None


def _stair_ground(state: dict, query: str):
    hit = stair_retrieve(state.get("stairTrees", []), query)
    return hit["leaf"] if hit else None


def plan_run(state: dict, case: dict) -> PlanResult:
    """Planning phase. Pure: changes no state. Dispatches by case type.
    Primary grounding is STAIR (structured trees, intact leaf)."""
    result = PlanResult()

    def add(step_id, name, tool, status, detail, citation=None):
        step = {"id": step_id, "name": name, "tool": tool, "status": status,
                "ms": 0, "retries": 0, "detail": detail}
        if citation:
            step["citation"] = citation
        result.steps.append(step)

    customer = next((c for c in state["customers"] if c["id"] == case["customerId"]), None)
    if customer is None:
        add("intake", "Intake + idempotency check", "validate_case", "failed",
            f"Customer {case['customerId']} not found. Run stopped.")
        result.failure_reason = f"Customer {case['customerId']} not found."
        return result
    add("intake", "Intake + idempotency check", "validate_case", "done",
        f"Case {case['id']} validated. Idempotency key {case['idempotencyKey']}.")
    ledger = [e for e in state["ledger"] if e["customerId"] == case["customerId"]]
    add("retrieve-360", "Retrieve Customer 360", "get_customer_360", "done",
        f"{customer['name']} ({customer['account']}), {customer['plan']}, "
        f"balance ${customer['balance']:.2f}. {len(ledger)} ledger entries.")

    ctype = case["type"]
    if ctype == "duplicate_charge":
        return _plan_billing(state, case, result, add)
    if ctype == "provisioning":
        return _plan_provisioning(state, case, customer, result, add)
    if ctype == "outage":
        return _plan_outage(state, case, result, add)
    if ctype == "plan_change":
        return _plan_plan_change(state, case, customer, result, add)
    if ctype == "retention":
        return _plan_retention(state, case, customer, result, add)
    add("validate", "Validate case", "validate_case", "failed",
        f"Case type {ctype} has no agent workflow in this demo. Run stopped.")
    result.failure_reason = f"Case type {ctype} has no agent workflow in this demo."
    return result


def _plan_billing(state, case, result, add):
    leaf = _stair_ground(state, "duplicate charge credit policy")
    if leaf is None:
        add("stair-ground", "STAIR policy grounding", "stair_retrieve", "failed",
            "No section in the Table of Contents covers duplicate charges.")
        result.failure_reason = "No grounding section found for duplicate charges."
        return result
    result.citation = f"{leaf['path']} {leaf['section']}"
    add("stair-ground", "STAIR policy grounding", "stair_retrieve", "done",
        f"Grounded in {leaf['path']} {leaf['section']} — leaf retrieved intact.", citation=result.citation)
    dup = find_duplicate(state["ledger"], case["customerId"])
    if dup is None:
        add("validate", "Validate duplicate charge", "validate_duplicate", "failed",
            "No second posted charge matches the same service and amount within 7 days.")
        result.failure_reason = "No duplicate charge found in the ledger."
        return result
    result.duplicate = dup
    add("validate", "Validate duplicate charge", "validate_duplicate", "done",
        f"Duplicate confirmed: {dup['original']['invoice']} and {dup['duplicate']['invoice']}, "
        f"${dup['duplicate']['amount']:.2f} each.")
    result.proposed_credit = dup["duplicate"]["amount"]
    result.effect_kind = "credit"
    result.effect_data = {"invoice": dup["duplicate"]["invoice"], "amount": dup["duplicate"]["amount"]}
    result.proposed_action = f"Credit ${dup['duplicate']['amount']:.2f} against {dup['duplicate']['invoice']}"
    if dup["duplicate"]["amount"] > GOODWILL_APPROVAL_THRESHOLD_USD:
        threshold_note = (f"Credit is above ${GOODWILL_APPROVAL_THRESHOLD_USD:.2f}, "
                          "so human approval is required (POL-002).")
    else:
        threshold_note = (f"Credit is ${dup['duplicate']['amount']:.2f}, at or below the "
                          f"${GOODWILL_APPROVAL_THRESHOLD_USD:.2f} POL-002 threshold — "
                          "this demo still pauses for human approval.")
    add("plan-propose", "Plan + propose credit", "propose_credit", "done",
        f"Propose a credit of ${dup['duplicate']['amount']:.2f} against {dup['duplicate']['invoice']} only. {threshold_note}")
    return result


def _plan_provisioning(state, case, customer, result, add):
    leaf = _stair_ground(state, "new line activation provisioning")
    if leaf is None:
        add("stair-ground", "STAIR policy grounding", "stair_retrieve", "failed", "No section covers new line activation.")
        result.failure_reason = "No grounding section found for provisioning."
        return result
    result.citation = f"{leaf['path']} {leaf['section']}"
    add("stair-ground", "STAIR policy grounding", "stair_retrieve", "done", f"Grounded in {leaf['path']} {leaf['section']}.", citation=result.citation)
    if customer["status"] != "active":
        add("validate", "Eligibility check", "check_eligibility", "failed", f"Account is {customer['status']}, not active.")
        result.failure_reason = f"Account is {customer['status']}; new line activation requires an active account."
        return result
    if customer["balance"] > 100:
        add("validate", "Eligibility check", "check_eligibility", "failed", f"Overdue balance ${customer['balance']:.2f} is above the $100 limit.")
        result.failure_reason = "Overdue balance above $100; new line activation is not eligible."
        return result
    add("validate", "Eligibility check", "check_eligibility", "done", f"Account active, balance ${customer['balance']:.2f} (limit $100). Eligible.")
    add("order", "Create order + provision", "create_order", "done", "Order prepared for a second line with device activation.")
    result.effect_kind = "provisioning"
    result.effect_data = {"kind": "new_line"}
    result.proposed_action = "Activate a second line with device activation"
    add("plan-propose", "Plan + propose activation", "propose_activation", "done", "Propose activating the second line. Human approval required.")
    return result


def _plan_outage(state, case, result, add):
    leaf = _stair_ground(state, "network outage triage diagnose")
    if leaf is None:
        add("stair-ground", "STAIR policy grounding", "stair_retrieve", "failed", "No section covers outage triage.")
        result.failure_reason = "No grounding section found for outage triage."
        return result
    result.citation = f"{leaf['path']} {leaf['section']}"
    add("stair-ground", "STAIR policy grounding", "stair_retrieve", "done", f"Grounded in {leaf['path']} {leaf['section']}.", citation=result.citation)
    # Outage credit (POL-006 / STAIR §5.1) is $25 ONLY for a network-confirmed
    # outage over 4 hours. The case amount is whatever the customer reported
    # (here a device installment) — it is never the credit, and it is never
    # ignored silently: the trace below names both numbers.
    if not is_network_outage_confirmed(case):
        add("diagnose", "Diagnose from network status", "check_network_status", "failed",
            f"No network-status confirmation in the case record — the customer report alone does not confirm an outage. "
            f"Policy requires a network-confirmed outage over {OUTAGE_MIN_HOURS} hours (POL-006). No outage credit proposed.")
        result.failure_reason = f"Outage is not network-confirmed (over {OUTAGE_MIN_HOURS} hours). No outage credit can be proposed."
        return result
    add("diagnose", "Diagnose from network status", "check_network_status", "done",
        f"Network status check: the case record references a network-confirmed outage lasting over {OUTAGE_MIN_HOURS} hours. "
        "Diagnosis: confirmed outage, not a device fault.")
    credit_leaf = _stair_ground(state, "outage service credit")
    if credit_leaf is None:
        add("credit-check", "Outage credit check", "stair_retrieve", "failed",
            "No section covers outage service credits. The credit cannot be grounded, so no credit is proposed.")
        result.failure_reason = "No grounding section found for outage service credit."
        return result
    result.citation = f"{result.citation} + {credit_leaf['path']} {credit_leaf['section']}"
    entry = next((e for e in state["ledger"] if e["customerId"] == case["customerId"] and e["amount"] == case["amount"]), None)
    ledger_note = f" Ledger: {entry['invoice']}, {entry['service']}, ${entry['amount']:.2f}." if entry else ""
    add("credit-check", "Outage credit check", "stair_retrieve", "done",
        f"Case amount ${case['amount']:.2f} is the reported device installment, not the credit. "
        f"Policy credit is ${OUTAGE_CREDIT_USD:.2f} per Outage Service Credit Policy §5.1, network-confirmed >{OUTAGE_MIN_HOURS}h. "
        f"({credit_leaf['path']} {credit_leaf['section']}){ledger_note}", citation=result.citation)
    result.proposed_credit = OUTAGE_CREDIT_USD
    result.effect_kind = "outage_credit"
    result.effect_data = {"amount": OUTAGE_CREDIT_USD, "caseAmount": case["amount"]}
    result.proposed_action = f"Schedule a technician visit and apply a ${OUTAGE_CREDIT_USD:.2f} outage service credit"
    add("plan-propose", "Plan + propose resolution", "propose_outage_resolution", "done",
        f"Propose: notify the customer, schedule a technician visit, and apply a ${OUTAGE_CREDIT_USD:.2f} outage service credit "
        f"— not the ${case['amount']:.2f} case amount, which is the reported device installment. Human approval required.")
    return result


def _plan_plan_change(state, case, customer, result, add):
    leaf = _stair_ground(state, "plan upgrade price premium starter")
    if leaf is None:
        add("stair-ground", "STAIR policy grounding", "stair_retrieve", "failed", "No section covers upgrade pricing.")
        result.failure_reason = "No grounding section found for plan upgrade pricing."
        return result
    result.citation = f"{leaf['path']} {leaf['section']}"
    add("stair-ground", "STAIR policy grounding", "stair_retrieve", "done", f"Grounded in {leaf['path']} {leaf['section']}.", citation=result.citation)
    # Plan-aware pricing: the current plan comes from the customer record and
    # the target from the case description (default Unlimited Premium). The
    # difference is computed from the price table — never a hardcoded $22.40.
    target_plan = parse_target_plan(case.get("description"))
    current_price = PLAN_PRICES.get(customer["plan"])
    target_price = PLAN_PRICES[target_plan]
    if current_price is None:
        add("validate", "Eligibility + price comparison", "compare_plans", "failed",
            f"Unknown current plan \"{customer['plan']}\" — no price in the plan price table. Run stopped.")
        result.failure_reason = f"Unknown current plan \"{customer['plan']}\"."
        return result
    diff = round(target_price - current_price, 2)
    if diff == 0:
        add("validate", "Eligibility + price comparison", "compare_plans", "failed",
            f"Customer is already on {target_plan}. There is nothing to change. Run stopped.")
        result.failure_reason = f"Customer is already on {target_plan}."
        return result
    calc = (f"{customer['plan']} ${current_price:.2f} → {target_plan} ${target_price:.2f}. "
            f"Difference: {'+' if diff > 0 else '-'}${abs(diff):.2f}{' (charge)' if diff > 0 else ' (credit)'}.")
    if diff > 0:
        add("validate", "Eligibility + price comparison", "compare_plans", "done",
            f"{calc} Customer confirmation is required before the change is applied.")
        result.effect_kind = "plan_change"
        result.effect_data = {"newPlan": target_plan, "charge": diff}
        result.proposed_action = f"Change plan to {target_plan} (pro-rated charge ${diff:.2f})"
        add("plan-propose", "Plan + propose change", "propose_plan_change", "done",
            f"Propose the change to {target_plan} at ${diff:.2f} pro-rated. Human approval required.")
        return result
    credit = abs(diff)
    add("validate", "Eligibility + price comparison", "compare_plans", "done",
        f"{calc} The cheaper target plan means the customer is owed a credit, not a charge. "
        "Customer confirmation is required before the change is applied.")
    result.proposed_credit = credit
    result.effect_kind = "plan_change"
    result.effect_data = {"newPlan": target_plan, "credit": credit}
    result.proposed_action = f"Change plan to {target_plan} (pro-rated credit ${credit:.2f})"
    add("plan-propose", "Plan + propose change", "propose_plan_change", "done",
        f"Propose the change to {target_plan} with a ${credit:.2f} pro-rated credit. Human approval required.")
    return result


def _plan_retention(state, case, customer, result, add):
    leaf = _stair_ground(state, "retention save offer churn")
    if leaf is None:
        add("stair-ground", "STAIR policy grounding", "stair_retrieve", "failed", "No section covers save offers.")
        result.failure_reason = "No grounding section found for retention save offers."
        return result
    result.citation = f"{leaf['path']} {leaf['section']}"
    add("stair-ground", "STAIR policy grounding", "stair_retrieve", "done", f"Grounded in {leaf['path']} {leaf['section']}.", citation=result.citation)
    signals = [s for s in [("suspended account" if customer["status"] == "suspended" else None),
                           ("outstanding balance" if customer["balance"] > 0 else None)] if s]
    if len(signals) < 2:
        add("validate", "Churn-risk check", "assess_churn_risk", "failed",
            f"Only {len(signals)} churn-risk signal(s) found. Two are required for a save offer.")
        result.failure_reason = "Not enough churn-risk signals for a save offer."
        return result
    add("validate", "Churn-risk check", "assess_churn_risk", "done", f"Churn-risk confirmed: {' + '.join(signals)}. Eligible for a save offer.")
    result.proposed_credit = RETENTION_CREDIT_USD
    result.effect_kind = "retention_offer"
    result.effect_data = {"amount": RETENTION_CREDIT_USD}
    result.proposed_action = f"Apply a ${RETENTION_CREDIT_USD:.2f} goodwill credit and reactivate the account"
    add("plan-propose", "Plan + propose save offer", "propose_save_offer", "done", f"Propose a ${RETENTION_CREDIT_USD:.2f} goodwill credit and account reactivation. Human approval required.")
    return result


def credit_already_applied(state: dict, case_id: str) -> bool:
    return any(e["id"] == f"LED-CR-{case_id}" for e in state["ledger"])


def validate_pipeline_batch(state: dict) -> dict:
    exceptions: list[str] = []
    failed = 0
    dup = find_duplicate(state["ledger"], "CUST-1001")
    if dup:
        exceptions.append(
            f"Duplicate charge: CUST-1001 {dup['original']['invoice']} + "
            f"{dup['duplicate']['invoice']} (${dup['duplicate']['amount']:.2f})"
        )
        failed += 1
    for c in state["customers"]:
        if c["status"] == "suspended" and c["balance"] > 0:
            exceptions.append(
                f"Suspended account with balance: {c['id']} {c['name']} (${c['balance']:.2f})"
            )
            failed += 1
    for e in state["ledger"]:
        if not any(c["id"] == e["customerId"] for c in state["customers"]):
            exceptions.append(f"Ledger {e['id']} references unknown customer {e['customerId']}")
            failed += 1
        if e["amount"] == 0:
            exceptions.append(f"Ledger {e['id']} has a zero amount")
            failed += 1
    processed = len(state["customers"]) + len(state["ledger"]) + len(state["usage"])
    return {"processed": processed, "failed": failed, "exceptions": exceptions}


def run_eval_suite(state: dict) -> list[dict]:
    results: list[dict] = []
    dup = find_duplicate(state["ledger"], "CUST-1001")
    results.append({"id": "E1", "name": "Duplicate detected for CASE-1001 customer",
                    "passed": dup is not None and dup["duplicate"]["invoice"] == "INV-2041",
                    "detail": f"Found {dup['original']['invoice']} + {dup['duplicate']['invoice']}" if dup else "No duplicate found"})
    results.append({"id": "E2", "name": "Duplicate amount equals $87.40",
                    "passed": dup is not None and dup["duplicate"]["amount"] == 87.4,
                    "detail": f"${dup['duplicate']['amount']:.2f}" if dup else "No duplicate"})
    results.append({"id": "E3", "name": "Different service is not a duplicate (CUST-1004)",
                    "passed": find_duplicate([e for e in state["ledger"] if e["customerId"] == "CUST-1004"], "CUST-1004") is None,
                    "detail": "Different services — correctly not flagged"})
    results.append({"id": "E4", "name": "No duplicate for single-charge customer (CUST-1005)",
                    "passed": find_duplicate(state["ledger"], "CUST-1005") is None,
                    "detail": "Correctly no duplicate"})
    rag = grounded_answer(state["docs"], "duplicate charge credit policy")
    results.append({"id": "E5", "name": "RAG grounds duplicate-charge policy with citation",
                    "passed": not rag["refused"] and rag["citations"][0]["docId"] == "POL-001",
                    "detail": f"Cited {rag['citations'][0]['docId']}" if not rag["refused"] else "Refused — no doc"})
    rag_off = grounded_answer(state["docs"], "quantum entanglement warranty terms")
    results.append({"id": "E6", "name": "RAG refuses when answer is not in the docs",
                    "passed": rag_off["refused"],
                    "detail": "Correctly refused" if rag_off["refused"] else "Answered without grounding — fail"})
    keys = [c["idempotencyKey"] for c in state["cases"]]
    results.append({"id": "E7", "name": "Idempotency: credit key is unique per case",
                    "passed": len(set(keys)) == len(keys),
                    "detail": f"{len(keys)} cases, {len(set(keys))} unique keys"})
    c1001 = next((c for c in state["cases"] if c["id"] == "CASE-1001"), None)
    plan = plan_run(state, c1001) if c1001 else None
    results.append({"id": "E8", "name": "Agent plan proposes $87.40 for CASE-1001",
                    "passed": plan is not None and plan.proposed_credit == 87.4,
                    "detail": f"Proposed ${plan.proposed_credit:.2f}" if plan and plan.proposed_credit else "No proposal"})
    return results


def eval_score(results: list[dict]) -> dict:
    passed = sum(1 for r in results if r["passed"])
    score = round(passed / max(1, len(results)) * 100)
    return {"scorePct": score, "passed": score >= EVAL_GATE_PCT}
