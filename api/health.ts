// GET /api/health — liveness + honest capability flags.
// llm: true means a GROQ_API_KEY is configured (Vercel project env var),
// so live Groq mode is available — not that a Groq call has succeeded yet.
// The deterministic engine runs with or without it.
import { GROQ_MODEL, getEnv } from '../src/lib/groq';

export default function handler(_req: any, res: any): void {
  const llmConfigured = Boolean(getEnv('GROQ_API_KEY'));
  res.status(200).json({
    ok: true,
    service: 'att-ai-foundry',
    engine: 'deterministic-ts',
    llm: llmConfigured,
    llmModel: llmConfigured ? GROQ_MODEL : null,
    realAttSystems: false,
    demoData: 'synthetic',
  });
}
