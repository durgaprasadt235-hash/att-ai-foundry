// Shared API-handler helpers for the Vercel serverless functions.
// Two guarantees every handler must keep:
//   1. Errors are always JSON ({ error, reason? }) — never a 500 HTML page
//      and never an uncaught throw (which Vercel surfaces as the opaque
//      FUNCTION_INVOCATION_FAILED class of bug). Handlers wrap their body
//      in try/catch and answer with jsonError().
//   2. A rate-limit guard runs before any work. It is DEMO-GRADE and
//      labelled as such: in-memory, per serverless instance, resets on
//      cold start, keyed by client IP. It stops a runaway caller in the
//      demo; production rate limiting belongs at the edge (Vercel WAF /
//      API gateway) at the documented 60 requests/min per caller.
export function jsonError(res: any, status: number, error: string, reason?: string): void {
  res.status(status).json({ error, ...(reason ? { reason } : {}) });
}

/** Demo-grade in-memory rate-limit guard: 60 requests per rolling minute
 *  per client IP. Returns { allowed, retryAfterSeconds }. When not allowed
 *  the handler must answer 429 with a Retry-After header. */
const RATE_LIMIT_PER_MINUTE = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;
const hitsByIp = new Map<string, number[]>();

export function clientIp(req: any): string {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? 'unknown';
}

export function checkRateLimit(req: any): { allowed: boolean; retryAfterSeconds: number } {
  const ip = clientIp(req);
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const hits = (hitsByIp.get(ip) ?? []).filter((t) => t > windowStart);
  if (hits.length >= RATE_LIMIT_PER_MINUTE) {
    const oldest = hits[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - now) / 1000));
    hitsByIp.set(ip, hits);
    return { allowed: false, retryAfterSeconds };
  }
  hits.push(now);
  hitsByIp.set(ip, hits);
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Enforce the guard; returns true when the handler may proceed. When it
 *  returns false it has already answered 429 JSON. */
export function enforceRateLimit(req: any, res: any): boolean {
  const { allowed, retryAfterSeconds } = checkRateLimit(req);
  if (!allowed) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    jsonError(res, 429, 'Rate limit exceeded', `Demo-grade guard: ${RATE_LIMIT_PER_MINUTE} requests per minute per client. Retry after ${retryAfterSeconds}s. Production rate limiting belongs at the edge.`);
    return false;
  }
  return true;
}
