// PII redaction — mirrors server/redact.py.
//
// Demo customer data is synthetic, but logs, traces and audit entries
// are still written PII-aware: phone numbers and email addresses are
// masked before anything is logged, stored in the audit log, emitted as
// an event, or returned from an API. Names and account numbers are
// product data (Customer 360 shows them by design) and are NOT masked;
// phone/email are contact data and never belong in a log line.
//
// Use redactPII() at every log/audit/event sink — never at the display
// layer, where the agent and the reviewer need the real contact details
// to do their job.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** US phone numbers: (201) 555-0142, 201-555-0142, +1 201 555 0142. */
const PHONE_RE = /(\+?1[\s.-]?)?(\(\d{3}\)\s?|\d{3}[\s.-]?)\d{3}[\s.-]?\d{4}/g;

export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const last4 = digits.slice(-4);
  return `(***) ***-${last4}`;
}

export function redactPII(text: string): string {
  if (!text) return text;
  return text
    .replace(EMAIL_RE, (m) => maskEmail(m))
    .replace(PHONE_RE, (m) => maskPhone(m));
}
