// Find & confirm customer — the fixed small form at the top of the
// Dashboard and the Customers view, where every call starts.
//
// "User" here means the OPERATOR using this dashboard, not the AT&T
// customer. The operator finds the customer and can change that
// person's billing / usage / services — so before anything changes we
// must know WHOSE data it is, and verify it from the customer end.
// That is what this form does, following AT&T's current verification
// process: identify by name, phone, account, email or ID, then the
// 6-digit account PIN the customer created; without the PIN, a
// one-time code goes to the registered phone/email — but only after
// the customer confirms the registered email matches the one they use.
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
import { searchCustomers, type CustomerSearchResult } from '../lib/customer-search';

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
  const [query, setQuery] = useState('');
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
    // One box, every identifier: the matcher handles name, phone
    // (digits only), account, email and customer ID (see
    // lib/customer-search.ts) — name + number narrows the same way.
    const outcome = searchCustomers(customers, query.trim());
    setResults(outcome.results);
    setCapped(outcome.capped);
    setSearched(true);
    setPicked(null);
    const reasons = [...new Set(outcome.results.flatMap((r) => r.reasons))];
    audit('human', 'customer_search', `Find & confirm search submitted: ${outcome.results.length} match${outcome.results.length === 1 ? '' : 'es'}${reasons.length > 0 ? ` (matched by ${reasons.join(', ')})` : ' (no match)'}.`);
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
          <span className="small"><strong>Confirmed — {confirmedCustomer.name}</strong> · {confirmedCustomer.account} · {confirmedCustomer.phone} · {confirmedCustomer.plan} · Verified via {verificationLabel(confirmed.method)} at {formatVerifiedAt(confirmed.at)}</span>
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
        <p className="small">The confirmed customer ({confirmed.customerId}) is no longer in the loaded caseload — find and confirm a customer again.</p>
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
          <span><strong>Verify — {picked.name}</strong> <span className="small muted">{picked.id} · {picked.account} · {picked.phone}{picked.email ? ` · ${picked.email}` : ''} · {picked.plan}</span></span>
          <button className="btn small secondary" onClick={() => setPicked(null)}>Back to search</button>
        </div>
        <p className="small muted">6-digit account PIN first; without it, a one-time code to the registered phone/email — only after the customer confirms the registered email matches.</p>
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
          <div className="row mt">
            <input type="text" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6-digit PIN from the call" style={{ maxWidth: '200px' }} />
            <button className="btn accent" disabled={!isValidPin(pin)} onClick={() => confirm('pin')}>Confirm PIN — verified</button>
            <span className="small muted">Demo: no PIN is stored — the operator confirms the customer gave it on the call.</span>
          </div>
        ) : (
          <div className="mt">
            {!canOtp ? (
              <p className="small error">No registered email on file, so no code can be sent. Use the 6-digit PIN, or add an email to the customer record first.</p>
            ) : (
              <>
                <div className="row">
                  <input type="text" value={otpEmail} onChange={(e) => { setOtpEmail(e.target.value); setEmailChecked(null); setOtpSent(false); setOtpCode(''); }} placeholder="Email the customer says they use" style={{ maxWidth: '280px' }} />
                  <button className="btn" disabled={otpEmail.trim() === ''} onClick={() => setEmailChecked(emailsMatch(otpEmail, picked.email))}>Check email</button>
                  {emailChecked === true && <span className="small ok">Matches the registered email.</span>}
                  {emailChecked === false && <span className="small error">Does not match — no code was sent.</span>}
                </div>
                {emailChecked === true && !otpSent && (
                  <div className="row mt">
                    <button className="btn" onClick={() => setOtpSent(true)}>Send one-time code</button>
                    <span className="small muted">Goes to the registered phone/email only.</span>
                  </div>
                )}
                {otpSent && (
                  <>
                    <div className="row mt">
                      <input type="text" inputMode="numeric" maxLength={6} value={otpCode} onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="Code the customer read back" style={{ maxWidth: '200px' }} />
                      <button className="btn accent" disabled={!isValidPin(otpCode)} onClick={() => confirm('otp')}>Confirm code — verified</button>
                    </div>
                    <p className="small muted">Demo: no real code is sent — the operator confirms the customer received and read it back.</p>
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
      <h2>Find &amp; confirm customer</h2>
      <p className="small muted">Search, pick the customer, then verify with the 6-digit PIN, or a one-time code after the registered email is confirmed.</p>
      <div className="row">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && query.trim() !== '') runSearch(); }}
          placeholder="Name, phone, account, email or ID"
          style={{ flex: 1 }}
        />
        <button className="btn accent" disabled={query.trim() === ''} onClick={runSearch}>Search</button>
      </div>
      {searched && results !== null && (
        <div className="mt">
          <p className="small muted">Showing {results.length} match{results.length === 1 ? '' : 'es'}{capped ? ' — capped at 50 rows; narrow the search to see more' : ''} (A–Z).</p>
          {results.length === 0 ? (
            <p className="muted">No customers match — check the spelling or the number with the customer.</p>
          ) : (
            results.map(({ customer: c, reasons }) => (
              <div key={c.id} className="row space" style={{ padding: '5px 0', borderBottom: '1px solid var(--line)' }}>
                <span className="small"><strong>{c.name}</strong> · {c.account} · {c.phone} · {c.plan} <span className="muted">({reasons.join(', ')})</span></span>
                <button className="btn small accent" onClick={() => setPicked(c)}>Select &amp; verify</button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
