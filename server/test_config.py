"""Pytest unit tests for the single config surface (server/config.py).

Demo mode needs NOTHING; `att` mode and auth-on each require their own
vars; an unknown DATASOURCE value fails loudly instead of silently
becoming `seed`. Presence flags never leak a secret value.
Run: python3 -m pytest server/test_config.py -v
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import pytest  # noqa: E402

from config import (  # noqa: E402
    ConfigError,
    config_presence,
    load_config,
    require_config,
    validate_config,
)


def test_demo_mode_needs_nothing():
    cfg = load_config({})
    assert cfg.datasource == "seed"
    assert cfg.auth_enabled is False
    assert validate_config(cfg) == []
    assert require_config(cfg) is cfg


def test_att_mode_requires_base_url_and_key():
    missing = validate_config(load_config({"DATASOURCE": "att"}))
    assert "ATT_API_BASE_URL is required in att datasource mode" in missing
    assert "ATT_API_KEY is required in att datasource mode" in missing
    assert validate_config(load_config({
        "DATASOURCE": "att",
        "ATT_API_BASE_URL": "https://api.example.invalid/v1",
        "ATT_API_KEY": "att-secret",
    })) == []


def test_unknown_datasource_fails_loudly():
    cfg = load_config({"DATASOURCE": "bogus"})
    missing = validate_config(cfg)
    assert any("DATASOURCE" in m and "bogus" in m for m in missing)
    with pytest.raises(ConfigError, match="bogus"):
        require_config(cfg)


def test_auth_on_requires_client_and_issuer():
    missing = validate_config(load_config({"AUTH_ENABLED": "true"}))
    assert "AUTH_CLIENT_ID is required when AUTH_ENABLED=true" in missing
    assert "AUTH_ISSUER_URL is required when AUTH_ENABLED=true" in missing
    assert validate_config(load_config({
        "AUTH_ENABLED": "true",
        "AUTH_CLIENT_ID": "client-123",
        "AUTH_ISSUER_URL": "https://login.microsoftonline.com/tenant/v2.0",
    })) == []


def test_auth_flag_parsing():
    assert load_config({"AUTH_ENABLED": "True"}).auth_enabled is True
    assert load_config({"AUTH_ENABLED": "1"}).auth_enabled is False
    assert load_config({}).auth_provider == "entra-id"


def test_presence_flags_never_leak_values():
    cfg = load_config({
        "GROQ_API_KEY": "gsk-very-secret",
        "ATT_API_KEY": "att-very-secret",
        "DATABASE_URL": "postgres://user:pass@host/db",
    })
    presence = config_presence(cfg)
    assert presence["groqApiKey"] is True
    assert presence["attApiKey"] is True
    assert presence["databaseUrl"] is True
    assert "gsk-very-secret" not in json.dumps(presence)
    assert "att-very-secret" not in json.dumps(presence)
    assert "postgres://user:pass@host/db" not in json.dumps(presence)


def test_require_config_raises_with_clear_message():
    with pytest.raises(ConfigError) as exc:
        require_config(load_config({"DATASOURCE": "att"}))
    assert "ATT_API_BASE_URL" in str(exc.value)
    assert "DEPLOYMENT.md" in str(exc.value)
