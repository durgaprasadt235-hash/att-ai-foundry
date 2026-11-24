// Single config surface — every secret and mode flag in this prototype
// comes from environment variables, read here and nowhere else. No secret
// is ever in code, in git, or in a request body.
//
// Required vs optional (demo mode needs NOTHING — it runs on the synthetic
// seed + deterministic engine):
//   GROQ_API_KEY      optional — required only for live-LLM mode. Groq
//                     Console (console.groq.com), free tier, no card.
//   ATT_API_BASE_URL  optional — required only in `att` datasource mode.
//                     From the the carrier's fulfilment team (CRM/billing/usage API).
//   ATT_API_KEY       optional — required only in `att` datasource mode.
//                     Bearer token from the fulfilment team. Rotate it
//                     like any service credential; never commit it.
//   DATABASE_URL      optional — reserved for the future Postgres-backed
//                     store. Nothing reads it yet; the demo stores state in
//                     the browser (localStorage) and the seed file.
//   DATASOURCE        optional, default `seed`. `seed` = synthetic demo
//                     data; `att` = live carrier adapter (see datasource.ts).
//   AUTH_ENABLED      optional, default `false`. `true` turns on the login
//                     gate (see auth.ts). Production uses Entra ID.
//   AUTH_PROVIDER / AUTH_CLIENT_ID / AUTH_ISSUER_URL
//                     optional — required only when AUTH_ENABLED=true.
//                     The Entra ID app registration from the fulfilment team.
//
// Startup fails loudly: validateConfig() lists every missing REQUIRED var
// for the selected mode, and the server refuses to start (or the API
// returns an honest 503) instead of running with a half-configured mode.
// Demo mode (`seed`, auth off, no keys) always validates clean.
import { getEnv } from './groq';

export type DatasourceMode = 'seed' | 'att';

export interface AppConfig {
  groqApiKey: string;
  attApiBaseUrl: string;
  attApiKey: string;
  databaseUrl: string;
  datasource: DatasourceMode;
  /** Raw DATASOURCE value, so an unknown value can be reported honestly
   *  instead of silently treated as `seed`. */
  datasourceRaw: string;
  authEnabled: boolean;
  authProvider: string;
  authClientId: string;
  authIssuerUrl: string;
}

export function loadConfig(): AppConfig {
  const raw = (getEnv('DATASOURCE') || 'seed').trim().toLowerCase();
  const datasource: DatasourceMode = raw === 'att' ? 'att' : 'seed';
  return {
    groqApiKey: getEnv('GROQ_API_KEY'),
    attApiBaseUrl: getEnv('ATT_API_BASE_URL'),
    attApiKey: getEnv('ATT_API_KEY'),
    databaseUrl: getEnv('DATABASE_URL'),
    datasource,
    datasourceRaw: raw,
    authEnabled: (getEnv('AUTH_ENABLED') || 'false').trim().toLowerCase() === 'true',
    authProvider: getEnv('AUTH_PROVIDER') || 'entra-id',
    authClientId: getEnv('AUTH_CLIENT_ID'),
    authIssuerUrl: getEnv('AUTH_ISSUER_URL'),
  };
}

/** Missing REQUIRED variables for the selected mode. Empty = the app may
 *  start. Demo mode requires nothing; `att` mode requires the carrier
 *  connection; auth-on requires the IdP registration. */
export function validateConfig(cfg: AppConfig): string[] {
  const missing: string[] = [];
  if (!['seed', 'att'].includes(cfg.datasourceRaw)) {
    missing.push(`DATASOURCE=${JSON.stringify(cfg.datasourceRaw)} is not a known mode (use "seed" or "att")`);
  }
  if (cfg.datasource === 'att') {
    if (!cfg.attApiBaseUrl) missing.push('ATT_API_BASE_URL is required in att datasource mode');
    if (!cfg.attApiKey) missing.push('ATT_API_KEY is required in att datasource mode');
  }
  if (cfg.authEnabled) {
    if (!cfg.authClientId) missing.push('AUTH_CLIENT_ID is required when AUTH_ENABLED=true');
    if (!cfg.authIssuerUrl) missing.push('AUTH_ISSUER_URL is required when AUTH_ENABLED=true');
  }
  return missing;
}

/** Fail loudly at startup (or before serving an `att`-mode request) with
 *  one clear message naming every missing required variable. */
export function assertRequiredConfig(cfg: AppConfig): void {
  const missing = validateConfig(cfg);
  if (missing.length > 0) {
    throw new Error(`Configuration error — cannot start: ${missing.join('; ')}. See .env.example and docs/DEPLOYMENT.md.`);
  }
}

/** Presence flags only — never values. Safe to return from /api/health
 *  and to show in the Production readiness panel. */
export function configPresence(cfg: AppConfig): {
  groqApiKey: boolean;
  attApiBaseUrl: boolean;
  attApiKey: boolean;
  databaseUrl: boolean;
  datasource: DatasourceMode;
  authEnabled: boolean;
  authProvider: string;
  authConfigured: boolean;
} {
  return {
    groqApiKey: Boolean(cfg.groqApiKey),
    attApiBaseUrl: Boolean(cfg.attApiBaseUrl),
    attApiKey: Boolean(cfg.attApiKey),
    databaseUrl: Boolean(cfg.databaseUrl),
    datasource: cfg.datasource,
    authEnabled: cfg.authEnabled,
    authProvider: cfg.authProvider,
    authConfigured: Boolean(cfg.authClientId && cfg.authIssuerUrl),
  };
}
