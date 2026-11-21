// POST /api/stair — STAIR retrieval over the caller's knowledge trees.
// Body: { query, trees, live_llm? }. No chunking, no embeddings. The leaf
// section is returned intact with its full section path, or "not found in policy".
//
// live_llm: when the caller passes live_llm: true AND GROQ_API_KEY is set
// (Vercel project env var — never in code, never in git), Groq
// (openai/gpt-oss-120b) picks the leaf from the TOC allowlist. The pick is
// validated against the allowlist; an invalid pick or any Groq failure falls
// back to deterministic STAIR and the response says so.
import { stairAnswer } from '../src/lib/stair';
import { GroqClient } from '../src/lib/groq';

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed. Use POST.' }); return; }
  const body = req.body ?? {};
  if (!body.query || typeof body.query !== 'string') { res.status(400).json({ error: 'Body must include query (string).' }); return; }
  const trees = body.trees ?? [];
  let liveLlm = 'off';
  let liveLeafId: string | null = null;
  if (body.live_llm === true) {
    try {
      const groq = GroqClient.fromEnv();
      const leaves = trees.flatMap((t: any) => t.leaves ?? []);
      liveLeafId = await groq.pickLeaf(body.query, leaves);
      liveLlm = 'groq';
    } catch (e) {
      liveLlm = 'unavailable, deterministic fallback';
      liveLeafId = null;
    }
  }
  if (liveLeafId) {
    const leaf = trees.flatMap((t: any) => t.leaves ?? []).find((l: any) => l.id === liveLeafId);
    if (leaf) {
      res.status(200).json({ query: body.query, answer: leaf.body, leaf, score: 1, refused: false, llm: true, liveLlm, liveLeafId, chunking: false });
      return;
    }
    // Validated again here: a leaf id not in the trees is never returned.
    liveLlm = 'unavailable, deterministic fallback';
  }
  const result = stairAnswer(trees, body.query);
  res.status(200).json({ query: body.query, ...result, llm: liveLlm === 'groq', liveLlm, liveLeafId: null, chunking: false });
}
