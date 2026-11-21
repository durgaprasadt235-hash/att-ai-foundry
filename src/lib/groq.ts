// Live Groq client for the Vercel serverless API (src/lib/groq.ts).
// Calls Groq's OpenAI-compatible API with model openai/gpt-oss-120b.
// Mirrors server/groq_client.py (same model, same rules, same errors).
//
// Two facts that cost a morning to learn:
// * Groq (behind Cloudflare) returns 403 error code 1010 for a missing /
//   default User-Agent. Every request MUST send a real User-Agent
//   ("att-ai-foundry/1.0") or it is blocked before the key is checked.
// * Model llama-3.1-8b-instant is NOT available on this account (Groq
//   returns 404 model_not_found). Use openai/gpt-oss-120b only.
//
// The key comes from the GROQ_API_KEY environment variable only (a Vercel
// project env var in production) — never from code, never from git, never
// from a request body. On any failure this throws GroqUnavailable and the
// caller falls back to the deterministic engine; it never fakes an answer.
import type { StairLeaf } from './types';

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
export const GROQ_MODEL = 'openai/gpt-oss-120b';
export const GROQ_USER_AGENT = 'att-ai-foundry/1.0';
export const GROQ_TIMEOUT_MS = 20_000;

/** Read an env var without Node types (this file is also bundled for the
 *  browser build, where process does not exist). */
export function getEnv(name: string): string {
  const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name] ?? '';
}

export class GroqUnavailable extends Error {
  status: number | null;
  constructor(reason: string, status: number | null = null) {
    super(reason);
    this.name = 'GroqUnavailable';
    this.status = status;
  }
}

export interface GroqClientOptions {
  apiKey: string;
  model?: string;
}

export class GroqClient {
  private apiKey: string;
  readonly model: string;

  constructor(opts: GroqClientOptions) {
    if (!opts.apiKey) throw new GroqUnavailable('GROQ_API_KEY is not set');
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? GROQ_MODEL;
  }

  static fromEnv(): GroqClient {
    return new GroqClient({ apiKey: getEnv('GROQ_API_KEY') });
  }

  async chat(messages: { role: string; content: string }[], jsonMode = false, maxTokens = 300): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
    try {
      const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Real User-Agent is REQUIRED: Cloudflare blocks missing/default agents (403/1010).
          'User-Agent': GROQ_USER_AGENT,
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0,
          max_tokens: maxTokens,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 500);
        throw new GroqUnavailable(`Groq returned HTTP ${res.status}: ${detail}`, res.status);
      }
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return body.choices?.[0]?.message?.content ?? '';
    } catch (e) {
      if (e instanceof GroqUnavailable) throw e;
      throw new GroqUnavailable(`Groq request failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ask Groq to pick one STAIR leaf for a query, from the TOC allowlist
   *  only. Returns the picked leaf id; an invented or unknown id, or a
   *  "none fits" answer, throws GroqUnavailable (caller falls back). */
  async pickLeaf(query: string, leaves: StairLeaf[]): Promise<string> {
    const allowedIds = new Set(leaves.map((l) => l.id));
    const toc = leaves.map((l) => `- ${l.id}: ${l.path} ${l.section}`).join('\n');
    const content = await this.chat(
      [
        { role: 'system', content: 'You pick one policy section for a customer-service case. Reply with JSON only: {"leaf_id": "<one id from the list>"}. Pick only an id from the list. If none fits, reply {"leaf_id": null}.' },
        { role: 'user', content: `Case query: ${query}\n\nPolicy sections:\n${toc}` },
      ],
      true,
      120,
    );
    let picked: unknown;
    try {
      picked = (JSON.parse(content) as { leaf_id?: unknown }).leaf_id;
    } catch {
      throw new GroqUnavailable(`Groq leaf pick was not valid JSON: ${content.slice(0, 200)}`);
    }
    if (picked === null || picked === undefined) throw new GroqUnavailable('Groq picked no leaf for this query');
    if (typeof picked !== 'string' || !allowedIds.has(picked)) {
      throw new GroqUnavailable(`Groq picked leaf id ${JSON.stringify(picked)}, which is not in the TOC allowlist`);
    }
    return picked;
  }

  /** Draft a short customer-facing summary. Words only — it never changes
   *  amounts, plans, or decisions. */
  async draftSummary(caseSummary: string, citation: string, proposedAction: string): Promise<string> {
    const content = await this.chat(
      [
        { role: 'system', content: 'Write one short customer-facing paragraph (at most 3 sentences) explaining a proposed resolution. Use only the facts given. Do not invent amounts, dates, or policy terms. Plain language.' },
        { role: 'user', content: `Case: ${caseSummary}\nGrounded in: ${citation}\nProposed action: ${proposedAction}` },
      ],
      false,
      200,
    );
    return content.trim();
  }
}

/** The grounding query each case type uses — shared by the API handlers so
 *  the Groq leaf pick and the deterministic engine ask the same question. */
export function groundingQueryForCaseType(caseType: string): string | null {
  switch (caseType) {
    case 'duplicate_charge': return 'duplicate charge credit policy';
    case 'provisioning': return 'new line activation provisioning';
    case 'outage': return 'network outage triage diagnose';
    case 'plan_change': return 'plan upgrade price premium starter';
    case 'retention': return 'retention save offer churn';
    default: return null;
  }
}
