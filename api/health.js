// api-src/health.ts
async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed. Use GET." });
      return;
    }
    const key = globalThis.process?.env?.GROQ_API_KEY ?? "";
    res.status(200).json({
      ok: true,
      service: "att-ai-foundry",
      engine: "deterministic-ts",
      llm: false,
      llm_configured: Boolean(key),
      llm_live: false,
      llm_circuit: "closed",
      datasource: {
        mode: "seed",
        status: "seed",
        detail: "Synthetic demo data (seed). Set DATASOURCE=att with ATT_API_BASE_URL + ATT_API_KEY for the live carrier adapter."
      },
      db: { mode: "seed", configured: false, detail: "No live database. Demo state lives in the browser (localStorage) and the seed file." },
      auth: { enabled: false, configured: false, provider: "entra-id", missing: [], note: "Login gate is off (demo mode). Production uses Entra ID." },
      realAttSystems: false,
      demoData: "synthetic",
      note: "Self-contained health handler (no shared imports) \u2014 diagnostic build to isolate the Vercel function crash."
    });
  } catch (e) {
    res.status(500).json({ error: "Health check failed", reason: e instanceof Error ? e.message : String(e) });
  }
}
export {
  handler as default
};
