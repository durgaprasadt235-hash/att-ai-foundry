// GET /api/health — liveness + honest capability flags.
// This demo has no LLM and no real AT&T systems; the flags say so.
export default function handler(_req: any, res: any): void {
  res.status(200).json({
    ok: true,
    service: 'att-ai-foundry',
    engine: 'deterministic-ts',
    llm: false,
    realAttSystems: false,
    demoData: 'synthetic',
  });
}
