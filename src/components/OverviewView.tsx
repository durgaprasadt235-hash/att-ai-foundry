/* ---------------- Overview ----------------
 * High-level documentation, in the app as its own page (after System).
 * Same content as docs/HIGH_LEVEL_OVERVIEW.md — that file is the source
 * of truth; keep the two in sync if either changes. Layout follows the
 * app's tokens exactly: same 960px wrap, same panel padding, same h1/h2
 * sizes. Everything left-aligned on one edge: headings, body text,
 * numbered rows and the About contact rows. */
export default function OverviewView() {
  return (
    <section>
      <h1>About Me</h1>
      <p className="small muted">Who built this, and what it is.</p>

      <div className="panel">
        <h2>About Me</h2>
        <p><strong>Durga Prasad Thoorpati</strong></p>
        <div className="ov-kv"><span className="k">Email</span><span>durgaprasadt235@gmail.com</span></div>
        <div className="ov-kv"><span className="k">Phone</span><span>+1 (201) 268-4657</span></div>
        <p className="mt">A senior software engineer with hands-on experience building enterprise data platforms and AI-integrated systems across telecom, banking, mortgage banking, and logistics and supply chains — production Python and APIs, data engineering and reconciliation at scale, retrieval and agentic workflows, and the operational discipline (evaluation, observability, audit) that turns a pilot into a system a business can run.</p>
      </div>

      <div className="panel">
        <h2>What this is</h2>
        <p>A working prototype of an AI agent that does real enterprise work across the entire customer journey — not a chatbot, and not a demo that pretends. A customer calls, the agent finds the account, verifies the customer, understands the problem from the record, grounds every answer in written policy, proposes an action, and waits for a human to approve it before anything changes. Every step is traced, measured, and written to an audit log.</p>
      </div>

      <div className="panel">
        <h2>The problem it answers</h2>
        <p>Most enterprise AI pilots deliver no measurable return. This one is built to be in the small number that do: it executes complete tasks — a billing dispute resolved with a credit, a new line provisioned, an outage triaged with a technician booked, a plan changed, a customer retained — and it proves each outcome against the record instead of claiming it.</p>
      </div>

      <div className="panel">
        <h2>The five journeys</h2>
        <ol className="ov-steps">
          <li><span className="ov-num">1</span><span><strong>Billing dispute</strong> — a duplicate charge is found, verified against the ledger, and credited once. A second run of the same case returns the original result; it never issues a second credit.</span></li>
          <li><span className="ov-num">2</span><span><strong>Service provisioning</strong> — a new line or device, only when the account is in good standing.</span></li>
          <li><span className="ov-num">3</span><span><strong>Network outage triage</strong> — the outage is confirmed against the network record before any credit or visit is offered.</span></li>
          <li><span className="ov-num">4</span><span><strong>Plan change and upgrade</strong> — priced from the real plan table, so a change can be a charge or a credit depending on direction.</span></li>
          <li><span className="ov-num">5</span><span><strong>Retention</strong> — a save offer only when the record shows real churn signals, not on a single complaint.</span></li>
        </ol>
        <p className="small muted mt">Four of the twelve seeded cases honestly fail — a suspended account, a case type with no workflow, too few churn signals, a balance over the limit. The agent says why, and the case stays open for a human.</p>
      </div>

      <div className="panel">
        <h2>How a call works</h2>
        <ol className="ov-steps">
          <li><span className="ov-num">1</span><span><strong>Find and confirm the customer.</strong> The operator searches by name, phone number, account number, email, or customer ID. The customer is then verified the way a telecom carrier verifies today: name and number first, then the 6-digit account PIN, or a one-time code sent to the registered phone or email — only after the customer confirms the registered email matches.</span></li>
          <li><span className="ov-num">2</span><span><strong>Customer 360.</strong> Plan, balance, ledger, usage, and open cases — the same view the agent builds before it acts.</span></li>
          <li><span className="ov-num">3</span><span><strong>Grounding with STAIR.</strong> The agent looks up the answer in the policy documents themselves, structured as trees, and cites the exact section (for example, Billing Policy &gt; Credits &gt; Duplicate Charges §4.2). If the policy does not contain the answer, the agent says so and stops. No chunking, no embeddings, no vector database — by design.</span></li>
          <li><span className="ov-num">4</span><span><strong>Validate, propose, wait.</strong> The proposal is checked against the record, then a human approves or rejects it. Nothing is credited, activated, or changed until a person approves.</span></li>
          <li><span className="ov-num">5</span><span><strong>Execute and verify.</strong> The approved action runs once, the ledger and the customer are updated, the customer is notified, and the outcome is verified against the record and measured.</span></li>
        </ol>
      </div>

      <div className="panel">
        <h2>Data — raw in, production-ready out</h2>
        <p>A team does not hand over live system access on a first call. It brings a file. The app accepts the file raw or clean — that is the process. Uploaded data is checked, cleansed automatically, and a production-ready file comes out the other side: balances recomputed from the ledger, bad records quarantined, every correction listed, nothing changed silently. The same rules run for a 20-record sample and a 1,000-record file.</p>
        <p>Behind that is a three-layer data flow: raw data lands, cleansing and quality checks run, and only clean records reach the production layer. One operator runs it, with a ready-made fix prompt on every failure — no team of engineers to babysit it.</p>
      </div>

      <div className="panel">
        <h2>Accountability</h2>
        <p>Every action — a search, a customer viewed, a case created, an agent run, an approval, a deletion — is written to an append-only audit log tagged with the operator&apos;s login, so any change to a customer or their data can be traced back to who made it. That record is backend-only; it is never shown on the customer-facing screens.</p>
      </div>

      <div className="panel">
        <h2>Quality gate</h2>
        <p>Nothing is released on a claim. An evaluation suite runs the same questions against the agent and the retrieval layer, and a release is approved only when the suite passes its 85% gate. The gate blocks; it does not warn.</p>
      </div>

      <div className="panel">
        <h2>Architecture, in brief</h2>
        <ul className="ov-bullets">
          <li><strong>Operator app</strong> — a web application: Dashboard, Data, Customers, Cases, System, and About Me. The System area holds pipelines, data layers, knowledge, evaluations, and observability.</li>
          <li><strong>Agent engine</strong> — the same rules in two forms: a deterministic engine in the app, and a Python reference backend (FastAPI-style, LangGraph-style state machine) in <code>server/</code>.</li>
          <li><strong>Live language model, optional</strong> — Groq is wired in, and when it is available it picks the policy section and drafts the summary. When it is not, the deterministic engine runs instead and says so. The human approval step gates everything either way.</li>
          <li><strong>Data source switch</strong> — the app runs on a built-in dataset or an uploaded file today; pointing it at real carrier systems is a configuration change plus the fulfilment team&apos;s access, not a rebuild.</li>
        </ul>
      </div>

      <div className="panel">
        <h2>Honest limits</h2>
        <ul className="ov-bullets">
          <li>No real carrier internal system is connected. All data in the demo is synthetic, and the app says so.</li>
          <li>The live language model is optional; without its key the agent is deterministic code.</li>
          <li>Sign-in is a demo gate; production sign-in is the company&apos;s identity system, which is not wired in yet.</li>
          <li>Scale at petabyte volume is architectural, not measured in this demo.</li>
          <li>Verification in the demo is recorded by the operator; production checks the PIN and sends the code through the account verification service.</li>
        </ul>
      </div>

      <div className="panel">
        <h2>First call, in minutes</h2>
        <ol className="ov-steps">
          <li><span className="ov-num">1</span><span>Open the app and upload a sample file (10–20 customers, a few known duplicates, two or three cases per journey, at least one case that should fail).</span></li>
          <li><span className="ov-num">2</span><span>Check the validation and cleansing report.</span></li>
          <li><span className="ov-num">3</span><span>Find a customer, verify them, create a case, and run the agent.</span></li>
          <li><span className="ov-num">4</span><span>Approve or reject the proposal, and read the measured outcome.</span></li>
        </ol>
      </div>
    </section>
  );
}
