// GET /api/health — liveness + honest capability flags.
//
// Self-contained on purpose: zero imports from src/lib. The previous
// version imported the shared config/groq/auth modules and Vercel kept
// returning FUNCTION_INVOCATION_FAILED for every /api/* endpoint, so this
// handler proves whether the import chain is the problem. If this returns
// 200, the shared modules are reintroduced one at a time.
//
// Honest flags (seed/demo mode — no key is set in Vercel yet):
//   llm / llm_live: false (no GROQ_API_KEY in Vercel yet; a live probe
//     only ever returns true after a real 200 from Groq).
//   datasource: seed = synthetic demo data.
export default async function handler(req: any, res: any): Promise<void> {
  try {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed. Use GET.' });
      return;
    }
    const key = (globalThis as any).process?.env?.GROQ_API_KEY ?? '';
    res.status(200).json({
      ok: true,
      service: 'att-ai-foundry',
      engine: 'deterministic-ts',
      llm: false,
      llm_configured: Boolean(key),
      llm_live: false,
      llm_circuit: 'closed',
      datasource: {
        mode: 'seed',
        status: 'seed',
        detail: 'Synthetic demo data (seed). Set DATASOURCE=att with ATT_API_BASE_URL + ATT_API_KEY for the live AT&T adapter.',
      },
      db: { mode: 'seed', configured: false, detail: 'No live database. Demo state lives in the browser (localStorage) and the seed file.' },
      auth: { enabled: false, configured: false, provider: 'entra-id', missing: [], note: 'Login gate is off (demo mode). Production uses AT&T Entra ID.' },
      realAttSystems: false,
      demoData: 'synthetic',
      note: 'Self-contained health handler (no shared imports) — diagnostic build to isolate the Vercel function crash.',
    });
  } catch (e) {
    res.status(500).json({ error: 'Health check failed', reason: e instanceof Error ? e.message : String(e) });
  }
}
