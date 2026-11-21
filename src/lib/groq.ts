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

/* ---------------- Circuit breaker (resilience) ----------------
 * After 3 consecutive Groq failures the breaker OPENS for 60s: no Groq
 * call is attempted at all, and the caller serves the deterministic
 * fallback and says so ("circuit open"). After the cooldown the breaker
 * goes HALF-OPEN and allows one trial call: success closes it, failure
 * re-opens it immediately. This stops a failing LLM from adding latency
 * and errors to every run, and it stops the app hammering a dead API.
 * State is module-level (per serverless instance); a cold start resets
 * it to closed. Production breakers belong in the shared client, not
 * per instance — the logic here is the same either way. */
export type CircuitState = 'closed' | 'open' | 'half-open';
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60_000;
const breaker = { failures: 0, openedAt: null as number | null, halfOpen: false };

export function groqCircuitState(): CircuitState {
  if (breaker.openedAt === null) return breaker.halfOpen ? 'half-open' : 'closed';
  if (Date.now() - breaker.openedAt < BREAKER_COOLDOWN_MS) return 'open';
  // Cooldown elapsed: half-open, one trial call allowed.
  breaker.openedAt = null;
  breaker.halfOpen = true;
  return 'half-open';
}

export function recordGroqSuccess(): void {
  breaker.failures = 0;
  breaker.openedAt = null;
  breaker.halfOpen = false;
}

export function recordGroqFailure(): void {
  if (breaker.halfOpen) {
    // The trial call failed: re-open immediately.
    breaker.openedAt = Date.now();
    breaker.halfOpen = false;
    return;
  }
  breaker.failures += 1;
  if (breaker.failures >= BREAKER_THRESHOLD) {
    breaker.openedAt = Date.now();
    breaker.failures = 0;
  }
}

/** Test/ops hook: reset the breaker (used by the health probe path and
 *  by tests). Not a user-facing feature. */
export function resetGroqCircuit(): void {
  breaker.failures = 0;
  breaker.openedAt = null;
  breaker.halfOpen = false;
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
    // Circuit breaker: when open, do not call Groq at all — fail fast
    // into the deterministic fallback instead of adding latency/errors.
    if (groqCircuitState() === 'open') {
      throw new GroqUnavailable('Groq circuit breaker is open (3 consecutive failures) — deterministic fallback for 60s');
    }
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
      recordGroqSuccess();
      return body.choices?.[0]?.message?.content ?? '';
    } catch (e) {
      if (e instanceof GroqUnavailable) { recordGroqFailure(); throw e; }
      recordGroqFailure();
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

/** Lightweight liveness probe: GET /models with the key. True ONLY when
 *  Groq answers 200 — a configured key that is revoked, expired, or
 *  rate-limited returns false. Used by /api/health so `llm_live` means a
 *  live Groq call succeeded, not merely that a key is configured. Cheap
 *  (no completion tokens) and short-timeout; health caches the result. */
export async function probeGroqLive(apiKey: string, timeoutMs = 5000): Promise<boolean> {
  if (!apiKey) return false;
  // Do not hammer a dead API: when the breaker is open the probe reports
  // "not live" without calling Groq at all.
  if (groqCircuitState() === 'open') return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${GROQ_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': GROQ_USER_AGENT },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
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
