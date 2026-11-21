// POST /api/rag — grounded retrieval over the caller's indexed docs.
// Body: { query, docs }. Answers only from the docs; refuses otherwise.
// Same deterministic engine as src/lib/engine.ts. No LLM is called.
import { groundedAnswer } from '../src/lib/engine';
import { enforceRateLimit, jsonError } from '../src/lib/api-utils';

export default function handler(req: any, res: any): void {
  try {
  if (req.method !== 'POST') { jsonError(res, 405, 'Method not allowed. Use POST.'); return; }
  if (!enforceRateLimit(req, res)) return;
  const body = req.body ?? {};
  if (!body.query || typeof body.query !== 'string') { jsonError(res, 400, 'Body must include query (string).'); return; }
  const result = groundedAnswer(body.docs ?? [], body.query);
  res.status(200).json({ query: body.query, ...result, llm: false });
  } catch (e) {
    jsonError(res, 500, 'RAG search failed', e instanceof Error ? e.message : String(e));
  }
}
