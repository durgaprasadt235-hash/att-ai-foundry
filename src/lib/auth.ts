// Auth boundary — clearly-labelled placeholder, DISABLED by default.
//
// Production uses AT&T Entra ID (OAuth 2.0 / OpenID Connect). This file
// only answers one question honestly: is the login gate on, and is it
// actually configured? It never performs a fake login.
//
//   AUTH_ENABLED=false (default)  → no gate. The demo runs open, labelled
//                                   as a demo with synthetic data.
//   AUTH_ENABLED=true, no config  → the app shows "auth not configured"
//                                   and refuses sign-in. Never a fake
//                                   login button, never a demo account.
//   AUTH_ENABLED=true, configured → the gate renders a sign-in panel for
//                                   the configured IdP. The OAuth callback
//                                   handler is NOT yet implemented (see
//                                   docs/DEPLOYMENT.md step 4), so the
//                                   button is disabled and says so — the
//                                   gate is a placeholder, not a login.
//
// Config comes from config.ts (AUTH_ENABLED, AUTH_PROVIDER,
// AUTH_CLIENT_ID, AUTH_ISSUER_URL). The browser build has no env vars, so
// the frontend reads the live auth status from /api/health.
import { loadConfig } from './config';

export interface AuthStatus {
  enabled: boolean;
  configured: boolean;
  /** IdP flavour. Production: "entra-id" (AT&T Entra ID). */
  provider: string;
  /** Which required vars are still missing (empty when configured). */
  missing: string[];
  /** Human-readable state, safe to render in the UI. */
  note: string;
}

export function getAuthStatus(): AuthStatus {
  const cfg = loadConfig();
  if (!cfg.authEnabled) {
    return {
      enabled: false,
      configured: false,
      provider: cfg.authProvider,
      missing: [],
      note: 'Login gate is off (demo mode). Production uses AT&T Entra ID — enable with AUTH_ENABLED=true once the Entra ID app registration exists.',
    };
  }
  const missing: string[] = [];
  if (!cfg.authClientId) missing.push('AUTH_CLIENT_ID');
  if (!cfg.authIssuerUrl) missing.push('AUTH_ISSUER_URL');
  if (missing.length > 0) {
    return {
      enabled: true,
      configured: false,
      provider: cfg.authProvider,
      missing,
      note: `Auth is enabled but NOT configured — missing ${missing.join(', ')}. Sign-in is unavailable. This is not a login screen: no demo account exists.`,
    };
  }
  return {
    enabled: true,
    configured: true,
    provider: cfg.authProvider,
    missing: [],
    note: `Auth is enabled for ${cfg.authProvider} (AT&T Entra ID in production). The OAuth callback handler is not yet implemented — sign-in is a placeholder until the fulfilment team wires it (docs/DEPLOYMENT.md step 4).`,
  };
}

/** Staff accountability — the operator id stamped on every audit entry.
 *
 *  The id answers "which login did this?" for backend investigation:
 *  every search, customer view, case create, agent run, approval,
 *  rejection, deletion and pipeline/medallion run is written to the
 *  append-only audit log tagged with this id, so any change to a
 *  customer or data can be traced to the login that made it.
 *
 *  - Demo mode (auth off, the default): a single labelled id,
 *    "demo-operator". It is a role label, never a real person's identity.
 *  - Auth enabled but not configured: "unconfigured-operator" — no
 *    sign-in exists, so no real login can be claimed.
 *  - Auth enabled and configured: the OAuth callback is NOT yet
 *    implemented, so no real login exists yet either; the placeholder
 *    "entra-id:pending-signin" says so. In production this resolves to
 *    the signed-in operator's Entra ID subject (the `sub` claim from
 *    the ID token) once the fulfilment team wires the callback
 *    (docs/DEPLOYMENT.md step 4). Never invent a person's name or
 *    employee id here.
 *
 *  The operator id is BACKEND ONLY: it is stored on the audit record
 *  and never rendered on any customer-facing screen. */
export function getCurrentOperatorId(): string {
  const status = getAuthStatus();
  if (!status.enabled) return 'demo-operator';
  if (!status.configured) return 'unconfigured-operator';
  return 'entra-id:pending-signin';
}
