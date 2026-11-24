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

// src/lib/types.ts
var PLAN_PRICES = {
  "Unlimited Starter": 65,
  "Unlimited Premium": 87.4,
  "Family Share": 98,
  "Business Elite": 112
};
var OUTAGE_CREDIT_USD = 25;
var RETENTION_CREDIT_USD = 25;
var GOODWILL_APPROVAL_THRESHOLD_USD = 25;
var OUTAGE_MIN_HOURS = 4;
var DEFAULT_TARGET_PLAN = "Unlimited Premium";

// src/lib/engine.ts
function findDuplicate(ledger, customerId) {
  const charges = ledger.filter((e) => e.customerId === customerId && e.kind === "charge" && e.status === "posted").sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 0; i < charges.length; i++) {
    for (let j = i + 1; j < charges.length; j++) {
      const a = charges[i];
      const b = charges[j];
      if (a.service !== b.service || a.amount !== b.amount || a.invoice === b.invoice) continue;
      const days = (new Date(b.date).getTime() - new Date(a.date).getTime()) / 864e5;
      if (days >= 0 && days <= 7) return { original: a, duplicate: b };
    }
  }
  return null;
}
function parseTargetPlan(description) {
  const desc = (description ?? "").toLowerCase();
  for (const plan of Object.keys(PLAN_PRICES)) {
    if (desc.includes(`to ${plan.toLowerCase()}`)) return plan;
  }
  for (const plan of Object.keys(PLAN_PRICES)) {
    if (desc.includes(`with ${plan.toLowerCase()}`)) return plan;
  }
  return DEFAULT_TARGET_PLAN;
}
function isNetworkOutageConfirmed(c) {
  return (c.description ?? "").toLowerCase().includes("network-confirmed");
}
function makeSteps() {
  const steps = [];
  const add = (id, name, tool, status, detail, extra) => steps.push({ id, name, tool, status, ms: 0, retries: 0, detail, ...extra });
  return { steps, add };
}
function baseResult() {
  return { steps: [], proposedCredit: null, duplicate: null, citation: null, failureReason: null, effectKind: "none", effectData: {}, proposedAction: null, liveLlm: "off", liveSummary: null, liveLeafPicks: {} };
}
function stairGround(state, query, liveLeafByQuery) {
  const hintId = liveLeafByQuery?.[query];
  if (hintId) {
    const hinted = (state.stairTrees ?? []).flatMap((t) => t.leaves).find((l) => l.id === hintId);
    if (hinted) return { leaf: hinted, score: 1, live: true };
  }
  const hit = stairRetrieve(state.stairTrees ?? [], query);
  return hit ? { leaf: hit.leaf, score: hit.score, live: false } : { leaf: null, score: 0, live: false };
}
function intake(state, c, add) {
  const customer = state.customers.find((x) => x.id === c.customerId) ?? null;
  if (!customer) {
    add("intake", "Intake + idempotency check", "validate_case", "failed", `Customer ${c.customerId} not found. Run stopped.`);
    return null;
  }
  add(
    "intake",
    "Intake + idempotency check",
    "validate_case",
    "done",
    `Case ${c.id} validated. Idempotency key ${c.idempotencyKey}. No completed run exists for this key.`
  );
  return customer;
}
function retrieve360(state, c, customer, add) {
  const ledger = state.ledger.filter((e) => e.customerId === c.customerId);
  add(
    "retrieve-360",
    "Retrieve Customer 360",
    "get_customer_360",
    "done",
    `${customer.name} (${customer.account}), ${customer.plan}, balance $${customer.balance.toFixed(2)}. ${ledger.length} ledger entries, ${state.usage.filter((u) => u.customerId === c.customerId).length} usage records, ${state.tickets.filter((t) => t.customerId === c.customerId).length} tickets.`
  );
}
function planRun(state, c, opts = {}) {
  const result = baseResult();
  result.liveLlm = opts.liveLlm ?? "off";
  result.liveSummary = opts.liveSummary ?? null;
  result.liveLeafPicks = opts.liveLeafByQuery ?? {};
  const { steps, add } = makeSteps();
  result.steps = steps;
  const customer = intake(state, c, add);
  if (!customer) {
    result.failureReason = `Customer ${c.customerId} not found.`;
    return result;
  }
  retrieve360(state, c, customer, add);
  let planned;
  if (c.type === "duplicate_charge") planned = planBilling(state, c, customer, result, add, opts);
  else if (c.type === "provisioning") planned = planProvisioning(state, c, customer, result, add, opts);
  else if (c.type === "outage") planned = planOutage(state, c, customer, result, add, opts);
  else if (c.type === "plan_change") planned = planPlanChange(state, c, customer, result, add, opts);
  else if (c.type === "retention") planned = planRetention(state, c, customer, result, add, opts);
  else {
    add(
      "validate",
      "Validate case",
      "validate_case",
      "failed",
      `Case type ${c.type} has no agent workflow in this demo. Run stopped \u2014 no action proposed.`
    );
    result.failureReason = `Case type ${c.type} has no agent workflow in this demo.`;
    planned = result;
  }
  if (opts.liveLlm === "groq") {
    planned.steps.push({
      id: "live-llm",
      name: "Live LLM (Groq)",
      tool: "groq_chat",
      status: "done",
      retries: 0,
      detail: "Live LLM (openai/gpt-oss-120b) picked the STAIR leaf(s) from the TOC allowlist; deterministic validation still applied to every amount and eligibility check."
    });
  } else if (opts.liveLlm === "unavailable, deterministic fallback") {
    planned.steps.push({
      id: "live-llm",
      name: "Live LLM (Groq)",
      tool: "groq_chat",
      status: "done",
      retries: 0,
      detail: "Live LLM unavailable \u2014 deterministic fallback. The run completed with deterministic STAIR and validation, and no answer was faked."
    });
  }
  return planned;
}
function planBilling(state, c, _customer, result, add, opts = {}) {
  const g = stairGround(state, "duplicate charge credit policy", opts.liveLeafByQuery);
  if (!g.leaf) {
    add("stair-ground", "STAIR policy grounding", "stair_retrieve", "failed", "No section in the Table of Contents covers duplicate charges. The agent refuses to proceed without grounding.");
    result.failureReason = "No grounding section found for duplicate charges.";
    return result;
  }
  result.citation = `${g.leaf.path} ${g.leaf.section}`;
  add(
    "stair-ground",
    "STAIR policy grounding",
    "stair_retrieve",
    "done",
    `Grounded in ${g.leaf.path} ${g.leaf.section} \u2014 leaf retrieved intact, no chunking. \u201C${g.leaf.body.slice(0, 160)}\u2026\u201D`,
    { citation: result.citation }
  );
  const dup = findDuplicate(state.ledger, c.customerId);
  if (!dup) {
    add("validate", "Validate duplicate charge", "validate_duplicate", "failed", "No second posted charge matches the same service and amount within 7 days. No duplicate found \u2014 no credit proposed.");
    result.failureReason = "No duplicate charge found in the ledger.";
    return result;
  }
  result.duplicate = dup;
  add(
    "validate",
    "Validate duplicate charge",
    "validate_duplicate",
    "done",
    `Duplicate confirmed: ${dup.original.invoice} (${dup.original.date}) and ${dup.duplicate.invoice} (${dup.duplicate.date}), ${dup.duplicate.service}, $${dup.duplicate.amount.toFixed(2)} each.`
  );
  result.proposedCredit = dup.duplicate.amount;
  result.effectKind = "credit";
  result.effectData = { invoice: dup.duplicate.invoice, amount: dup.duplicate.amount };
  result.proposedAction = `Credit $${dup.duplicate.amount.toFixed(2)} against ${dup.duplicate.invoice}`;
  const thresholdNote = dup.duplicate.amount > GOODWILL_APPROVAL_THRESHOLD_USD ? `Credit is above $${GOODWILL_APPROVAL_THRESHOLD_USD.toFixed(2)}, so human approval is required (POL-002).` : `Credit is $${dup.duplicate.amount.toFixed(2)}, at or below the $${GOODWILL_APPROVAL_THRESHOLD_USD.toFixed(2)} POL-002 threshold \u2014 this demo still pauses for human approval.`;
  add(
    "plan-propose",
    "Plan + propose credit",
    "propose_credit",
    "done",
    `Propose a credit of $${dup.duplicate.amount.toFixed(2)} against ${dup.duplicate.invoice} only. ${thresholdNote} Run pauses for approval.`
  );
  return result;
}
function planProvisioning(state, _c, customer, result, add, opts = {}) {
  const g = stairGround(state, "new line activation provisioning", opts.liveLeafByQuery);
  if (!g.leaf) {
    add("stair-ground", "STAIR policy grounding", "stair_retrieve", "failed", "No section covers new line activation.");
    result.failureReason = "No grounding section found for provisioning.";
    return result;
  }
  result.citation = `${g.leaf.path} ${g.leaf.section}`;
  add("stair-ground", "STAIR policy grounding", "stair_retrieve", "done", `Grounded in ${g.leaf.path} ${g.leaf.section}.`, { citation: result.citation });
  if (customer.status !== "active") {
    add("validate", "Eligibility check", "check_eligibility", "failed", `Account is ${customer.status}, not active. A new line cannot be activated. Run stopped.`);
    result.failureReason = `Account is ${customer.status}; new line activation requires an active account.`;
    return result;
  }
  if (customer.balance > 100) {
    add("validate", "Eligibility check", "check_eligibility", "failed", `Overdue balance $${customer.balance.toFixed(2)} is above the $100 limit. Run stopped.`);
    result.failureReason = "Overdue balance above $100; new line activation is not eligible.";
    return result;
  }
  add("validate", "Eligibility check", "check_eligibility", "done", `Account active, balance $${customer.balance.toFixed(2)} (limit $100). Eligible.`);
  add("order", "Create order + provision", "create_order", "done", "Order prepared for a second line with device activation. Network provisioning and SIM registration will run on approval.");
  result.effectKind = "provisioning";
  result.effectData = { kind: "new_line" };
  result.proposedAction = "Activate a second line with device activation";
  add("plan-propose", "Plan + propose activation", "propose_activation", "done", "Propose activating the second line. Human approval is required before provisioning runs. Run pauses for approval.");
  return result;
}
function planOutage(state, c, _customer, result, add, opts = {}) {
  const g = stairGround(state, "network outage triage diagnose", opts.liveLeafByQuery);
  if (!g.leaf) {
    add("stair-ground", "STAIR policy grounding", "stair_retrieve", "failed", "No section covers outage triage.");
    result.failureReason = "No grounding section found for outage triage.";
    return result;
  }
  result.citation = `${g.leaf.path} ${g.leaf.section}`;
  add("stair-ground", "STAIR policy grounding", "stair_retrieve", "done", `Grounded in ${g.leaf.path} ${g.leaf.section}.`, { citation: result.citation });
  if (!isNetworkOutageConfirmed(c)) {
    add("diagnose", "Diagnose from network status", "check_network_status", "failed", `No network-status confirmation in the case record \u2014 the customer report alone does not confirm an outage. Policy requires a network-confirmed outage over ${OUTAGE_MIN_HOURS} hours (POL-006). No outage credit proposed.`);
    result.failureReason = `Outage is not network-confirmed (over ${OUTAGE_MIN_HOURS} hours). No outage credit can be proposed.`;
    return result;
  }
  add("diagnose", "Diagnose from network status", "check_network_status", "done", `Network status check: the case record references a network-confirmed outage lasting over ${OUTAGE_MIN_HOURS} hours. Diagnosis: confirmed outage, not a device fault.`);
  const creditLeaf = stairGround(state, "outage service credit", opts.liveLeafByQuery);
  if (!creditLeaf.leaf) {
    add("credit-check", "Outage credit check", "stair_retrieve", "failed", "No section covers outage service credits. The credit cannot be grounded, so no credit is proposed.");
    result.failureReason = "No grounding section found for outage service credit.";
    return result;
  }
  result.citation = `${result.citation} + ${creditLeaf.leaf.path} ${creditLeaf.leaf.section}`;
  const ledgerEntry = state.ledger.find((e) => e.customerId === c.customerId && e.amount === c.amount);
  const ledgerNote = ledgerEntry ? ` Ledger: ${ledgerEntry.invoice}, ${ledgerEntry.service}, $${ledgerEntry.amount.toFixed(2)}.` : "";
  add("credit-check", "Outage credit check", "stair_retrieve", "done", `Case amount $${c.amount.toFixed(2)} is the reported device installment, not the credit. Policy credit is $${OUTAGE_CREDIT_USD.toFixed(2)} per Outage Service Credit Policy \xA75.1, network-confirmed >${OUTAGE_MIN_HOURS}h. (${creditLeaf.leaf.path} ${creditLeaf.leaf.section})${ledgerNote}`, { citation: result.citation });
  result.proposedCredit = OUTAGE_CREDIT_USD;
  result.effectKind = "outage_credit";
  result.effectData = { amount: OUTAGE_CREDIT_USD, caseAmount: c.amount };
  result.proposedAction = `Schedule a technician visit and apply a $${OUTAGE_CREDIT_USD.toFixed(2)} outage service credit`;
  add("plan-propose", "Plan + propose resolution", "propose_outage_resolution", "done", `Propose: notify the customer, schedule a technician visit, and apply a $${OUTAGE_CREDIT_USD.toFixed(2)} outage service credit \u2014 not the $${c.amount.toFixed(2)} case amount, which is the reported device installment. Human approval required. Run pauses for approval.`);
  return result;
}
function planPlanChange(state, c, customer, result, add, opts = {}) {
  const g = stairGround(state, "plan upgrade price premium starter", opts.liveLeafByQuery);
  if (!g.leaf) {
    add("stair-ground", "STAIR policy grounding", "stair_retrieve", "failed", "No section covers upgrade pricing.");
    result.failureReason = "No grounding section found for plan upgrade pricing.";
    return result;
  }
  result.citation = `${g.leaf.path} ${g.leaf.section}`;
  add("stair-ground", "STAIR policy grounding", "stair_retrieve", "done", `Grounded in ${g.leaf.path} ${g.leaf.section}.`, { citation: result.citation });
  const targetPlan = parseTargetPlan(c.description);
  const currentPrice = PLAN_PRICES[customer.plan];
  const targetPrice = PLAN_PRICES[targetPlan];
  if (currentPrice === void 0) {
    add("validate", "Eligibility + price comparison", "compare_plans", "failed", `Unknown current plan "${customer.plan}" \u2014 no price in the plan price table. Run stopped.`);
    result.failureReason = `Unknown current plan "${customer.plan}".`;
    return result;
  }
  const diff = Math.round((targetPrice - currentPrice) * 100) / 100;
  if (diff === 0) {
    add("validate", "Eligibility + price comparison", "compare_plans", "failed", `Customer is already on ${targetPlan}. There is nothing to change. Run stopped.`);
    result.failureReason = `Customer is already on ${targetPlan}.`;
    return result;
  }
  const calc = `${customer.plan} $${currentPrice.toFixed(2)} \u2192 ${targetPlan} $${targetPrice.toFixed(2)}. Difference: ${diff > 0 ? "+" : "-"}$${Math.abs(diff).toFixed(2)}${diff > 0 ? " (charge)" : " (credit)"}.`;
  if (diff > 0) {
    add("validate", "Eligibility + price comparison", "compare_plans", "done", `${calc} Customer confirmation is required before the change is applied.`);
    result.effectKind = "plan_change";
    result.effectData = { newPlan: targetPlan, charge: diff };
    result.proposedAction = `Change plan to ${targetPlan} (pro-rated charge $${diff.toFixed(2)})`;
    add("plan-propose", "Plan + propose change", "propose_plan_change", "done", `Propose the change to ${targetPlan} at $${diff.toFixed(2)} pro-rated. Human approval required. Run pauses for approval.`);
    return result;
  }
  const credit = Math.abs(diff);
  add("validate", "Eligibility + price comparison", "compare_plans", "done", `${calc} The cheaper target plan means the customer is owed a credit, not a charge. Customer confirmation is required before the change is applied.`);
  result.proposedCredit = credit;
  result.effectKind = "plan_change";
  result.effectData = { newPlan: targetPlan, credit };
  result.proposedAction = `Change plan to ${targetPlan} (pro-rated credit $${credit.toFixed(2)})`;
  add("plan-propose", "Plan + propose change", "propose_plan_change", "done", `Propose the change to ${targetPlan} with a $${credit.toFixed(2)} pro-rated credit. Human approval required. Run pauses for approval.`);
  return result;
}
function planRetention(state, _c, customer, result, add, opts = {}) {
  const g = stairGround(state, "retention save offer churn", opts.liveLeafByQuery);
  if (!g.leaf) {
    add("stair-ground", "STAIR policy grounding", "stair_retrieve", "failed", "No section covers save offers.");
    result.failureReason = "No grounding section found for retention save offers.";
    return result;
  }
  result.citation = `${g.leaf.path} ${g.leaf.section}`;
  add("stair-ground", "STAIR policy grounding", "stair_retrieve", "done", `Grounded in ${g.leaf.path} ${g.leaf.section}.`, { citation: result.citation });
  const signals = [customer.status === "suspended" ? "suspended account" : null, customer.balance > 0 ? "outstanding balance" : null].filter(Boolean);
  if (signals.length < 2) {
    add("validate", "Churn-risk check", "assess_churn_risk", "failed", `Only ${signals.length} churn-risk signal(s) found (${signals.join(", ") || "none"}). Two are required for a save offer. Run stopped.`);
    result.failureReason = "Not enough churn-risk signals for a save offer.";
    return result;
  }
  add("validate", "Churn-risk check", "assess_churn_risk", "done", `Churn-risk confirmed: ${signals.join(" + ")}. Eligible for a save offer.`);
  result.proposedCredit = RETENTION_CREDIT_USD;
  result.effectKind = "retention_offer";
  result.effectData = { amount: RETENTION_CREDIT_USD };
  result.proposedAction = `Apply a $${RETENTION_CREDIT_USD.toFixed(2)} goodwill credit and reactivate the account`;
  add("plan-propose", "Plan + propose save offer", "propose_save_offer", "done", `Propose a $${RETENTION_CREDIT_USD.toFixed(2)} goodwill credit and account reactivation. Human approval required. Run pauses for approval.`);
  return result;
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
function groundingQueryForCaseType(caseType) {
  switch (caseType) {
    case "duplicate_charge":
      return "duplicate charge credit policy";
    case "provisioning":
      return "new line activation provisioning";
    case "outage":
      return "network outage triage diagnose";
    case "plan_change":
      return "plan upgrade price premium starter";
    case "retention":
      return "retention save offer churn";
    default:
      return null;
  }
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

// src/lib/agent.ts
var TRANSITIONS = {
  INTAKE: ["RETRIEVE_360", "FAILED"],
  // RETRIEVE_360 → VALIDATE is the fail-fast path: a case type with no
  // agent workflow (e.g. roaming) has nothing to ground, so the run fails
  // at validation instead of grounding. It never skips ahead to PROPOSE
  // or EXECUTE — only to FAILED.
  RETRIEVE_360: ["GROUND", "VALIDATE", "FAILED"],
  GROUND: ["VALIDATE", "FAILED"],
  VALIDATE: ["PROPOSE", "FAILED"],
  PROPOSE: ["AWAITING_APPROVAL", "FAILED"],
  AWAITING_APPROVAL: ["EXECUTE", "REJECTED", "FAILED"],
  EXECUTE: ["VERIFY", "FAILED"],
  VERIFY: ["DONE", "FAILED"],
  DONE: [],
  FAILED: [],
  REJECTED: []
};
var STEP_TO_STATE = {
  "intake": "INTAKE",
  "retrieve-360": "RETRIEVE_360",
  "stair-ground": "GROUND",
  "validate": "VALIDATE",
  "diagnose": "VALIDATE",
  "credit-check": "VALIDATE",
  "order": "PROPOSE",
  "plan-propose": "PROPOSE",
  "execute": "EXECUTE",
  "notify": "EXECUTE",
  "close-verify": "VERIFY"
};
var STATUS_TO_STATE = {
  awaiting_approval: "AWAITING_APPROVAL",
  completed: "DONE",
  failed: "FAILED",
  rejected: "REJECTED"
};
function legalTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}
function stateForStep(stepId) {
  return STEP_TO_STATE[stepId] ?? null;
}
function stateTraceForRun(run) {
  const states = [];
  for (const step of run.steps) {
    const state = stateForStep(step.id);
    if (state && states[states.length - 1] !== state) states.push(state);
  }
  const terminal = STATUS_TO_STATE[run.status];
  if (terminal && states[states.length - 1] !== terminal) states.push(terminal);
  if (states.length === 0) states.push("INTAKE");
  if (states.includes("EXECUTE") && !states.includes("AWAITING_APPROVAL")) {
    states.splice(states.indexOf("EXECUTE"), 0, "AWAITING_APPROVAL");
  }
  if (states[states.length - 1] === "REJECTED" && !states.includes("AWAITING_APPROVAL")) {
    states.splice(states.length - 1, 0, "AWAITING_APPROVAL");
  }
  const invalidTransitions = [];
  for (let i = 0; i < states.length - 1; i++) {
    if (!legalTransition(states[i], states[i + 1])) invalidTransitions.push([states[i], states[i + 1]]);
  }
  return { states, current: states[states.length - 1], valid: invalidTransitions.length === 0, invalidTransitions };
}

// src/lib/redact.ts
var EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
var PHONE_RE = /(\+?1[\s.-]?)?(\(\d{3}\)\s?|\d{3}[\s.-]?)\d{3}[\s.-]?\d{4}/g;
function maskEmail(email) {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}
function maskPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  const last4 = digits.slice(-4);
  return `(***) ***-${last4}`;
}
function redactPII(text) {
  if (!text) return text;
  return text.replace(EMAIL_RE, (m) => maskEmail(m)).replace(PHONE_RE, (m) => maskPhone(m));
}

// api-src/run-case.ts
var GROQ_MODEL2 = "openai/gpt-oss-120b";
function groundingQueries(caseType) {
  const first = groundingQueryForCaseType(caseType);
  if (!first) return [];
  if (caseType === "outage") return [first, "outage service credit"];
  return [first];
}
async function handler(req, res) {
  const runId = `RUN-${Date.now().toString(36)}${Math.floor(Math.random() * 1e3).toString(36)}`;
  const traceId = `TRC-${Date.now().toString(36)}${Math.floor(Math.random() * 16777215).toString(36)}`;
  const t0 = Date.now();
  try {
    if (req.method !== "POST") {
      jsonError(res, 405, "Method not allowed. Use POST.");
      return;
    }
    if (!enforceRateLimit(req, res)) return;
    const body = req.body ?? {};
    const c = body.case;
    if (!c || !c.id || !c.customerId) {
      jsonError(res, 400, "Body must include case { id, customerId, type, amount, idempotencyKey }.");
      return;
    }
    const state = {
      customers: body.customers ?? [],
      ledger: body.ledger ?? [],
      usage: body.usage ?? [],
      tickets: body.tickets ?? [],
      cases: body.cases ?? [c],
      runs: [],
      docs: body.docs ?? [],
      pipelines: [],
      pipelineRuns: [],
      evalRuns: [],
      audit: [],
      notifications: [],
      seededAt: "",
      orders: body.orders ?? [],
      stairTrees: body.stairTrees ?? []
    };
    let liveLlm = "off";
    let liveLeafByQuery = {};
    let liveSummary = null;
    if (body.live_llm === true) {
      try {
        const groq = GroqClient.fromEnv();
        const leaves = (state.stairTrees ?? []).flatMap((t) => t.leaves);
        for (const query of groundingQueries(c.type)) {
          liveLeafByQuery[query] = await groq.pickLeaf(query, leaves);
        }
        liveLlm = "groq";
      } catch (e) {
        liveLlm = "unavailable, deterministic fallback";
        liveLeafByQuery = {};
      }
    }
    const plan = planRun(state, c, { liveLeafByQuery, liveLlm, liveSummary });
    if (liveLlm === "groq" && !plan.failureReason && plan.proposedAction) {
      try {
        const groq = GroqClient.fromEnv();
        liveSummary = await groq.draftSummary(
          `${c.id} (${c.type}): ${c.description ?? ""}`,
          plan.citation ?? "",
          plan.proposedAction
        );
        plan.liveSummary = liveSummary;
      } catch {
        liveSummary = null;
      }
    }
    const steps = plan.steps.map((s) => ({ ...s, detail: redactPII(s.detail) }));
    const agentStateTrace = stateTraceForRun({
      id: runId,
      caseId: c.id,
      traceId,
      startedAt: (/* @__PURE__ */ new Date()).toISOString(),
      status: plan.failureReason ? "failed" : "awaiting_approval",
      steps: plan.steps.map((s) => ({ ...s, ms: 0, status: s.status })),
      proposedCredit: plan.proposedCredit,
      creditApplied: null,
      agentMs: null,
      idempotencyKey: c.idempotencyKey
    });
    res.status(200).json({
      runId,
      traceId,
      durationMs: Date.now() - t0,
      caseId: c.id,
      status: plan.failureReason ? "failed" : "awaiting_approval",
      failureReason: plan.failureReason,
      proposedCredit: plan.proposedCredit,
      citation: plan.citation,
      steps,
      agentStateTrace,
      liveLlm,
      liveLeafPicks: liveLeafByQuery,
      liveSummary,
      llmModel: liveLlm === "groq" ? GROQ_MODEL2 : null,
      audit: {
        id: `AUD-${runId.slice(4)}`,
        at: (/* @__PURE__ */ new Date()).toISOString(),
        actor: "agent",
        action: plan.failureReason ? "run_failed" : "awaiting_approval",
        detail: redactPII(plan.failureReason ?? `Plan proposed for ${c.id}`),
        // Staff accountability (backend only, never rendered on a screen):
        // demo mode has no signed-in operator, so the single labelled id.
        operatorId: "demo-operator",
        runId,
        durationMs: Date.now() - t0,
        traceId
      },
      note: "Planning only. A credit is posted only after human approval in the app; this endpoint moves no money."
    });
  } catch (e) {
    jsonError(res, 500, "Run failed", e instanceof Error ? e.message : String(e));
  }
}
export {
  handler as default
};
