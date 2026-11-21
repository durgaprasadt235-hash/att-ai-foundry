"""Pytest unit tests for PII redaction (server/redact.py).

Phone numbers and email addresses are masked in logs, traces, audit
entries and events. Names and account numbers are product data and are
NOT masked.
Run: python3 -m pytest server/test_redact.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from redact import mask_email, mask_phone, redact_pii  # noqa: E402


def test_mask_email_keeps_first_letter_and_domain():
    assert mask_email("maya.rodriguez.demo@example.com") == "m***@example.com"


def test_mask_phone_keeps_last_four():
    assert mask_phone("(201) 555-0142") == "(***) ***-0142"
    assert mask_phone("+1 201-555-0142") == "(***) ***-0142"


def test_redact_pii_masks_both_in_a_sentence():
    text = ("Customer Maya Rodriguez (201) 555-0142 "
            "maya.rodriguez.demo@example.com balance $194.32")
    redacted = redact_pii(text)
    assert "(201) 555-0142" not in redacted
    assert "maya.rodriguez.demo@example.com" not in redacted
    assert "(***) ***-0142" in redacted
    assert "m***@example.com" in redacted
    # Product data survives: name and balance are still readable.
    assert "Maya Rodriguez" in redacted
    assert "$194.32" in redacted


def test_redact_pii_leaves_clean_text_alone():
    assert redact_pii("Duplicate confirmed: INV-2039 + INV-2041, $87.40") == \
        "Duplicate confirmed: INV-2039 + INV-2041, $87.40"
    assert redact_pii("") == ""
