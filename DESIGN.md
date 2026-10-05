# MeterFlow System Design Document

**Phase 1 Gate Architecture Document**  
**Project**: MeterFlow — High-Precision SaaS Usage Metering & Billing Engine  
**Version**: 1.0.0  
**Author**: Akash Kodihithlu  

---

## 1. Problem Statement & Scope

Modern AI and cloud SaaS systems require billing backends that answer three fundamental questions reliably:
1. **How much has a customer used?** (Tracking API calls, input tokens, cached tokens, output tokens, reasoning tokens).
2. **Have they reached their plan limits?** (Strict quota enforcement at exact boundaries before billable work executes).
3. **How much should they pay?** (Precise multi-tier pricing calculation using integer money math with zero floating-point drift).

In distributed web environments, network timeouts and retries frequently lead to double-metering, while out-of-order webhook delivery causes state desynchronization. MeterFlow solves these problems using **exactly-once idempotency guarantees**, **atomic transactional quota checks**, **integer-denominated pricing math**, and **cryptographically-verified Stripe subscription synchronization**.

### Explicit Non-Goals
- **Live Credit Card Processing / Automated Invoicing**: MeterFlow focuses strictly on test-mode subscription synchronization, usage aggregation, and quota gating. Full automated ACH/wire reconciliation and automated PDF invoice dispatching with tax jurisdictions (e.g. Avalara) are explicitly out of scope for the core engine.

---

## 2. System Architecture & Component Layers

MeterFlow follows a clean layered architecture with strict boundary validation:

```
                                      +------------------------------------+
                                      |     Client / Evaluator / Agent     |
                                      +-----------------+------------------+
                                                        |
                                                        v
                                      +------------------------------------+
                                      |    Boundary Validation Middleware  |
                                      |    - Request Payload Sanity (4xx)  |
                                      |    - Idempotency-Key Header Check  |
                                      +-----------------+------------------+
                                                        |
                            +---------------------------+---------------------------+
                            |                                                       |
                            v                                                       v
            +-------------------------------+                       +-------------------------------+
            |  POST /api/v1/generate        |                       |  POST /webhooks/stripe        |
            |  (Billable Metering Action)   |                       |  (Stripe Event Ingestion)     |
            +---------------+---------------+                       +---------------+---------------+
                            |                                                       |
                            v                                                       v
            +-------------------------------+                       +-------------------------------+
            |         MeterService          |                       |         StripeService         |
            |  1. Check Idempotency Store   |                       |  1. Verify Signature (400)    |
            |     (Hit? Return Cached)      |                       |  2. Check Event Replay (Dedup)|
            |  2. Check Quota Balance       |                       |  3. Apply Subscription State  |
            |     (Exceeded? Return 429/402)|                       |     (Free <-> Pro)            |
            |  3. Atomic Event Insert       |                       +---------------+---------------+
            +---------------+---------------+                                       |
                            |                                                       |
                            +---------------------------+---------------------------+
                                                        |
                                                        v
                                      +------------------------------------+
                                      |  Data Layer (SQLite WAL / Postgres)|
                                      |  - tenants                         |
                                      |  - plans                           |
                                      |  - subscriptions                   |
                                      |  - usage_events                    |
                                      |  - idempotency_records             |
                                      |  - webhook_events                  |
                                      +-----------------+------------------+
                                                        ^
                                                        |
                                      +-----------------+------------------+
                                      |     Background Worker Service      |
                                      |  - Hourly/Daily Rollup Aggregation |
                                      |  - 80% & 100% Quota Alerts         |
                                      |  - Nightly Stripe Reconciliation   |
                                      +------------------------------------+
```

---

## 3. Data Model & Relational Schema

### Database Schema (SQLite / PostgreSQL)

1. **`tenants`**
   - `id`: `TEXT PRIMARY KEY` (UUID / slug, e.g. `tenant_acme_corp`)
   - `name`: `TEXT NOT NULL`
   - `email`: `TEXT NOT NULL`
   - `stripe_customer_id`: `TEXT UNIQUE`
   - `created_at`: `INTEGER NOT NULL` (Unix epoch milliseconds)
   - `updated_at`: `INTEGER NOT NULL`

2. **`plans`**
   - `id`: `TEXT PRIMARY KEY` (`free`, `pro`)
   - `name`: `TEXT NOT NULL`
   - `monthly_price_cents`: `INTEGER NOT NULL` (e.g., Free = 0, Pro = 4900)
   - `api_calls_quota`: `INTEGER NOT NULL` (Free = 1,000, Pro = 50,000)
   - `ai_tokens_quota`: `INTEGER NOT NULL` (Free = 100,000, Pro = 5,000,000)
   - `is_active`: `INTEGER NOT NULL DEFAULT 1`

3. **`subscriptions`**
   - `id`: `TEXT PRIMARY KEY`
   - `tenant_id`: `TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`
   - `plan_id`: `TEXT NOT NULL REFERENCES plans(id)`
   - `stripe_subscription_id`: `TEXT UNIQUE`
   - `status`: `TEXT NOT NULL` (`active`, `past_due`, `canceled`, `incomplete`)
   - `current_period_start`: `INTEGER NOT NULL`
   - `current_period_end`: `INTEGER NOT NULL`
   - `created_at`: `INTEGER NOT NULL`
   - `updated_at`: `INTEGER NOT NULL`
   - *Index*: `idx_subscriptions_tenant (tenant_id, status)`

4. **`usage_events`**
   - `id`: `TEXT PRIMARY KEY`
   - `tenant_id`: `TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`
   - `event_type`: `TEXT NOT NULL` (`api_call`, `ai_generation`)
   - `api_calls_count`: `INTEGER NOT NULL DEFAULT 1`
   - `input_tokens`: `INTEGER NOT NULL DEFAULT 0`
   - `cached_input_tokens`: `INTEGER NOT NULL DEFAULT 0`
   - `output_tokens`: `INTEGER NOT NULL DEFAULT 0`
   - `reasoning_tokens`: `INTEGER NOT NULL DEFAULT 0`
   - `total_tokens`: `INTEGER NOT NULL DEFAULT 0`
   - `cost_microcents`: `INTEGER NOT NULL DEFAULT 0`
   - `idempotency_key`: `TEXT UNIQUE NOT NULL`
   - `timestamp`: `INTEGER NOT NULL`
   - *Index*: `idx_usage_tenant_period (tenant_id, timestamp)`
   - *Index*: `idx_usage_idempotency (idempotency_key)`

5. **`idempotency_records`**
   - `idempotency_key`: `TEXT PRIMARY KEY`
   - `tenant_id`: `TEXT NOT NULL`
   - `request_hash`: `TEXT NOT NULL`
   - `status_code`: `INTEGER NOT NULL`
   - `response_headers`: `TEXT NOT NULL` (JSON stringified)
   - `response_body`: `TEXT NOT NULL` (JSON stringified)
   - `created_at`: `INTEGER NOT NULL`

6. **`webhook_events`**
   - `stripe_event_id`: `TEXT PRIMARY KEY`
   - `event_type`: `TEXT NOT NULL`
   - `payload`: `TEXT NOT NULL`
   - `status`: `TEXT NOT NULL` (`processed`, `ignored`, `failed`)
   - `processed_at`: `INTEGER NOT NULL`

7. **`quota_alerts`**
   - `id`: `TEXT PRIMARY KEY`
   - `tenant_id`: `TEXT NOT NULL`
   - `threshold`: `INTEGER NOT NULL` (80 or 100)
   - `metric`: `TEXT NOT NULL` (`api_calls` or `ai_tokens`)
   - `period_start`: `INTEGER NOT NULL`
   - `alerted_at`: `INTEGER NOT NULL`
   - *Index*: `idx_quota_alerts (tenant_id, metric, threshold, period_start)`

---

## 4. Plans & Quota Definitions

| Plan | Monthly Fee | API Calls Quota | AI Tokens Quota | Overages |
| :--- | :--- | :--- | :--- | :--- |
| **Free** | $0.00 (0¢) | 1,000 calls / month | 100,000 tokens / month | Hard cap: 429 when quota exceeded, 402 for upgrade |
| **Pro**  | $49.00 (4,900¢) | 50,000 calls / month | 5,000,000 tokens / month | Enterprise priority, elastic scale |

### Quota Enforcement Rules:
- **Boundary Semantics**:
  - If `current_usage + requested_usage <= quota_limit`: The request is **Allowed** and logged.
  - Exactly at 1,000 / 1,000: Allowed.
  - At 1,001 / 1,000: Blocked.
- **Status Codes**:
  - `429 Too Many Requests`: Usage quota for the active plan is exhausted. Includes `Retry-After` header specifying seconds until monthly reset.
  - `402 Payment Required`: The subscription is lapsed, past due, or the tenant is on Free tier attempting to exceed free thresholds without a payment method on file.

---

## 5. Token Pricing Rules & Money Math

To eliminate floating-point approximation bugs (`0.1 + 0.2 !== 0.3`), all financial figures are calculated in **integer micro-units** (1 USD = 1,000,000 micro-USD = 100 cents = 100,000,000 microcents):

| Token Category | Rate per 1,000,000 Tokens | Microcents per Single Token | Pricing Rule Logic |
| :--- | :--- | :--- | :--- |
| **Fresh Input Tokens** | $1.50 | 150 µ¢ | Standard base model ingestion rate |
| **Cached Input Tokens** | $0.375 | 37.5 µ¢ (scaled as 375 nanodollars) | 75% cache discount |
| **Output Tokens** | $6.00 | 600 µ¢ | Model text generation rate |
| **Reasoning Tokens** | $6.00 | 600 µ¢ | Billed at identical rate to output tokens |
| **API Call Unit** | $0.001 / call | 100 µ¢ | Infrastructure base metering |

### Formula:
$$\text{Cost}(\mu\text{c}) = (\text{input} \times 150) + (\text{cached} \times 37.5) + ((\text{output} + \text{reasoning}) \times 600) + (\text{calls} \times 100)$$
Total customer-facing cents is computed by exact integer division: $\lfloor \text{Cost} / 1,000,000 \rfloor$.

---

## 6. Idempotency & Deduplication Strategy

Every billable call requires an `Idempotency-Key` header (UUID or client-supplied unique string).
1. When a request arrives, MeterFlow initiates an atomic transaction.
2. Checks `idempotency_records` table:
   - **Found**: Transaction is committed/closed immediately without re-executing logic or adding usage. The saved response (status code and body) is returned to the caller with header `X-Cache-Lookup: HIT`.
   - **Not Found**:
     - Quota is verified.
     - If quota passes: Usage event is inserted, idempotency record is persisted with the response data.
     - If quota fails (429/402): Idempotency record is persisted with the 429/402 response to guarantee consistent rejection on retries.

---

## 7. Stripe Webhook & Synchronization Protocol

1. **Endpoint**: `POST /webhooks/stripe`
2. **Signature Verification**: Uses raw request buffer with `stripe.webhooks.constructEvent(rawBody, sig, secret)`. Any signature mismatch or tampering returns **HTTP 400 Bad Request** immediately.
3. **Deduplication**: Inserts Stripe event ID into `webhook_events`. If duplicate `stripe_event_id` is received, returns **HTTP 200 OK** `{ "received": true, "duplicate": true }` without repeating side effects.
4. **Events Handled**:
   - `checkout.session.completed`: Upgrades tenant from Free to Pro, stores `stripe_customer_id` and `stripe_subscription_id`.
   - `customer.subscription.updated`: Synchronizes renewal dates, plan status (`active`, `past_due`).
   - `customer.subscription.deleted`: Reverts tenant plan to Free.
