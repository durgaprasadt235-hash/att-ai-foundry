// GET /api/health — liveness + honest capability flags.
//
// Honesty rules (fixed in Phase 2 — the old version reported `llm: true`
// merely because a key was configured):
//   llm_configured — a GROQ_API_KEY is set.
//   llm_live       — a live Groq call (GET /models probe) succeeded in
//                    the last 60s. True ONLY on a real 200 from Groq; a
//                    revoked/expired/rate-limited key reports false.
//   llm            — kept for backwards compatibility; equals llm_live.
//   datasource     — mode from DATASOURCE (default `seed`) plus status:
//                    seed = synthetic demo data; att = live adapter, and
//                    `configured` says whether its vars are present (the
//                    probe of the real API happens on first data load, and
//                    a failure there is reported honestly, never faked).
//   db             — the demo has no live database: state lives in the
//                    browser (localStorage) + the seed file. DATABASE_URL
//                    is reserved; `configured` only says the var is set.
//   auth           — the login gate state (see src/lib/auth.ts).
//   realAttSystems — true only in `att` datasource mode.
import { GROQ_MODEL, getEnv, groqCircuitState, probeGroqLive } from '../src/lib/groq';
import { configPresence, loadConfig } from '../src/lib/config';
import { getAuthStatus } from '../src/lib/auth';
import { enforceRateLimit, jsonError } from '../src/lib/api-utils';

/** Cache the Groq probe for 60s so health stays fast and does not hammer
 *  Groq on every page load. A cached `false` is still honest — it means
 *  the last real probe failed. */
let probeCache: { at: number; live: boolean } | null = null;
const PROBE_CACHE_MS = 60_000;

async function llmLive(): Promise<boolean> {
  const key = getEnv('GROQ_API_KEY');
  if (!key) return false;
  const now = Date.now();
  if (probeCache && now - probeCache.at < PROBE_CACHE_MS) return probeCache.live;
  const live = await probeGroqLive(key);
  probeCache = { at: now, live };
  return live;
}

export default async function handler(req: any, res: any): Promise<void> {
  try {
    if (req.method !== 'GET') { jsonError(res, 405, 'Method not allowed. Use GET.'); return; }
    if (!enforceRateLimit(req, res)) return;
    const cfg = loadConfig();
    const presence = configPresence(cfg);
    const auth = getAuthStatus();
    const live = await llmLive();
    const attConfigured = Boolean(cfg.attApiBaseUrl && cfg.attApiKey);
    res.status(200).json({
      ok: true,
      service: 'att-ai-foundry',
      engine: 'deterministic-ts',
      llm: live,
      llm_configured: presence.groqApiKey,
      llm_live: live,
      llm_circuit: groqCircuitState(),
      llmModel: live ? GROQ_MODEL : null,
      datasource: {
        mode: cfg.datasource,
        status: cfg.datasource === 'seed' ? 'seed' : attConfigured ? 'configured' : 'not_configured',
        detail: cfg.datasource === 'seed'
          ? 'Synthetic demo data (seed). Set DATASOURCE=att with ATT_API_BASE_URL + ATT_API_KEY for the live AT&T adapter.'
          : attConfigured
            ? 'Live AT&T adapter configured. Data loads fail honestly if the AT&T API is unreachable — never falls back to seed.'
            : 'att mode selected but ATT_API_BASE_URL / ATT_API_KEY are missing. Data loads will fail honestly until they are set.',
      },
      db: {
        mode: presence.databaseUrl ? 'postgres_configured' : 'seed',
        configured: presence.databaseUrl,
        detail: presence.databaseUrl
          ? 'DATABASE_URL is set, but no live database is wired yet — the demo still uses seed/browser state. See docs/DEPLOYMENT.md.'
          : 'No live database. Demo state lives in the browser (localStorage) and the seed file.',
      },
      auth,
      realAttSystems: cfg.datasource === 'att',
      demoData: cfg.datasource === 'seed' ? 'synthetic' : 'live-att',
    });
  } catch (e) {
    // Never a 500 HTML page and never an uncaught throw.
    jsonError(res, 500, 'Health check failed', e instanceof Error ? e.message : String(e));
  }
}
