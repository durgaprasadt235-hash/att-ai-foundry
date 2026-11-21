"""Auth boundary — mirrors src/lib/auth.ts.

Clearly-labelled placeholder, DISABLED by default. Production uses AT&T
Entra ID (OAuth 2.0 / OpenID Connect). This module only answers one
question honestly: is the login gate on, and is it actually configured?
It never performs a fake login.

  AUTH_ENABLED=false (default)  → no gate; demo runs open, labelled demo.
  AUTH_ENABLED=true, no config  → "auth not configured"; sign-in refused.
  AUTH_ENABLED=true, configured → gate renders, but the OAuth callback
                                   handler is NOT yet implemented, so
                                   sign-in stays a disabled placeholder.
"""
from __future__ import annotations

from config import AppConfig, load_config


def auth_status(cfg: AppConfig | None = None) -> dict:
    cfg = cfg if cfg is not None else load_config()
    if not cfg.auth_enabled:
        return {
            "enabled": False,
            "configured": False,
            "provider": cfg.auth_provider,
            "missing": [],
            "note": "Login gate is off (demo mode). Production uses AT&T "
                    "Entra ID — enable with AUTH_ENABLED=true once the "
                    "Entra ID app registration exists.",
        }
    missing = []
    if not cfg.auth_client_id:
        missing.append("AUTH_CLIENT_ID")
    if not cfg.auth_issuer_url:
        missing.append("AUTH_ISSUER_URL")
    if missing:
        return {
            "enabled": True,
            "configured": False,
            "provider": cfg.auth_provider,
            "missing": missing,
            "note": "Auth is enabled but NOT configured — missing " +
                    ", ".join(missing) + ". Sign-in is unavailable. This "
                    "is not a login screen: no demo account exists.",
        }
    return {
        "enabled": True,
        "configured": True,
        "provider": cfg.auth_provider,
        "missing": [],
        "note": f"Auth is enabled for {cfg.auth_provider} (AT&T Entra ID "
                "in production). The OAuth callback handler is not yet "
                "implemented — sign-in is a placeholder until the "
                "fulfilment team wires it (docs/DEPLOYMENT.md step 4).",
    }
