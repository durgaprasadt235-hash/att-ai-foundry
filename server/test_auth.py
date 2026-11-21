"""Pytest unit tests for the auth boundary (server/auth.py).

The gate is DISABLED by default; enabled without config it reports
"auth not configured" and never a fake login; enabled with config it is
a clearly-labelled placeholder (production: AT&T Entra ID).
Run: python3 -m pytest server/test_auth.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from auth import auth_status  # noqa: E402
from config import load_config  # noqa: E402


def test_auth_disabled_by_default():
    status = auth_status(load_config({}))
    assert status["enabled"] is False
    assert status["configured"] is False
    assert status["missing"] == []
    assert "Entra ID" in status["note"]


def test_auth_enabled_without_config_is_honest():
    status = auth_status(load_config({"AUTH_ENABLED": "true"}))
    assert status["enabled"] is True
    assert status["configured"] is False
    assert status["missing"] == ["AUTH_CLIENT_ID", "AUTH_ISSUER_URL"]
    assert "NOT configured" in status["note"]
    assert "no demo account" in status["note"].lower()


def test_auth_enabled_with_config_is_placeholder():
    status = auth_status(load_config({
        "AUTH_ENABLED": "true",
        "AUTH_CLIENT_ID": "client-123",
        "AUTH_ISSUER_URL": "https://login.microsoftonline.com/tenant/v2.0",
    }))
    assert status["enabled"] is True
    assert status["configured"] is True
    assert status["provider"] == "entra-id"
    assert "placeholder" in status["note"]
    assert "callback" in status["note"]


def test_partial_auth_config_names_only_what_is_missing():
    status = auth_status(load_config({
        "AUTH_ENABLED": "true",
        "AUTH_CLIENT_ID": "client-123",
    }))
    assert status["missing"] == ["AUTH_ISSUER_URL"]
