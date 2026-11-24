# Telecom Project — High-Level Overview

## About Me

**Durga Prasad Thoorpati**
Email: durgaprasadt235@gmail.com · Phone: +1 (201) 268-4657

A senior software engineer with hands-on experience building enterprise
data platforms and AI-integrated systems across telecom, banking,
mortgage banking, and logistics and supply chains — production Python
and APIs, data engineering and reconciliation at scale, retrieval and
agentic workflows, and the operational discipline (evaluation,
observability, audit) that turns a pilot into a system a business can
run.

## What this is

A working prototype of an AI agent that does real enterprise work across the
entire customer journey — not a chatbot, and not a demo that pretends.
A customer calls, the agent finds the account, verifies the customer,
understands the problem from the record, grounds every answer in written
policy, proposes an action, and waits for a human to approve it before
anything changes. Every step is traced, measured, and written to an audit
log.

## The problem it answers

Most enterprise AI pilots deliver no measurable return. This one is built
to be in the small number that do: it executes complete tasks — a billing
dispute resolved with a credit, a new line provisioned, an outage triaged
with a technician booked, a plan changed, a customer retained — and it
proves each outcome against the record instead of claiming it.

## The five journeys

1. **Billing dispute** — a duplicate charge is found, verified against the
   ledger, and credited once. A second run of the same case returns the
   original result; it never issues a second credit.
2. **Service provisioning** — a new line or device, only when the account
   is in good standing.
3. **Network outage triage** — the outage is confirmed against the
   network record before any credit or visit is offered.
4. **Plan change and upgrade** — priced from the real plan table, so a
   change can be a charge or a credit depending on direction.
5. **Retention** — a save offer only when the record shows real churn
   signals, not on a single complaint.

Four of the twelve seeded cases honestly fail — a suspended account, a
case type with no workflow, too few churn signals, a balance over the
limit. The agent says why, and the case stays open for a human.

## How a call works

1. **Find and confirm the customer.** The operator searches by name,
   phone number, account number, email, or customer ID. The customer is
   then verified the way AT&T verifies today: name and number first,
   then the 6-digit account PIN, or a one-time code sent to the
   registered phone or email — only after the customer confirms the
   registered email matches.
2. **Customer 360.** Plan, balance, ledger, usage, and open cases — the
   same view the agent builds before it acts.
3. **Grounding with STAIR.** The agent looks up the answer in the policy
   documents themselves, structured as trees, and cites the exact section
   (for example, Billing Policy > Credits > Duplicate Charges §4.2). If
   the policy does not contain the answer, the agent says so and stops.
   No chunking, no embeddings, no vector database — by design.
4. **Validate, propose, wait.** The proposal is checked against the
   record, then a human approves or rejects it. Nothing is credited,
   activated, or changed until a person approves.
5. **Execute and verify.** The approved action runs once, the ledger and
   the customer are updated, the customer is notified, and the outcome is
   verified against the record and measured.

## Data — raw in, production-ready out

A team does not hand over live system access on a first call. It brings
a file. The app accepts the file raw or clean — that is the process.
Uploaded data is checked, cleansed automatically, and a
production-ready file comes out the other side: balances recomputed from
the ledger, bad records quarantined, every correction listed, nothing
changed silently. The same rules run for a 20-record sample and a
1,000-record file.

Behind that is a three-layer data flow: raw data lands, cleansing and
quality checks run, and only clean records reach the production layer.
One operator runs it, with a ready-made fix prompt on every failure —
no team of engineers to babysit it.

## Accountability

Every action — a search, a customer viewed, a case created, an agent
run, an approval, a deletion — is written to an append-only audit log
tagged with the operator's login, so any change to a customer or their
data can be traced back to who made it. That record is backend-only;
it is never shown on the customer-facing screens.

## Quality gate

Nothing is released on a claim. An evaluation suite runs the same
questions against the agent and the retrieval layer, and a release is
approved only when the suite passes its 85% gate. The gate blocks;
it does not warn.

## Architecture, in brief

- **Operator app** — a web application: Dashboard, Data, Customers,
  Cases, System, and About Me. The System area holds pipelines,
  data layers, knowledge, evaluations, and observability.
- **Agent engine** — the same rules in two forms: a deterministic
  engine in the app, and a Python reference backend (FastAPI-style,
  LangGraph-style state machine) in `server/`.
- **Live language model, optional** — Groq is wired in, and when it is
  available it picks the policy section and drafts the summary. When it
  is not, the deterministic engine runs instead and says so. The human
  approval step gates everything either way.
- **Data source switch** — the app runs on a built-in dataset or an
  uploaded file today; pointing it at real AT&T systems is a
  configuration change plus the fulfilment team's access, not a rebuild.

## Honest limits

- No real AT&T internal system is connected. All data in the demo is
  synthetic, and the app says so.
- The live language model is optional; without its key the agent is
  deterministic code.
- Sign-in is a demo gate; production sign-in is the company's identity
  system, which is not wired in yet.
- Scale at petabyte volume is architectural, not measured in this demo.
- Verification in the demo is recorded by the operator; production
  checks the PIN and sends the code through the account verification
  service.

## First call, in minutes

1. Open the app and upload a sample file (10–20 customers, a few known
   duplicates, two or three cases per journey, at least one case that
   should fail).
2. Check the validation and cleansing report.
3. Find a customer, verify them, create a case, and run the agent.
4. Approve or reject the proposal, and read the measured outcome.
