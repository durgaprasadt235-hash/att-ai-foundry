# Deployment runbook — AT&T AI Foundry

How to deploy the prototype, connect it, and prove it works. Nothing here
requires a secret to be written down: keys are set as environment
variables, never in code or git.

## 1. Deploy on Vercel (the demo link)

1. Push the repo to GitHub (`durgaprasadt235-hash/att-ai-foundry`, `main`).
2. In Vercel: **Add New → Project → Import** the repo. Framework: Vite.
   `vercel.json` already sets the build (`npm run build`) and output (`dist`).
   **Do not change the SPA fallback:** it excludes `/api/*`, so the fallback
   can never swallow an API route (that exact bug broke every API call once).
3. Set environment variables (Project → Settings → Environment Variables,
   **Production + Preview**):

   | Variable | Value | Notes |
   |----------|-------|-------|
   | `GROQ_API_KEY` | key from console.groq.com | Optional. Live-LLM mode only. Without it the app is deterministic and says so. |
   | `DATASOURCE` | `seed` | Keep `seed` until the AT&T API is connected. |
   | `ATT_API_BASE_URL` | (fulfilment team) | Only when `DATASOURCE=att`. |
   | `ATT_API_KEY` | (fulfilment team) | Only when `DATASOURCE=att`. |
   | `AUTH_ENABLED` | `false` | Keep `false` until the Entra ID app exists. |
   | `AUTH_CLIENT_ID` / `AUTH_ISSUER_URL` | (fulfilment team) | Only when `AUTH_ENABLED=true`. |
   | `DATABASE_URL` | (reserved) | Not read by any code yet. Do not set it expecting a live DB. |

4. Deploy. Vercel auto-redeploys on every push to `main`.
5. **Redeploy after changing an env var:** Vercel does not pick up a new
   variable until the next deployment (Deployments → ⋯ → Redeploy).

## 2. Smoke checks (run these after every deploy)

```bash
BASE=https://<your-app>.vercel.app

# 1. Health — honest flags. llm_live is true ONLY after a real Groq call.
curl -s $BASE/api/health | python3 -m json.tool
# Expect: ok true, engine "deterministic-ts", datasource.mode "seed",
# llm_configured false (until the key is set), llm_live false,
# llm_circuit "closed", auth.enabled false, realAttSystems false.

# 2. CASE-1001 plan — POST the seeded state (or create a case in the UI).
#    In the UI: Dashboard → Create a case → Create case & run agent →
#    approve → $87.40 credit posts. (CASE-1001 is one of the seeded
#    caseload records, not a demo button — the intake flow creates a fresh
#    case every time.)
#    Via API: POST /api/run-case with { case: <CASE-1001>, customers, ledger,
#    usage, tickets, docs, stairTrees } from the seed. Expect
#    status "awaiting_approval", proposedCredit 87.4, runId + traceId +
#    durationMs, and agentStateTrace ending in AWAITING_APPROVAL.

# 3. Medallion counts — Medallion tab (or GET /medallion on the FastAPI backend).
#    Expect: Bronze 106 = Silver passed 101 + quarantined 5;
#    Gold reconciled ledger 63 entries, $2,318.95.
```

If any check fails, the app says why in the response (JSON `{ error, reason }`,
never an HTML 500). Do not "fix" a failing smoke check by changing the
expected numbers — the numbers come from the seed and the engine.

## 3. Run the whole stack with Docker (one command)

```bash
docker compose up            # API on :8000, web on :4173 (proxies /api to the API)
docker compose --profile with-db up   # also starts Postgres (reserved — see below)
```

Smoke checks for the Docker stack:

```bash
curl -s localhost:8000/health | python3 -m json.tool   # FastAPI health
curl -s localhost:8000/metrics | python3 -m json.tool  # Bronze 106, Gold ledger 63
curl -s localhost:4173/ | head -c 200                    # web serves the app
```

The `db` service is **reserved**: Postgres runs so the fulfilment team can
wire it, but `DATABASE_URL` is not consumed by any code yet and `/health`
reports "configured but not yet wired" rather than pretending the database
is live. Wiring the store is a fulfilment-team step (see §5).

## 4. Fulfilment-team onboarding — 3 steps

These are the only three connections between this prototype and AT&T's
real systems. Each is built, each fails honestly until connected, and each
is visible in the Dashboard's Production readiness panel.

### Step 1 — Live AT&T data (`att` datasource mode)

1. The fulfilment team exposes five read endpoints on `ATT_API_BASE_URL`,
   each returning a JSON array (field names may be camelCase or snake_case —
   the adapter maps both; see `server/datasource.py:ATT_ENDPOINTS`):

   | Endpoint | Returns |
   |----------|---------|
   | `GET /customers` | CRM customers (`id`, `name`, `plan`, `status`, `balance`, …) |
   | `GET /ledger` | billing ledger (`id`, `customerId`, `invoice`, `amount`, `kind`, `status`) |
   | `GET /usage` | usage records (`id`, `customerId`, `month`, `dataGb`, `minutes`, `sms`) |
   | `GET /cases` | cases (`id`, `customerId`, `type`, `amount`, `idempotencyKey`) |
   | `GET /docs` | policy docs (`id`, `title`, `body`, `updated`) |

2. They issue a Bearer token (`ATT_API_KEY`) with read access to those five
   endpoints. Rotate it like any service credential.
3. Set `DATASOURCE=att`, `ATT_API_BASE_URL`, `ATT_API_KEY` (Vercel env vars
   or `.env` for Docker) and redeploy / restart.
4. Verify: `GET /datasource/status` — in `att` mode this really calls the
   AT&T API and reports `reachable` with a customer count, or `unreachable`
   with the reason. The app never falls back to seed data in `att` mode:
   a failed load is a visible error, not a quiet fake.
5. Records that cannot be mapped (missing `id`, missing `amount`, …) are
   rejected with a named error (`DatasourceError`) — the adapter never
   guesses a field.

### Step 2 — Live LLM (optional, already working)

1. Create a key at console.groq.com (free tier, no card).
2. Set `GROQ_API_KEY` (Vercel env var, Production + Preview) and redeploy.
3. Verify: `GET /api/health` — `llm_configured: true`; run a case with
   live LLM and watch `llm_live` become `true` (the probe caches for 60s).
   If the key is revoked or Groq is down, `llm_live` stays `false` and the
   runs complete deterministically — check `llm_circuit` too (`open` means
   the breaker tripped after 3 consecutive failures and is serving
   fallback for 60s).

### Step 3 — Database (reserved — wire it, don't just set the var)

1. Provision Postgres (the compose `db` service is a starting point:
   `docker compose --profile with-db up`).
2. Set `DATABASE_URL`. **Setting the var alone changes nothing today:**
   no code reads it yet, and `/health` says so honestly.
3. The wiring work (not done in this prototype): a server-side store for
   state (replacing browser localStorage), the idempotency-key unique
   constraint (replacing the in-memory `_executed_keys` store), and the
   durable event bus (replacing the in-memory feed). The seams are
   `server/datasource.py`, `server/app.py:execute_case`, and
   `server/events.py` — each is labelled in code.

## 5. Auth wiring (Entra ID) — step 4, when login is required

1. The fulfilment team registers the app in AT&T Entra ID (OAuth 2.0 /
   OpenID Connect) and provides the client id and issuer URL.
2. Set `AUTH_ENABLED=true`, `AUTH_PROVIDER=entra-id`,
   `AUTH_CLIENT_ID=<client id>`, `AUTH_ISSUER_URL=<issuer>`, redeploy.
3. Today the gate then shows a clearly-labelled placeholder (the OAuth
   callback handler is **not** implemented — the sign-in button is
   disabled and says so). The remaining work: implement the callback
   (`/auth/callback`), session handling, and the route guard, then remove
   the placeholder. Do not ship a "demo login" in its place.
4. Enabled **without** the client id / issuer, the app shows an honest
   "auth not configured" state and refuses sign-in. That is the intended
   behaviour, not a bug.

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/api/health` returns the app HTML | SPA fallback swallowing `/api/*` | Check `vercel.json` still excludes `api/` from the rewrite. |
| `llm_configured: true, llm_live: false` | Key set but no live call has succeeded (revoked key, Groq down, breaker open) | Check `llm_circuit`; verify the key in the Groq console; run a case with live LLM. |
| `att` mode: data loads fail | AT&T API unreachable / 401 / bad payload | Read the error (`DatasourceError` names the endpoint and status); fix the connection — the app will not fall back to seed. |
| Release button says BLOCKED | Eval suite below the 85% gate (or never run) | Read the named failed checks; fix the state they depend on (e.g. restore POL-001) and re-run the suite. |
| `docker compose up` fails on `web` | API not healthy yet | `web` waits for `api` health (`/health`); check `docker compose logs api`. |
| Startup exits with "Configuration error" | A REQUIRED var is missing for the selected mode | Read the message — it names the missing vars. Demo mode (`seed`, auth off) needs none. |
| 429 from the API | Demo-grade rate-limit guard tripped | Wait for `Retry-After` seconds. Production rate limiting belongs at the edge. |
