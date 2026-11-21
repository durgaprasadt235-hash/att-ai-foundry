// src/lib/text.ts
var STOPWORDS = new Set(
  "a an the is are was were what how why when where which who whom this that these those it its of for to in on at by with from as and or not no do does did can could should would i me my we you your he she they them his her their our".split(" ")
);
function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w)).map((w) => w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
}

// src/lib/engine.ts
function ragSearch(docs, query) {
  const q = [...new Set(tokenize(query))];
  if (q.length === 0) return [];
  return docs.map((doc) => {
    const hay = tokenize(`${doc.title} ${doc.body}`);
    const matched = q.filter((t) => hay.includes(t));
    return { doc, score: matched.length / q.length, matched };
  }).filter((h) => h.score >= 0.2).sort((a, b) => b.score - a.score);
}
function groundedAnswer(docs, query) {
  const hits = ragSearch(docs, query);
  if (hits.length === 0) {
    return {
      answer: "Not in the indexed docs \u2014 I cannot answer this from policy. No policy document matches your question, so I will not guess.",
      citations: [],
      refused: true
    };
  }
  const top = hits.slice(0, 3);
  const answer = top.map((h) => h.doc.body).join(" ");
  return {
    answer,
    citations: top.map((h) => ({ docId: h.doc.id, title: h.doc.title, score: Math.round(h.score * 100) / 100 })),
    refused: false
  };
}

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

// api-src/rag.ts
function handler(req, res) {
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
    const result = groundedAnswer(body.docs ?? [], body.query);
    res.status(200).json({ query: body.query, ...result, llm: false });
  } catch (e) {
    jsonError(res, 500, "RAG search failed", e instanceof Error ? e.message : String(e));
  }
}
export {
  handler as default
};
