"""Pytest unit tests for the deterministic agent engine (server/engine.py).

These mirror the TypeScript engine's behaviour: same duplicate rule,
same RAG grounding/refusal, same idempotency, same eval suite.
Run: python3 -m pytest server/test_engine.py -v
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

def _seed_trees():
    seed = Path(__file__).parent / "seed.json"
    if seed.exists():
        return json.loads(seed.read_text()).get("stairTrees", [])
    return []

from engine import (  # noqa: E402
    credit_already_applied,
    eval_score,
    find_duplicate,
    grounded_answer,
    plan_run,
    run_eval_suite,
    validate_pipeline,
)


def make_state(**overrides):
    state = {
        "customers": [
            {"id": "CUST-1001", "name": "Maya Rodriguez", "account": "ACC-884120",
             "plan": "Unlimited Premium", "status": "active", "balance": 174.80},
            {"id": "CUST-1003", "name": "Priya Nair", "account": "ACC-884122",
             "plan": "Unlimited Premium", "status": "active", "balance": 0.0},
            {"id": "CUST-1004", "name": "Daniel Kim", "account": "ACC-884123",
             "plan": "Business Elite", "status": "active", "balance": 412.60},
            {"id": "CUST-1002", "name": "James Okafor", "account": "ACC-884121",
             "plan": "Unlimited Starter", "status": "active", "balance": 65.00},
            {"id": "CUST-1005", "name": "Sofia Almeida", "account": "ACC-884124",
             "plan": "Unlimited Starter", "status": "suspended", "balance": 129.99},
        ],
        "ledger": [
            {"id": "LED-01", "customerId": "CUST-1001", "invoice": "INV-2039", "date": "2026-11-08",
             "service": "Unlimited Premium — monthly plan", "amount": 87.40, "kind": "charge", "status": "posted"},
            {"id": "LED-02", "customerId": "CUST-1001", "invoice": "INV-2041", "date": "2026-11-14",
             "service": "Unlimited Premium — monthly plan", "amount": 87.40, "kind": "charge", "status": "posted"},
            {"id": "LED-06", "customerId": "CUST-1004", "invoice": "INV-2150", "date": "2026-11-09",
             "service": "Business Elite — monthly plan", "amount": 112.00, "kind": "charge", "status": "posted"},
            {"id": "LED-07", "customerId": "CUST-1004", "invoice": "INV-2151", "date": "2026-11-09",
             "service": "Business Elite — additional line", "amount": 112.00, "kind": "charge", "status": "posted"},
            {"id": "LED-05", "customerId": "CUST-1003", "invoice": "INV-2110", "date": "2026-11-11",
             "service": "Unlimited Premium — monthly plan", "amount": 87.40, "kind": "charge", "status": "posted"},
        ],
        "usage": [{"id": "USE-01", "customerId": "CUST-1001", "month": "2026-11", "dataGb": 42.1, "minutes": 120, "sms": 10}],
        "tickets": [],
        "cases": [
            {"id": "CASE-1001", "customerId": "CUST-1001", "type": "duplicate_charge",
             "title": "Double charge", "amount": 87.40, "idempotencyKey": "case-1001-v1"},
            {"id": "CASE-1002", "customerId": "CUST-1001", "type": "plan_change",
             "title": "Plan change", "amount": 0, "idempotencyKey": "case-1002-v1"},
            {"id": "CASE-1004", "customerId": "CUST-1002", "type": "provisioning",
             "title": "New line", "amount": 0, "idempotencyKey": "case-1004-v1"},
            {"id": "CASE-1005", "customerId": "CUST-1001", "type": "outage",
             "title": "Outage", "amount": 25, "idempotencyKey": "case-1005-v1",
             "description": "Network outage in the customer area, network-confirmed duration over 4 hours."},
            {"id": "CASE-1006", "customerId": "CUST-1002", "type": "plan_change",
             "title": "Upgrade", "amount": 22.40, "idempotencyKey": "case-1006-v1"},
            {"id": "CASE-1007", "customerId": "CUST-1005", "type": "retention",
             "title": "Save offer", "amount": 25, "idempotencyKey": "case-1007-v1"},
        ],
        "stairTrees": _seed_trees(),
        "docs": [
            {"id": "POL-001", "title": "Duplicate Billing Credit Policy",
             "body": "If the same customer is charged twice for the same service, same amount, "
                     "within 7 days, with different invoice numbers, the second charge is a duplicate. "
                     "Issue a credit for the full amount of the duplicate charge. The credit must be "
                     "approved by a human reviewer before it is posted."},
        ],
    }
    state.update(overrides)
    return state


def test_duplicate_detected_for_case_1001():
    dup = find_duplicate(make_state()["ledger"], "CUST-1001")
    assert dup is not None
    assert dup["duplicate"]["invoice"] == "INV-2041"
    assert dup["duplicate"]["amount"] == 87.40


def test_different_service_is_not_a_duplicate():
    state = make_state()
    assert find_duplicate(state["ledger"], "CUST-1004") is None


def test_single_charge_is_not_a_duplicate():
    assert find_duplicate(make_state()["ledger"], "CUST-1003") is None


def test_plan_proposes_87_40_and_pauses_for_approval():
    state = make_state()
    plan = plan_run(state, state["cases"][0])
    assert plan.failure_reason is None
    assert plan.proposed_credit == 87.40
    assert plan.citation == "Billing Policy > Credits > Duplicate Charges §4.2"
    assert [s["id"] for s in plan.steps] == [
        "intake", "retrieve-360", "stair-ground", "validate", "plan-propose"]


def test_plan_fails_honestly_for_case_type_with_no_workflow():
    state = make_state()
    roaming = {"id": "CASE-1003", "customerId": "CUST-1001", "type": "roaming_dispute",
               "title": "Roaming", "amount": 12.99, "idempotencyKey": "case-1003-v1"}
    plan = plan_run(state, roaming)
    assert plan.proposed_credit is None
    assert plan.failure_reason is not None
    assert "no agent workflow" in plan.failure_reason


def test_plan_fails_when_no_duplicate_in_ledger():
    state = make_state()
    case = dict(state["cases"][0], customerId="CUST-1003")
    plan = plan_run(state, case)
    assert plan.proposed_credit is None
    assert plan.failure_reason == "No duplicate charge found in the ledger."


def test_plan_fails_without_grounding_policy():
    # STAIR is the primary grounding now: remove the knowledge trees, not just docs.
    state = make_state(docs=[], stairTrees=[])
    plan = plan_run(state, state["cases"][0])
    assert plan.failure_reason == "No grounding section found for duplicate charges."


def test_rag_grounds_with_citation():
    state = make_state()
    result = grounded_answer(state["docs"], "duplicate charge credit policy")
    assert result["refused"] is False
    assert result["citations"][0]["docId"] == "POL-001"


def test_rag_refuses_when_not_in_docs():
    state = make_state()
    result = grounded_answer(state["docs"], "quantum entanglement warranty terms")
    assert result["refused"] is True
    assert result["citations"] == []


def test_idempotency_credit_key():
    state = make_state()
    assert credit_already_applied(state, "CASE-1001") is False
    state["ledger"].append({"id": "LED-CR-CASE-1001", "customerId": "CUST-1001",
                            "invoice": "INV-2041", "date": "2026-11-21",
                            "service": "Credit", "amount": -87.40, "kind": "credit", "status": "posted"})
    assert credit_already_applied(state, "CASE-1001") is True


def test_pipeline_counts_are_per_pipeline_not_whole_batch():
    state = make_state()
    p1 = validate_pipeline("PIPE-01", state)
    assert p1["processed"] == 5  # customers only
    assert p1["failed"] == 1  # suspended CUST-1005 with balance
    assert any("Suspended account" in e for e in p1["exceptions"])
    assert not any("Duplicate charge" in e for e in p1["exceptions"])
    p2 = validate_pipeline("PIPE-02", state)
    assert p2["processed"] == 5  # ledger only
    assert p2["failed"] == 1  # duplicate CUST-1001 INV-2039 + INV-2041
    assert any("Duplicate charge: CUST-1001 INV-2039 + INV-2041 ($87.40)" in e for e in p2["exceptions"])
    assert not any("Suspended account" in e for e in p2["exceptions"])
    p3 = validate_pipeline("PIPE-03", state)
    assert p3["processed"] == 1  # usage only
    assert p3["failed"] == 0  # the one usage record is clean
    assert p3["exceptions"] == []
    assert validate_pipeline("PIPE-99", state)["failed"] == 1


def test_pipeline_02_flags_unknown_customer_zero_amount_and_all_duplicates():
    state = make_state()
    state["ledger"].append({"id": "LED-99", "customerId": "CUST-9999", "invoice": "INV-9999",
                            "date": "2026-11-15", "service": "Plan", "amount": 10.00,
                            "kind": "charge", "status": "posted"})
    state["ledger"].append({"id": "LED-98", "customerId": "CUST-1003", "invoice": "INV-9998",
                            "date": "2026-11-15", "service": "Plan", "amount": 0,
                            "kind": "charge", "status": "posted"})
    result = validate_pipeline("PIPE-02", state)
    assert result["processed"] == 7
    assert result["failed"] == 3  # duplicate + unknown customer + zero amount
    assert any("unknown customer CUST-9999" in e for e in result["exceptions"])
    assert any("zero amount" in e for e in result["exceptions"])


def test_pipeline_03_flags_unknown_customer_negative_and_zero_usage_on_active():
    state = make_state()
    state["usage"] = [
        {"id": "USE-01", "customerId": "CUST-1001", "month": "2026-11", "dataGb": 42.1, "minutes": 120, "sms": 10},
        {"id": "USE-02", "customerId": "CUST-9999", "month": "2026-11", "dataGb": 1.0, "minutes": 5, "sms": 0},
        {"id": "USE-03", "customerId": "CUST-1003", "month": "2026-11", "dataGb": -1.0, "minutes": 5, "sms": 0},
        {"id": "USE-04", "customerId": "CUST-1002", "month": "2026-11", "dataGb": 0, "minutes": 0, "sms": 0},
    ]
    result = validate_pipeline("PIPE-03", state)
    assert result["processed"] == 4
    assert result["failed"] == 3  # unknown customer + negative + zero usage on active CUST-1002
    assert any("unknown customer CUST-9999" in e for e in result["exceptions"])
    assert any("negative value" in e for e in result["exceptions"])
    assert any("zero usage" in e for e in result["exceptions"])


def test_eval_suite_passes_and_gate_is_85():
    state = make_state()
    results = run_eval_suite(state)
    assert len(results) == 8
    score = eval_score(results)
    assert score["scorePct"] == 100
    assert score["passed"] is True


def test_eval_suite_fails_when_policy_doc_deleted():
    # Deleting the knowledge trees (STAIR) breaks grounding + the agent plan.
    state = make_state(docs=[], stairTrees=[])
    results = run_eval_suite(state)
    score = eval_score(results)
    assert score["passed"] is False
    assert score["scorePct"] < 85


def _case(state, case_id):
    return next(c for c in state["cases"] if c["id"] == case_id)


def test_provisioning_proposes_activation_for_eligible_account():
    state = make_state()
    plan = plan_run(state, _case(state, "CASE-1004"))
    assert plan.failure_reason is None
    assert plan.effect_kind == "provisioning"
    assert plan.proposed_action == "Activate a second line with device activation"


def test_provisioning_fails_for_suspended_account():
    state = make_state()
    case = dict(_case(state, "CASE-1004"), customerId="CUST-1005")
    plan = plan_run(state, case)
    assert plan.failure_reason is not None
    assert "active" in plan.failure_reason


def test_outage_proposes_credit_and_technician():
    state = make_state()
    plan = plan_run(state, _case(state, "CASE-1005"))
    assert plan.failure_reason is None
    assert plan.effect_kind == "outage_credit"
    assert plan.proposed_credit == 25


def test_plan_change_proposes_upgrade_with_prorated_charge():
    state = make_state()
    plan = plan_run(state, _case(state, "CASE-1006"))
    assert plan.failure_reason is None
    assert plan.effect_kind == "plan_change"
    assert plan.effect_data["charge"] == 22.4
    assert plan.effect_data["newPlan"] == "Unlimited Premium"


def test_plan_change_fails_when_already_premium():
    state = make_state()
    case = dict(_case(state, "CASE-1006"), customerId="CUST-1001")
    # CUST-1001 is already on Unlimited Premium in the fixture? No — set it.
    state["customers"][0]["plan"] = "Unlimited Premium"
    plan = plan_run(state, case)
    assert plan.failure_reason == "Customer is already on Unlimited Premium."


def test_retention_proposes_save_offer_for_churn_risk():
    state = make_state()
    plan = plan_run(state, _case(state, "CASE-1007"))
    assert plan.failure_reason is None
    assert plan.effect_kind == "retention_offer"
    assert plan.proposed_credit == 25


def _owen_vale(state):
    state["customers"].append(
        {"id": "CUST-1007", "name": "Owen Vale", "account": "ACC-884126",
         "plan": "Business Elite", "status": "active", "balance": 99.64})
    return state


def test_outage_proposes_25_and_trace_names_both_amounts():
    state = _owen_vale(make_state())
    case = {"id": "CASE-1007", "customerId": "CUST-1007", "type": "outage",
            "title": "Service interruption credit inquiry",
            "description": "INV-3071 on 2026-11-09 billed $18.45 for Device installment; "
                           "the customer requests outage credit, subject to network-confirmed "
                           "duration over 4 hours.",
            "amount": 18.45, "idempotencyKey": "case-1007-v1"}
    plan = plan_run(state, case)
    assert plan.failure_reason is None
    assert plan.proposed_credit == 25
    assert plan.effect_kind == "outage_credit"
    assert plan.effect_data["amount"] == 25
    detail = " ".join(s["detail"] for s in plan.steps)
    assert ("Case amount $18.45 is the reported device installment, not the credit. "
            "Policy credit is $25.00 per Outage Service Credit Policy §5.1, network-confirmed >4h.") in detail
    assert "$18.45" in detail and "$25.00" in detail


def test_outage_fails_when_not_network_confirmed():
    state = _owen_vale(make_state())
    case = {"id": "CASE-1007", "customerId": "CUST-1007", "type": "outage",
            "title": "Service interruption credit inquiry",
            "description": "Customer reports no service since this morning. "
                           "No network confirmation is on file for this area.",
            "amount": 18.45, "idempotencyKey": "case-1007-v1"}
    plan = plan_run(state, case)
    assert plan.proposed_credit is None
    assert plan.failure_reason is not None
    assert "not network-confirmed" in plan.failure_reason


def _tessa_marlow(state):
    state["customers"].append(
        {"id": "CUST-1008", "name": "Tessa Marlow", "account": "ACC-884127",
         "plan": "Family Share", "status": "active", "balance": 121.16})
    return state


def test_plan_change_family_share_to_premium_is_10_60_credit():
    state = _tessa_marlow(make_state())
    case = {"id": "CASE-1008", "customerId": "CUST-1008", "type": "plan_change",
            "title": "Plan change — Family Share ($98.00) to Unlimited Premium ($87.40), $10.60 credit",
            "description": "Customer on Family Share ($98.00) requests a plan change to Unlimited Premium ($87.40). "
                           "Pro-rated difference is -$10.60, so the change posts a $10.60 credit, not a charge. "
                           "INV-3080 on 2026-11-08 billed $98.00 for Family Share — monthly plan.",
            "amount": 98.0, "idempotencyKey": "case-1008-v1"}
    plan = plan_run(state, case)
    assert plan.failure_reason is None
    assert plan.proposed_credit == 10.6
    assert plan.effect_kind == "plan_change"
    assert plan.effect_data == {"newPlan": "Unlimited Premium", "credit": 10.6}
    detail = " ".join(s["detail"] for s in plan.steps)
    assert "Family Share $98.00" in detail
    assert "Unlimited Premium $87.40" in detail
    assert "-$10.60" in detail


def test_plan_change_starter_to_premium_is_22_40_charge_for_case_1010():
    state = make_state()
    state["customers"].append(
        {"id": "CUST-1010", "name": "Iris Fenwick", "account": "ACC-884129",
         "plan": "Unlimited Starter", "status": "active", "balance": 89.20})
    case = {"id": "CASE-1010", "customerId": "CUST-1010", "type": "plan_change",
            "title": "Premium plan comparison",
            "description": "INV-3100 on 2026-11-08 billed $65.00 for Unlimited Starter — monthly plan; "
                           "customer requests comparison with Unlimited Premium at $87.40, a $22.40 difference.",
            "amount": 65.0, "idempotencyKey": "case-1010-v1"}
    plan = plan_run(state, case)
    assert plan.failure_reason is None
    assert plan.proposed_credit is None
    assert plan.effect_kind == "plan_change"
    assert plan.effect_data == {"newPlan": "Unlimited Premium", "charge": 22.4}
    detail = " ".join(s["detail"] for s in plan.steps)
    assert "$22.40" in detail


def test_plan_change_target_parsed_from_description():
    state = make_state()
    case = dict(_case(state, "CASE-1006"), customerId="CUST-1001",
                description="Change plan to Family Share")
    state["customers"][0]["plan"] = "Unlimited Premium"
    plan = plan_run(state, case)
    assert plan.failure_reason is None
    assert plan.effect_data == {"newPlan": "Family Share", "charge": 10.6}


def test_plan_change_fails_when_already_on_target_plan():
    state = make_state()
    case = dict(_case(state, "CASE-1006"), customerId="CUST-1001",
                description="Change plan to Family Share")
    state["customers"][0]["plan"] = "Family Share"
    plan = plan_run(state, case)
    assert plan.failure_reason == "Customer is already on Family Share."


def test_seeded_cases_1007_1008_1010():
    """Guard against seed/engine drift: run the real seeded cases."""
    seed = json.loads((Path(__file__).parent / "seed.json").read_text())
    by_id = {c["id"]: c for c in seed["cases"]}
    p7 = plan_run(seed, by_id["CASE-1007"])
    assert p7.failure_reason is None
    assert p7.proposed_credit == 25
    assert p7.effect_kind == "outage_credit"
    p8 = plan_run(seed, by_id["CASE-1008"])
    assert p8.failure_reason is None
    assert p8.proposed_credit == 10.6
    assert p8.effect_data == {"newPlan": "Unlimited Premium", "credit": 10.6}
    p10 = plan_run(seed, by_id["CASE-1010"])
    assert p10.failure_reason is None
    assert p10.proposed_credit is None
    assert p10.effect_data == {"newPlan": "Unlimited Premium", "charge": 22.4}
