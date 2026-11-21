"""PII redaction — mirrors src/lib/redact.ts.

Demo customer data is synthetic, but logs, traces and audit entries
are still written PII-aware: phone numbers and email addresses are
masked before anything is logged, stored in the audit log, emitted as
an event, or returned from an API. Names and account numbers are
product data (Customer 360 shows them by design) and are NOT masked.
"""
from __future__ import annotations

import re

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_PHONE_RE = re.compile(r"(\+?1[\s.-]?)?(\(\d{3}\)\s?|\d{3}[\s.-]?)\d{3}[\s.-]?\d{4}")


def mask_email(email: str) -> str:
    at = email.find("@")
    if at <= 0:
        return "***"
    return f"{email[0]}***{email[at:]}"


def mask_phone(phone: str) -> str:
    digits = re.sub(r"\D", "", phone)
    return f"(***) ***-{digits[-4:]}"


def redact_pii(text: str) -> str:
    if not text:
        return text
    text = _EMAIL_RE.sub(lambda m: mask_email(m.group(0)), text)
    text = _PHONE_RE.sub(lambda m: mask_phone(m.group(0)), text)
    return text
