// src/lib/text.ts
var STOPWORDS = new Set(
  "a an the is are was were what how why when where which who whom this that these those it its of for to in on at by with from as and or not no do does did can could should would i me my we you your he she they them his her their our".split(" ")
);
function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w)).map((w) => w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
}

// src/lib/stair.ts
function validLeafTitles(trees) {
  return new Set(trees.flatMap((t) => t.leaves.map((l) => l.title)));
}
function allLeaves(trees) {
  return trees.flatMap((t) => t.leaves);
}
function stairRetrieve(trees, query) {
  const q = [...new Set(tokenize(query))];
  if (q.length === 0) return null;
  const allowed = validLeafTitles(trees);
  let best = null;
  for (const leaf of allLeaves(trees)) {
    if (!allowed.has(leaf.title)) continue;
    const hay = tokenize(`${leaf.path} ${leaf.title} ${leaf.section}`);
    const matched = q.filter((t) => hay.includes(t));
    const score = matched.length / q.length;
    if (score >= 0.2 && (!best || score > best.score)) best = { leaf, score: Math.round(score * 100) / 100, matched };
  }
  return best;
}
function stairAnswer(trees, query) {
  const hit = stairRetrieve(trees, query);
  if (!hit) {
    return { answer: "Not found in policy \u2014 no section in the Table of Contents matches this question, so I will not guess.", leaf: null, score: 0, refused: true };
  }
  return { answer: hit.leaf.body, leaf: hit.leaf, score: hit.score, refused: false };
}

// src/lib/groq.ts
var GROQ_BASE_URL = "https://api.groq.com/openai/v1";
var GROQ_MODEL = "openai/gpt-oss-120b";
var GROQ_USER_AGENT = "telecom-project/1.0";
var GROQ_TIMEOUT_MS = 2e4;
function getEnv(name) {
  const proc = globalThis.process;
  return proc?.env?.[name] ?? "";
}
var GroqUnavailable = class extends Error {
  status;
  constructor(reason, status = null) {
    super(reason);
    this.name = "GroqUnavailable";
    this.status = status;
  }
};
var BREAKER_THRESHOLD = 3;
var BREAKER_COOLDOWN_MS = 6e4;
var breaker = { failures: 0, openedAt: null, halfOpen: false };
function groqCircuitState() {
  if (breaker.openedAt === null) return breaker.halfOpen ? "half-open" : "closed";
  if (Date.now() - breaker.openedAt < BREAKER_COOLDOWN_MS) return "open";
  breaker.openedAt = null;
  breaker.halfOpen = true;
  return "half-open";
}
function recordGroqSuccess() {
  breaker.failures = 0;
  breaker.openedAt = null;
  breaker.halfOpen = false;
}
function recordGroqFailure() {
  if (breaker.halfOpen) {
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
var GroqClient = class _GroqClient {
  apiKey;
  model;
  constructor(opts) {
    if (!opts.apiKey) throw new GroqUnavailable("GROQ_API_KEY is not set");
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? GROQ_MODEL;
  }
  static fromEnv() {
    return new _GroqClient({ apiKey: getEnv("GROQ_API_KEY") });
  }
  async chat(messages, jsonMode = false, maxTokens = 300) {
    if (groqCircuitState() === "open") {
      throw new GroqUnavailable("Groq circuit breaker is open (3 consecutive failures) \u2014 deterministic fallback for 60s");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
    try {
      const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Real User-Agent is REQUIRED: Cloudflare blocks missing/default agents (403/1010).
          "User-Agent": GROQ_USER_AGENT,
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0,
          max_tokens: maxTokens,
          ...jsonMode ? { response_format: { type: "json_object" } } : {}
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 500);
        throw new GroqUnavailable(`Groq returned HTTP ${res.status}: ${detail}`, res.status);
      }
      const body = await res.json();
      recordGroqSuccess();
      return body.choices?.[0]?.message?.content ?? "";
    } catch (e) {
      if (e instanceof GroqUnavailable) {
        recordGroqFailure();
        throw e;
      }
      recordGroqFailure();
      throw new GroqUnavailable(`Groq request failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  /** Ask Groq to pick one STAIR leaf for a query, from the TOC allowlist
   *  only. Returns the picked leaf id; an invented or unknown id, or a
   *  "none fits" answer, throws GroqUnavailable (caller falls back). */
  async pickLeaf(query, leaves) {
    const allowedIds = new Set(leaves.map((l) => l.id));
    const toc = leaves.map((l) => `- ${l.id}: ${l.path} ${l.section}`).join("\n");
    const content = await this.chat(
      [
        { role: "system", content: 'You pick one policy section for a customer-service case. Reply with JSON only: {"leaf_id": "<one id from the list>"}. Pick only an id from the list. If none fits, reply {"leaf_id": null}.' },
        { role: "user", content: `Case query: ${query}

Policy sections:
${toc}` }
      ],
      true,
      120
    );
    let picked;
    try {
      picked = JSON.parse(content).leaf_id;
    } catch {
      throw new GroqUnavailable(`Groq leaf pick was not valid JSON: ${content.slice(0, 200)}`);
    }
    if (picked === null || picked === void 0) throw new GroqUnavailable("Groq picked no leaf for this query");
    if (typeof picked !== "string" || !allowedIds.has(picked)) {
      throw new GroqUnavailable(`Groq picked leaf id ${JSON.stringify(picked)}, which is not in the TOC allowlist`);
    }
    return picked;
  }
  /** Draft a short customer-facing summary. Words only — it never changes
   *  amounts, plans, or decisions. */
  async draftSummary(caseSummary, citation, proposedAction) {
    const content = await this.chat(
      [
        { role: "system", content: "Write one short customer-facing paragraph (at most 3 sentences) explaining a proposed resolution. Use only the facts given. Do not invent amounts, dates, or policy terms. Plain language." },
        { role: "user", content: `Case: ${caseSummary}
Grounded in: ${citation}
Proposed action: ${proposedAction}` }
      ],
      false,
      200
    );
    return content.trim();
  }
};

// src/lib/api-utils.ts
function jsonError(res, status, error, reason) {
  res.status(status).json({ error, ...reason ? { reason } : {} });
}
var RATE_LIMIT_PER_MINUTE = 60;
var RATE_LIMIT_WINDOW_MS = 6e4;
var hitsByIp = /* @__PURE__ */ new Map();
function clientIp(req) {
  const forwarded = req?.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
  return req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? "unknown";
}
function checkRateLimit(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const hits = (hitsByIp.get(ip) ?? []).filter((t) => t > windowStart);
  if (hits.length >= RATE_LIMIT_PER_MINUTE) {
    const oldest = hits[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - now) / 1e3));
    hitsByIp.set(ip, hits);
    return { allowed: false, retryAfterSeconds };
  }
  hits.push(now);
  hitsByIp.set(ip, hits);
  return { allowed: true, retryAfterSeconds: 0 };
}
function enforceRateLimit(req, res) {
  const { allowed, retryAfterSeconds } = checkRateLimit(req);
  if (!allowed) {
    res.setHeader("Retry-After", String(retryAfterSeconds));
    jsonError(res, 429, "Rate limit exceeded", `Demo-grade guard: ${RATE_LIMIT_PER_MINUTE} requests per minute per client. Retry after ${retryAfterSeconds}s. Production rate limiting belongs at the edge.`);
    return false;
  }
  return true;
}

// api-src/stair.ts
async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      jsonError(res, 405, "Method not allowed. Use POST.");
      return;
    }
    if (!enforceRateLimit(req, res)) return;
    const body = req.body ?? {};
    if (!body.query || typeof body.query !== "string") {
      jsonError(res, 400, "Body must include query (string).");
      return;
    }
    const trees = body.trees ?? [];
    let liveLlm = "off";
    let liveLeafId = null;
    if (body.live_llm === true) {
      try {
        const groq = GroqClient.fromEnv();
        const leaves = trees.flatMap((t) => t.leaves ?? []);
        liveLeafId = await groq.pickLeaf(body.query, leaves);
        liveLlm = "groq";
      } catch (e) {
        liveLlm = "unavailable, deterministic fallback";
        liveLeafId = null;
      }
    }
    if (liveLeafId) {
      const leaf = trees.flatMap((t) => t.leaves ?? []).find((l) => l.id === liveLeafId);
      if (leaf) {
        res.status(200).json({ query: body.query, answer: leaf.body, leaf, score: 1, refused: false, llm: true, liveLlm, liveLeafId, chunking: false });
        return;
      }
      liveLlm = "unavailable, deterministic fallback";
    }
    const result = stairAnswer(trees, body.query);
    res.status(200).json({ query: body.query, ...result, llm: liveLlm === "groq", liveLlm, liveLeafId: null, chunking: false });
  } catch (e) {
    jsonError(res, 500, "STAIR retrieval failed", e instanceof Error ? e.message : String(e));
  }
}
export {
  handler as default
};
