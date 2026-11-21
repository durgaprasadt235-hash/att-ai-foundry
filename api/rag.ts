// POST /api/rag — grounded retrieval over the caller's indexed docs.
// Body: { query, docs }. Answers only from the docs; refuses otherwise.
// Same deterministic engine as src/lib/engine.ts. No LLM is called.
import { groundedAnswer } from '../src/lib/engine';

export default function handler(req: any, res: any): void {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed. Use POST.' }); return; }
  const body = req.body ?? {};
  if (!body.query || typeof body.query !== 'string') { res.status(400).json({ error: 'Body must include query (string).' }); return; }
  const result = groundedAnswer(body.docs ?? [], body.query);
  res.status(200).json({ query: body.query, ...result, llm: false });
}
