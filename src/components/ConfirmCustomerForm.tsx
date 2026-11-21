// Find & confirm customer — the fixed small form at the top of the
// Dashboard and the Customers view, where every call starts.
//
// "User" here means the OPERATOR using this dashboard, not the AT&T
// customer. The operator finds the customer and can change that
// person's billing / usage / services — so before anything changes we
// must know WHOSE data it is, and verify it from the customer end.
// That is what this form does, following AT&T's current verification
// process: identify by name + phone number, then the 6-digit account
// PIN the customer created; without the PIN, a one-time code goes to
// the registered phone/email — but only after the customer confirms
// the registered email matches the one they use.
//
// Honesty rules for this demo: no PIN is stored for any test customer
// and no real SMS/email is ever sent. Verification is recorded as an
// OPERATOR ATTESTATION (method + timestamp) — the operator confirms
// the customer gave the PIN on the call, or received and read back the
// code. It is never presented as a cryptographic check. Production
// checks the PIN / sends the code through the account verification
// service.
//
// Verification is recorded and shown, NOT enforced yet: actions are
// still allowed unverified (the Customer 360 says so plainly), and
// every action's audit entry carries the verification status, so the
// strict rule can be switched on later. See the TODO in README.md /
// docs/PRD.md ("enforce verified-before-change").
import { useState } from 'react';
import type { Customer } from '../lib/types';
import { matchCustomer, normalizePhone, searchCustomers, type CustomerSearchResult } from '../lib/customer-search';

export type VerificationMethod = 'pin' | 'otp';

/** A confirmed customer for this session: who, how they were verified,
 *  and when. Owned by App (shared by Dashboard + Customers view); the
 *  form only fills it in. */
export interface CustomerConfirmation {
  customerId: string;
  method: VerificationMethod;
  /** ISO timestamp when the operator recorded the verification. */
  at: string;
}

/** The PIN is exactly 6 digits — the account PIN the customer created. */
export function isValidPin(pin: string): boolean {
  return /^\d{6}$/.test(pin.trim());
}

/** OTP gate: the email the customer says they use must match the
 *  registered email on file (case-insensitive, trimmed). A mismatch
 *  means no code is sent — the operator must check the email with the
 *  customer first. */
export function emailsMatch(typedEmail: string, registeredEmail: string): boolean {
  const typed = typedEmail.trim().toLowerCase();
  return typed !== '' && registeredEmail.trim() !== '' && typed === registeredEmail.trim().toLowerCase();
}

export function formatVerifiedAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function verificationLabel(method: VerificationMethod): string {
  return method === 'pin' ? 'PIN' : 'one-time code (OTP)';
}

export default function ConfirmCustomerForm({ customers, confirmed, onConfirm, onClear, onView360, audit }: {
  customers: Customer[];
  confirmed: CustomerConfirmation | null;
  onConfirm: (customer: Customer, method: VerificationMethod) => void;
  onClear: () => void;
  /** Dashboard only: jump to the confirmed customer's Customer 360. */
  onView360?: () => void;
  audit: (actor: 'human', action: string, detail: string) => void;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [account, setAccount] = useState('');
  const [results, setResults] = useState<CustomerSearchResult[] | null>(null);
  const [searched, setSearched] = useState(false);
  const [capped, setCapped] = useState(false);
  const [picked, setPicked] = useState<Customer | null>(null);
  const [method, setMethod] = useState<VerificationMethod>('pin');
  const [pin, setPin] = useState('');
  const [otpEmail, setOtpEmail] = useState('');
  const [emailChecked, setEmailChecked] = useState<boolean | null>(null);
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState('');

  const confirmedCustomer = confirmed ? customers.find((c) => c.id === confirmed.customerId) ?? null : null;

  const resetLocal = () => {
    setResults(null);
    setSearched(false);
    setCapped(false);
    setPicked(null);
    setMethod('pin');
    setPin('');
    setOtpEmail('');
    setEmailChecked(null);
    setOtpSent(false);
    setOtpCode('');
  };

  const runSearch = () => {
    const nameQ = name.trim();
    const phoneQ = phone.trim();
    const accountQ = account.trim();
    // Start from whichever identifier the operator gave, then narrow by
    // the others — name + number is the usual call. The matcher is the
    // same one the Customers view uses (lib/customer-search.ts).
    const first = nameQ || phoneQ || accountQ;
    const outcome = searchCustomers(customers, first);
    let narrowed = outcome.results;
    if (nameQ) narrowed = narrowed.filter((r) => r.customer.name.toLowerCase().includes(nameQ.toLowerCase()));
    const phoneDigits = normalizePhone(phoneQ);
    if (phoneQ && phoneDigits.length >= 3) narrowed = narrowed.filter((r) => normalizePhone(r.customer.phone).includes(phoneDigits));
    if (accountQ) narrowed = narrowed.filter((r) => matchCustomer(r.customer, accountQ).includes('matched account'));
    narrowed = [...narrowed].sort((a, b) => {
      const byName = a.customer.name.localeCompare(b.customer.name, undefined, { sensitivity: 'base' });
      return byName !== 0 ? byName : a.customer.id.localeCompare(b.customer.id);
    });
    setResults(narrowed);
    setCapped(outcome.capped);
    setSearched(true);
    setPicked(null);
    const reasons = [...new Set(narrowed.flatMap((r) => r.reasons))];
    audit('human', 'customer_search', `Find & confirm search submitted: ${narrowed.length} match${narrowed.length === 1 ? '' : 'es'}${reasons.length > 0 ? ` (matched by ${reasons.join(', ')})` : ' (no match)'}.`);
  };

  const confirm = (m: VerificationMethod) => {
    if (!picked) return;
    onConfirm(picked, m);
    resetLocal();
  };

  // ---- Confirmed banner: the customer is set for this session. ----
  if (confirmed && confirmedCustomer) {
    return (
      <div className="panel highlight">
        <div className="row space">
          <div>
            <h2 style={{ margin: 0 }}>Confirmed — {confirmedCustomer.name}</h2>
            <p className="small" style={{ margin: '4px 0 0' }}>
              {confirmedCustomer.account} · {confirmedCustomer.phone} · {confirmedCustomer.plan} ·{' '}
              <strong>Verified via {verificationLabel(confirmed.method)} at {formatVerifiedAt(confirmed.at)}</strong>
            </p>
            <p className="small muted" style={{ margin: '4px 0 0' }}>This is whose billing, usage and services any change below applies to. Verification is recorded for this session — it does not block changes yet (see the Customer 360 status).</p>
          </div>
          <span className="row">
            {onView360 && <button className="btn small" onClick={onView360}>View Customer 360</button>}
            <button className="btn small secondary" onClick={() => { onClear(); resetLocal(); }}>Change customer</button>
          </span>
        </div>
      </div>
    );
  }
  if (confirmed && !confirmedCustomer) {
    return (
      <div className="panel highlight">
        <p className="small">The confirmed customer ({confirmed.customerId}) is no longer in the loaded caseload — the dataset may have changed. Find and confirm a customer again.</p>
        <button className="btn small secondary" onClick={() => { onClear(); resetLocal(); }}>Find a customer</button>
      </div>
    );
  }

  // ---- Step 2: verify the picked customer. ----
  if (picked) {
    const canOtp = picked.email.trim() !== '';
    return (
      <div className="panel highlight">
        <div className="row space">
          <h2 style={{ margin: 0 }}>Verify — {picked.name}</h2>
          <button className="btn small secondary" onClick={() => setPicked(null)}>Back to search</button>
        </div>
        <p className="small muted">{picked.id} · {picked.account} · {picked.phone}{picked.email ? ` · ${picked.email}` : ''} · {picked.plan}</p>
        <p className="small">AT&amp;T's verification, in order: the 6-digit account PIN the customer created. If they don't have it, a one-time code goes to the registered phone/email — but only after the customer confirms the registered email matches the one they use.</p>
        <div className="row">
          <label style={{ display: 'inline', fontSize: '13px' }}>
            <input type="radio" checked={method === 'pin'} onChange={() => setMethod('pin')} style={{ width: 'auto', marginRight: '6px' }} />
            6-digit PIN
          </label>
          <label style={{ display: 'inline', fontSize: '13px' }}>
            <input type="radio" checked={method === 'otp'} onChange={() => setMethod('otp')} style={{ width: 'auto', marginRight: '6px' }} />
            One-time code (OTP)
          </label>
        </div>
        {method === 'pin' ? (
          <div className="mt">
            <label>6-digit account PIN — the customer gives it on the call</label>
            <input type="text" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6 digits" style={{ maxWidth: '160px' }} />
            <p className="small muted">Demo: no PIN is stored for these test customers — the operator confirms the customer gave the PIN on the call. Production checks it against the account verification service.</p>
            <button className="btn accent" disabled={!isValidPin(pin)} onClick={() => confirm('pin')}>Confirm PIN — customer verified</button>
          </div>
        ) : (
          <div className="mt">
            {!canOtp ? (
              <p className="small error">No registered email on file for this customer, so a one-time code cannot be sent. Use the 6-digit PIN, or add an email to the customer record first.</p>
            ) : (
              <>
                <label>Email the customer says they use</label>
                <input type="text" value={otpEmail} onChange={(e) => { setOtpEmail(e.target.value); setEmailChecked(null); setOtpSent(false); setOtpCode(''); }} placeholder="name@example.com" style={{ maxWidth: '320px' }} />
                <div className="row mt">
                  <button className="btn" disabled={otpEmail.trim() === ''} onClick={() => setEmailChecked(emailsMatch(otpEmail, picked.email))}>Check email</button>
                  {emailChecked === true && <span className="small ok">Matches the registered email on file.</span>}
                  {emailChecked === false && <span className="small error">Does not match the registered email on file — no code was sent. Confirm the email with the customer and try again.</span>}
                </div>
                {emailChecked === true && !otpSent && (
                  <>
                    <p className="small muted">The code goes to the registered phone/email only — never to an address the customer just made up.</p>
                    <button className="btn" onClick={() => setOtpSent(true)}>Send one-time code</button>
                  </>
                )}
                {otpSent && (
                  <>
                    <p className="small ok">Code sent (demo — no real SMS/email is sent). Ask the customer to read the code back.</p>
                    <label>Code the customer read back</label>
                    <input type="text" inputMode="numeric" maxLength={6} value={otpCode} onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6 digits" style={{ maxWidth: '160px' }} />
                    <p className="small muted">Demo: no real code is sent — the operator confirms the customer received and read back the code. Production calls the verification service.</p>
                    <button className="btn accent" disabled={!isValidPin(otpCode)} onClick={() => confirm('otp')}>Confirm code — customer verified</button>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  // ---- Step 1: identify the customer. ----
  return (
    <div className="panel highlight">
      <h2>Find &amp; confirm customer — where every call starts</h2>
      <p className="small muted">Search by name, by name + number, by number, account, email or customer ID. Pick the customer, then verify them the way AT&amp;T does — 6-digit PIN, or a one-time code after the registered email is confirmed. Nothing below changes billing, usage or services for the wrong person: the confirmed customer is the context for everything that follows.</p>
      <div className="grid2">
        <div>
          <label>Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Maya Rodriguez" />
        </div>
        <div>
          <label>Phone number</label>
          <input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. (201) 555-0142" />
        </div>
        <div>
          <label>Account number (optional)</label>
          <input type="text" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="e.g. ACC-884120" />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <button className="btn accent" disabled={name.trim() === '' && phone.trim() === '' && account.trim() === ''} onClick={runSearch}>Search</button>
        </div>
      </div>
      {searched && results !== null && (
        <div className="mt">
          <p className="small muted">Showing {results.length} match{results.length === 1 ? '' : 'es'}{capped ? ' — search capped at 50 rows; narrow the search to see more' : ''} (A–Z).</p>
          {results.length === 0 ? (
            <p className="muted">No customers match that search — check the spelling or the number with the customer.</p>
          ) : (
            <div className="table-wrap"><table>
              <thead><tr><th>Customer</th><th>Account</th><th>Plan</th><th>Matched by</th><th></th></tr></thead>
              <tbody>{results.map(({ customer: c, reasons }) => (
                <tr key={c.id}>
                  <td><strong>{c.name}</strong><br /><span className="small muted">{c.city} · since {c.since}</span></td>
                  <td>{c.account}<br /><span className="small muted">{c.phone}</span></td>
                  <td>{c.plan}</td>
                  <td><span className="small muted">{reasons.join(', ')}</span></td>
                  <td><button className="btn small accent" onClick={() => setPicked(c)}>Select &amp; verify</button></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      )}
    </div>
  );
}
