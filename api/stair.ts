// POST /api/stair — STAIR retrieval over the caller's knowledge trees.
// Body: { query, trees }. No chunking, no embeddings. The leaf section is
// returned intact with its full section path, or "not found in policy".
import { stairAnswer } from '../src/lib/stair';

export default function handler(req: any, res: any): void {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed. Use POST.' }); return; }
  const body = req.body ?? {};
  if (!body.query || typeof body.query !== 'string') { res.status(400).json({ error: 'Body must include query (string).' }); return; }
  const result = stairAnswer(body.trees ?? [], body.query);
  res.status(200).json({ query: body.query, ...result, llm: false, chunking: false });
}
