"""Single config surface — mirrors src/lib/config.ts.

Every secret and mode flag comes from environment variables, read here
and nowhere else. No secret is ever in code, in git, or in a request body.

Required vs optional (demo mode needs NOTHING — it runs on the synthetic
seed + deterministic engine):
  GROQ_API_KEY      optional — required only for live-LLM mode.
  ATT_API_BASE_URL  optional — required only in `att` datasource mode.
  ATT_API_KEY       optional — required only in `att` datasource mode.
  DATABASE_URL      optional — reserved for the future Postgres-backed
                    store. Nothing reads it yet.
  DATASOURCE        optional, default `seed` (`seed` | `att`).
  AUTH_ENABLED      optional, default `false`. Production uses Entra ID.
  AUTH_PROVIDER / AUTH_CLIENT_ID / AUTH_ISSUER_URL
                    optional — required only when AUTH_ENABLED=true.

Startup fails loudly: validate_config() lists every missing REQUIRED var
for the selected mode, and require_config() raises ConfigError instead of
letting the server run half-configured.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigError(Exception):
    """A REQUIRED environment variable is missing for the selected mode."""


@dataclass(frozen=True)
class AppConfig:
    groq_api_key: str = ""
    att_api_base_url: str = ""
    att_api_key: str = ""
    database_url: str = ""
    datasource: str = "seed"  # "seed" | "att"
    datasource_raw: str = "seed"
    auth_enabled: bool = False
    auth_provider: str = "entra-id"
    auth_client_id: str = ""
    auth_issuer_url: str = ""


def load_config(env: dict | None = None) -> AppConfig:
    """Read config from the environment (or a supplied mapping, for tests)."""
    source = os.environ if env is None else env

    def get(name: str) -> str:
        value = source.get(name, "")
        return value.strip() if isinstance(value, str) else ""

    raw = (get("DATASOURCE") or "seed").lower()
    datasource = "att" if raw == "att" else "seed"
    return AppConfig(
        groq_api_key=get("GROQ_API_KEY"),
        att_api_base_url=get("ATT_API_BASE_URL"),
        att_api_key=get("ATT_API_KEY"),
        database_url=get("DATABASE_URL"),
        datasource=datasource,
        datasource_raw=raw,
        auth_enabled=(get("AUTH_ENABLED") or "false").lower() == "true",
        auth_provider=get("AUTH_PROVIDER") or "entra-id",
        auth_client_id=get("AUTH_CLIENT_ID"),
        auth_issuer_url=get("AUTH_ISSUER_URL"),
    )


def validate_config(cfg: AppConfig) -> list[str]:
    """Missing REQUIRED variables for the selected mode. Empty = may start."""
    missing: list[str] = []
    if cfg.datasource_raw not in ("seed", "att"):
        missing.append(
            f'DATASOURCE="{cfg.datasource_raw}" is not a known mode '
            '(use "seed" or "att")'
        )
    if cfg.datasource == "att":
        if not cfg.att_api_base_url:
            missing.append("ATT_API_BASE_URL is required in att datasource mode")
        if not cfg.att_api_key:
            missing.append("ATT_API_KEY is required in att datasource mode")
    if cfg.auth_enabled:
        if not cfg.auth_client_id:
            missing.append("AUTH_CLIENT_ID is required when AUTH_ENABLED=true")
        if not cfg.auth_issuer_url:
            missing.append("AUTH_ISSUER_URL is required when AUTH_ENABLED=true")
    return missing


def require_config(cfg: AppConfig | None = None) -> AppConfig:
    """Load config and fail loudly if a REQUIRED var is missing."""
    cfg = cfg if cfg is not None else load_config()
    missing = validate_config(cfg)
    if missing:
        raise ConfigError(
            "Configuration error — cannot start: " + "; ".join(missing) +
            ". See .env.example and docs/DEPLOYMENT.md."
        )
    return cfg


def config_presence(cfg: AppConfig) -> dict:
    """Presence flags only — never values. Safe to return from /health."""
    return {
        "groqApiKey": bool(cfg.groq_api_key),
        "attApiBaseUrl": bool(cfg.att_api_base_url),
        "attApiKey": bool(cfg.att_api_key),
        "databaseUrl": bool(cfg.database_url),
        "datasource": cfg.datasource,
        "authEnabled": cfg.auth_enabled,
        "authProvider": cfg.auth_provider,
        "authConfigured": bool(cfg.auth_client_id and cfg.auth_issuer_url),
    }
