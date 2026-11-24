// Customer lookup — the "Find customer" search.
//
// This is where a real carrier call starts: the agent's first step is
// Customer 360 (see engine.customer360, the RETRIEVE_360 step), and
// before that someone has to find the account. Today a carrier finds it
// from the calling phone number first (dialling 611 from a carrier phone
// identifies the line before the agent speaks), otherwise from the
// account number (top-right of the bill), or from name + address +
// phone, verified with the 6-digit account PIN the customer created; without it, a one-time code is sent to the registered phone/email only after the customer confirms the registered email matches.
//
// The matcher below mirrors that: one box, matched across name (partial,
// case-insensitive), phone (digits only — "2015550142", "(201) 555-0142"
// and "555-0142" all match the same line), account number (ACC-...),
// email, and customer ID (CUST-...). Every result carries its match
// reason, so the operator can see WHY this row came back.
//
// It searches whatever is in state — the built-in seed or an uploaded
// dataset — never a hardcoded list. Results are capped at 50 rows
// (the 1,000-record test showed uncapped lists are unusable); the
// caller is told the total so the cap is never silent.
import type { Customer } from './types';

/** Max rows returned in one search. The total is always reported. */
export const SEARCH_RESULT_LIMIT = 50;

export interface CustomerSearchResult {
  customer: Customer;
  /** e.g. ["matched phone", "matched name"] — why this row came back. */
  reasons: string[];
}

export interface CustomerSearchOutcome {
  results: CustomerSearchResult[];
  /** Total matches before the cap. */
  total: number;
  capped: boolean;
}

/** Digits only — "(201) 555-0142" and "2015550142" become the same key. */
export function normalizePhone(value: string): string {
  return value.replace(/\D/g, '');
}

function includes(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Match one customer against a query. Returns the match reasons, or an
 * empty array when there is no match. An empty query matches everything
 * (the list view), so callers show the capped caseload.
 */
export function matchCustomer(customer: Customer, query: string): string[] {
  const q = query.trim();
  if (q === '') return ['all customers'];
  const reasons: string[] = [];
  if (includes(customer.name, q)) reasons.push('matched name');
  if (customer.email && includes(customer.email, q)) reasons.push('matched email');
  if (includes(customer.account, q)) reasons.push('matched account');
  if (includes(customer.id, q)) reasons.push('matched customer ID');
  const qDigits = normalizePhone(q);
  if (qDigits.length >= 3) {
    const phoneDigits = normalizePhone(customer.phone);
    if (phoneDigits !== '' && phoneDigits.includes(qDigits)) reasons.push('matched phone');
    // A bare account-number fragment ("884120") also matches the account.
    if (normalizePhone(customer.account).includes(qDigits) && !reasons.includes('matched account')) {
      reasons.push('matched account');
    }
  }
  return reasons;
}

/** Sort customers by name A–Z (case-insensitive, tie-break by customer
 *  id). Every load path sorts — seed, upload, cleanse — so no view ever
 *  sees file order, and no customer is ever "first" by accident. Ids,
 *  casing and every other field are untouched. */
export function compareCustomersByName(a: Customer, b: Customer): number {
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return byName !== 0 ? byName : a.id.localeCompare(b.id);
}

export function sortCustomersByName(customers: Customer[]): Customer[] {
  return [...customers].sort(compareCustomersByName);
}

/** Search the loaded caseload (seed or uploaded dataset) by any identifier. Results are A–Z. */
export function searchCustomers(customers: Customer[], query: string): CustomerSearchOutcome {
  const matches: CustomerSearchResult[] = [];
  for (const customer of customers) {
    const reasons = matchCustomer(customer, query);
    if (reasons.length > 0) matches.push({ customer, reasons });
  }
  const total = matches.length;
  const capped = total > SEARCH_RESULT_LIMIT;
  matches.sort((x, y) => compareCustomersByName(x.customer, y.customer));
  return { results: matches.slice(0, SEARCH_RESULT_LIMIT), total, capped };
}
