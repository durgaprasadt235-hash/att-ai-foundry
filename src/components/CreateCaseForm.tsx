// Case intake form — shared by the Dashboard and the Cases view.
//
// One form, one behaviour everywhere: pick an existing customer (or enter
// a new one), pick a journey, describe the problem, and the system creates
// a REAL new case record and runs the agent on it. There is no canned
// case anywhere in this form — every run starts from a case the operator
// just created, with a fresh id and idempotency key.
import { useState } from 'react';
import type { Case, Customer } from '../lib/types';
import { JOURNEYS, PLAN_OPTIONS, buildCase, type JourneyId } from '../lib/case-intake';
import { uid } from '../lib/store';
import { sortCustomersByName } from '../lib/customer-search';

export default function CreateCaseForm({ customers, cases, onCreateAndRun, preselectedCustomerId }: {
  customers: Customer[];
  cases: Case[];
  onCreateAndRun: (c: Case, newCustomer?: Customer) => void;
  /** When the form is opened from a Customer 360 panel, the customer is
   *  already known — pre-select them. Render with key={customerId} so a
   *  different customer remounts the form with the new pre-selection. */
  preselectedCustomerId?: string;
}) {
  const [customerMode, setCustomerMode] = useState<'existing' | 'new'>('existing');
  // No default customer — ever. The picker starts empty and the operator
  // must choose (or the form is pre-filled from a customer the operator
  // already found and confirmed). Defaulting to the first customer in
  // the list put Maya Rodriguez on the Dashboard on every load, so a
  // case could be created against the wrong person without anyone
  // noticing.
  const [customerId, setCustomerId] = useState(preselectedCustomerId ?? '');
  // The picker lists customers A–Z by name, like every other list.
  const sortedCustomers = sortCustomersByName(customers);
  const [newName, setNewName] = useState('');
  const [newPlan, setNewPlan] = useState(PLAN_OPTIONS[0]);
  const [journey, setJourney] = useState<JourneyId>('billing_dispute');
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState(JOURNEYS[0].defaultAmount);
  const [description, setDescription] = useState('');
  const [targetPlan, setTargetPlan] = useState('Unlimited Premium');
  const [networkConfirmed, setNetworkConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const journeyDef = JOURNEYS.find((j) => j.id === journey) ?? JOURNEYS[0];
  const valid = customerMode === 'existing'
    ? customerId !== '' && description.trim() !== '' && Number(amount) > 0
    : newName.trim() !== '' && description.trim() !== '' && Number(amount) > 0;

  const submit = () => {
    if (!valid || busy) return;
    setBusy(true);
    let custId = customerId;
    let newCustomer: Customer | undefined;
    if (customerMode === 'new') {
      newCustomer = {
        id: uid('CUST'),
        name: newName.trim(),
        account: `ACC-${Math.floor(100000 + Math.random() * 899999)}`,
        phone: '(555) 555-0100',
        email: '',
        plan: newPlan,
        status: 'active',
        since: new Date().toISOString().slice(0, 10),
        balance: 0,
        city: '—',
      };
      custId = newCustomer.id;
    }
    const c = buildCase({
      cases,
      customerId: custId,
      journey,
      title: title.trim() || journeyDef.label,
      description: description.trim(),
      amount: Number(amount),
      targetPlan: journey === 'plan_change' ? targetPlan : undefined,
      networkConfirmed: journey === 'network_outage' ? networkConfirmed : undefined,
    });
    setDescription('');
    setTitle('');
    setNewName('');
    setBusy(false);
    onCreateAndRun(c, newCustomer);
  };

  return (
    <div className="panel highlight">
      <h2>Create a case — and run the agent on it</h2>
      <p className="small muted">Every case is a real record: a new id, a unique idempotency key, and created just now. The agent validates it against the ledger and policy, proposes, and waits for your approval — nothing is credited or changed until you approve.</p>
      <div className="grid2">
        <div>
          <label>Customer</label>
          <select value={customerMode} onChange={(e) => setCustomerMode(e.target.value as 'existing' | 'new')}>
            <option value="existing">Existing customer</option>
            <option value="new">New customer…</option>
          </select>
        </div>
        <div>
          <label>Journey</label>
          <select value={journey} onChange={(e) => {
            const j = JOURNEYS.find((x) => x.id === e.target.value) ?? JOURNEYS[0];
            setJourney(j.id);
            setAmount(j.defaultAmount);
          }}>
            {JOURNEYS.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}
          </select>
        </div>
        {customerMode === 'existing' ? (
          <div>
            <label>Pick a customer</label>
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">Select a customer…</option>
              {sortedCustomers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.id}) — {c.plan}</option>)}
            </select>
          </div>
        ) : (
          <>
            <div>
              <label>New customer name</label>
              <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Full name" />
            </div>
            <div>
              <label>Current plan</label>
              <select value={newPlan} onChange={(e) => setNewPlan(e.target.value)}>
                {PLAN_OPTIONS.map((p) => <option key={p}>{p}</option>)}
              </select>
            </div>
          </>
        )}
        <div>
          <label>Amount ($)</label>
          <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} min="0" step="0.01" />
        </div>
        <div>
          <label>Title</label>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={journeyDef.label} />
        </div>
        {journey === 'plan_change' && (
          <div>
            <label>Change plan to</label>
            <select value={targetPlan} onChange={(e) => setTargetPlan(e.target.value)}>
              {PLAN_OPTIONS.map((p) => <option key={p}>{p}</option>)}
            </select>
          </div>
        )}
      </div>
      <div>
        <label>What happened?</label>
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe the case — invoices, dates, what the customer reported…" />
      </div>
      {journey === 'network_outage' && (
        <p className="small mt">
          <label style={{ display: 'inline', fontSize: '13px', color: 'inherit' }}>
            <input type="checkbox" checked={networkConfirmed} onChange={(e) => setNetworkConfirmed(e.target.checked)} style={{ width: 'auto', marginRight: '6px' }} />
            Network operations confirmed the outage (over 4 hours)
          </label>
        </p>
      )}
      <p className="small muted">{journeyDef.hint}</p>
      <button className="btn accent mt" disabled={!valid || busy} onClick={submit}>Create case &amp; run agent</button>
    </div>
  );
}
