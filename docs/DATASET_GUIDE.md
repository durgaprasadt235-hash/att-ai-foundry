# Bring your own dataset — first-call guide (for the director's team)

## The first call, in one paragraph

Nobody connects a live company system into someone else's working
environment on a first call — and nobody should. A live connection takes
**days to weeks** of real work (access, security review, mapping, testing).
So the first call runs on a **sample file your team brings**: export an
anonymised sample, upload it in the app's **Data** view, check the
validation report, and test the agent on *your* records in minutes. No
live connection, nothing leaves the browser, no company data touches our
environment.

## What a good first-call sample looks like

- **10–20 customers**, a mix of plans (Starter / Premium / Family Share /
  Business Elite) and statuses (mostly active, 1 suspended, 1 closed).
- **3–4 ledger entries per customer** (monthly plan, device installment,
  one fee or payment) — balances must reconcile (see below).
- **A few known duplicates**: 2–3 customers charged the same amount twice
  within 7 days under different invoice numbers. These are the billing
  journey's test cases — the agent finds them and proposes the credit.
- **2–3 cases per journey** you want to see: billing dispute, service
  provisioning, network outage, plan change, retention. Include at least
  one case that *should* fail (suspended account, no duplicate, not
  enough churn signals) — a system that only ever succeeds is not
  demonstrating anything.
- **Your real policy wording** for the 2–3 policies that matter most
  (duplicate billing, outage credit, plan change). The agent grounds
  itself in exactly what you write — if it is not in the file, the agent
  refuses rather than guessing.

## How to export it

Export from your CRM / billing / usage systems into either format:

**Option A — one JSON file** (same shape as `test-data.json` in this repo):
`customers`, `ledger`, `usage`, `tickets` (optional), `cases`,
`docs` (optional), `stairTrees` (optional).

**Option B — one CSV per table**: `customers.csv`, `ledger.csv`,
`usage.csv`, `cases.csv` (required), `tickets.csv` (optional). Policy
docs and STAIR trees are JSON-only. Headers are fixed — download the
templates from the **Data** view (`dataset-template.json`,
`customers.csv`, `ledger.csv`, `usage.csv`, `cases.csv`, `tickets.csv`)
and replace the rows.

### Columns

| Table | Columns |
|---|---|
| customers | `id, name, account, phone, email, plan, status, since, balance, city` — status is `active` / `suspended` / `closed` |
| ledger | `id, customerId, invoice, date, service, amount, kind, status` — kind is `charge` / `credit` / `payment`; status is `posted` / `reversed`; **amounts are positive magnitudes — kind decides the sign** (charge adds to the balance, credit and payment subtract; D7 reconciles on that rule) |
| usage | `id, customerId, month, dataGb, minutes, sms` |
| cases | `id, customerId, type, title, description, amount, status, createdAt, idempotencyKey` — type is `duplicate_charge` / `plan_change` / `roaming_dispute` / `provisioning` / `outage` / `retention` / `other` |
| tickets | `id, customerId, date, subject, status` — `open` / `resolved` |

## Anonymise it first (do this before the call)

Real customer data must never be in a sample file. Replace, don't just delete:

- **Names** → `Sample Customer 1`, `Sample Customer 2`, …
- **Phones** → `(555) 010-0001`, `(555) 010-0002`, … (the 555 range is
  reserved for fictional use)
- **Emails** → `customer-1@example.com`, `customer-2@example.com`, …
- **Account numbers** → `ACC-900001`, `ACC-900002`, …
- **Keep the money real**: invoice numbers, amounts, dates, plans and
  balances should be the true values (anonymised ids only). The agent's
  whole job is arithmetic on those numbers — fake amounts prove nothing.
- **Keep the relationships**: a case's `customerId` must exist in
  `customers`, a ledger entry's `customerId` must exist too, and every
  customer's **balance must equal the sum of their posted ledger
  amounts with kind-based signs** (amounts are positive magnitudes:
  charges add, credits and payments subtract). The validator checks
  this to the cent. If a balance doesn't reconcile, the cleanser
  corrects it on load — the ledger is the source of truth — and lists
  the correction in the cleansing report. It is never corrected
  silently.

## Upload it on the call (2 minutes)

A file uploads anyway — raw or cleansed, that is the process. Raw
data goes through automated cleansing and comes out as a
production-ready file. Nothing about the upload is a test you can
fail: the report tells you what was found, the cleanser fixes what
can be fixed deterministically, and what cannot be fixed is
quarantined and listed — never guessed, never silently dropped.

1. Open the app → **Data** view.
2. Select your `.json` file, or all of your `.csv` files at once.
3. Read the **validation report** — it is a pre-check, not a gate:
   - **Issues are listed, not blocking.** The report names the exact
     record and rule (duplicate id, unknown customer, balance
     mismatch). They are what the cleanser will fix or quarantine.
   - **Warnings don't block.** Duplicate charges found, suspended
     accounts with a balance, a case amount with no matching ledger
     entry — these are shown so you know what the agent will do with
     them, not hidden. They are kept in the cleansed file.
   - **Auto-filled fields are listed** (a missing case status becomes
     `open`, a missing idempotency key is generated). Nothing is filled
     silently.
4. Click **Load raw & cleanse automatically**. The cleanser runs
   (rules CL1–CL8 below) and the **cleansed dataset loads** — the
   Dashboard, Cases, Medallion and Pipelines all recompute from it.
   Run a case, approve it, watch the balance change.
5. Read the **cleansing report** and take the production-ready file
   with you: **Download production-ready dataset (.json)** (same shape
   as `test-data.json`, ready to hand to the fulfilment team or use as
   a new seed), or the per-table `.csv` files. The downloaded file
   passes validation with 0 errors — the cleanser re-validates before
   it returns anything.
6. **Reset to original dataset** restores the built-in seed at any time.
   Your file stays in the browser only — it is stored in localStorage
   like the rest of the app state, never sent to a server, and never
   written into the seed files. The raw file on your disk is never
   modified either — cleansing produces a separate, new file.

### The cleansing rules (CL1–CL8)

Deterministic, one rule per problem — the browser cleanser
(`src/lib/cleanse.ts`) and the command-line cleanser
(`server/cleanse.py`) implement the same rules with the same
numbering. Every correction and quarantine is listed in the
cleansing report.

| Rule | Problem | What happens |
|---|---|---|
| CL1 | Duplicate id (D3) — in any table, or a STAIR leaf id repeated across trees | Keep the first occurrence, quarantine the rest |
| CL2 | Invalid record (D4/D5) — missing/invalid required field, unknown enum value | Quarantine the record. Nothing is guessed |
| CL3 | Dangling reference (D6) — ledger / usage / ticket / case naming an unknown customer | Quarantine the referencing record (including records of a quarantined customer) |
| CL4 | Balance mismatch (D7) | Recompute the balance from the kept posted ledger entries (ledger is the source of truth) and record old → new |
| CL5 | Zero-amount ledger entry (D10) | Kept — it contributes $0.00. Noted |
| CL6 | Suspended customer with a balance (D11) | Kept — Silver quarantines it at run time. Noted |
| CL7 | Duplicate charges (D9) | Kept — they drive the billing journey. Noted |
| CL8 | Anything still invalid after CL1–CL7 | Quarantined, never guessed; the cleansed tables are re-validated, and if they still fail the cleanse is refused with the remaining errors listed |

What can never be cleansed: a structurally unusable file (a required
table missing or not an array, a CSV that cannot be parsed), a file
with no customers at all (or no valid customers left after
quarantining), and a file over 5 MB (D12 — bring an anonymised sample,
not a production dump). In those cases nothing loads, and the report
says why.

You can check a file before the call from the command line — the same
rules, same numbering:

```bash
python3 server/validate_dataset.py your-sample.json
python3 server/validate_dataset.py --csv-dir ./your-sample-csvs
# Cleanse it to a production-ready file:
python3 server/cleanse.py your-sample.json your-sample.cleansed.json
python3 server/cleanse.py --csv-dir ./your-sample-csvs your-sample.cleansed.json
```

Exit code 0 = valid / cleansed. The Python validator
(`server/validate_dataset.py`) and the browser validator
(`src/lib/dataset.ts`) implement the same rules D1–D12, and the Python
cleanser (`server/cleanse.py`) and the browser cleanser
(`src/lib/cleanse.ts`) implement the same rules CL1–CL8.

## What happens after the first call

| Step | What it is | Honest timeline |
|---|---|---|
| 1. First call | Sample file uploaded, agent tested on your records | Minutes, on the call |
| 2. Sample review | Your team checks the validation report, the agent's traces, and the audit trail against your own records | Same week |
| 3. Access + security | carrier security review, Entra ID app registration, API credentials issued, network access agreed | Days to weeks — owned by the fulfilment team, not by this demo |
| 4. Live adapter | Point `DATASOURCE=att` at the real CRM / billing / usage APIs (`ATT_API_BASE_URL` + `ATT_API_KEY`); the adapter maps your payloads onto the same Customer / Ledger / Usage types the sample used | Days, once access exists — no agent code changes |
| 5. Production database | Provision Postgres, set `DATABASE_URL`, move state out of the browser | Days |
| 6. Auth | Enable the login gate (`AUTH_ENABLED=true`) with the Entra ID registration | Days |
| 7. Scale validation | Run the Medallion pipelines against real volumes; the petabyte-scale design (partitioning, watermarks, idempotency-key dedup) is architectural until it is measured at volume | Weeks, with your data team |

The sample file is not a shortcut past any of that — it is the way to
decide, on the first call, whether steps 3–7 are worth doing at all.
