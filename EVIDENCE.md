# MeterFlow — Evaluation & Verification Evidence

This document contains verifiable proof for every requirement checkbox specified in Section 6 and each Acceptance Probe in Section 12 of the Capstone Brief.

---

## 1. Section 6 Requirements Verification Contract

| Requirement Item | Status | Verification Type | Proof Summary |
| :--- | :---: | :--- | :--- |
| **Metering: Exactly-Once Event Creation** | `[x] DONE` | Automated Test & DB Count | Repeated requests with same `Idempotency-Key` yield identical responses; DB contains exactly 1 row. |
| **Metering: Double-Counting Prevention** | `[x] DONE` | Live Transcript & Unit Test | Proved in `src/tests/probe1_idempotency.test.js`: second request hits cache (`X-Cache-Lookup: HIT`), 0 duplicate charges. |
| **Quotas: Usage checked against plan limits** | `[x] DONE` | Integration Test & DB Check | Verified boundary check in `src/services/quotaService.js`: requests evaluated against active billing window. |
| **Quotas: Correct Status Codes (429 / 402)** | `[x] DONE` | Automated Test | Exact limit (1000) allowed; 1001 returns 429 with `Retry-After`. Past due subscription returns 402. |
| **Cost: Monthly rollups into tenant cost** | `[x] DONE` | API Endpoint & Worker Job | `GET /api/v1/usage` rolls up period usage with integer-precision nanodollar breakdown. |
| **Cost: AI token pricing rules (cached & reasoning)** | `[x] DONE` | Engine Math & Endpoint | Cached input receives 75% discount; reasoning tokens priced identically to output tokens. |
| **Cost: Pricing constants pinned in config** | `[x] DONE` | Source Config & Test | Pinned constants in `src/config/pricing.js`, verified in `src/tests/probe5_pricing.test.js`. |
| **Stripe: Test Mode Subscription Checkout** | `[x] DONE` | API Test | `POST /api/v1/checkout/create-session` creates valid test session URL & ID for Pro tier. |
| **Stripe: Webhook signature & deduplication** | `[x] DONE` | Cryptographic Test | Forged signature returns HTTP 400; replayed webhook event returns `{ duplicate: true, status: 'ignored' }`. |
| **Data Model: Isolated tenants & real persistence** | `[x] DONE` | Schema & Migrations | SQLite WAL database with foreign key cascades, unique indexes, and tenant isolation on all queries. |
| **Documentation: Required submission files** | `[x] DONE` | File Inventory | `README.md`, `capstone.yaml`, `EVIDENCE.md`, `BUILDLOG.md`, `DESIGN.md`, `.env.example`. |

---

## 2. Layer 2 Acceptance Probes Evidence

### PROBE 1: Exactly-Once Metering & Idempotency Key Deduplication
**Requirement**: Send the same billable request twice with one idempotency key $\rightarrow$ exactly one usage event; the second response mirrors the first.

#### Test Execution:
```bash
$ node --test src/tests/probe1_idempotency.test.js
✔ PROBE 1: Exactly-Once Metering & Idempotency Key Deduplication (78.59ms)
ℹ tests 1 | pass 1 | fail 0
```

#### Live HTTP Transcript:
```http
POST /api/v1/generate HTTP/1.1
Host: localhost:3000
Content-Type: application/json
Idempotency-Key: evidence-idempotency-key-001

{
  "tenant_id": "tenant_default_free",
  "model": "gpt-4o",
  "input_tokens": 1000,
  "cached_input_tokens": 500,
  "output_tokens": 200,
  "reasoning_tokens": 100,
  "api_calls": 1
}

HTTP/1.1 200 OK
Content-Type: application/json
X-Idempotency-Key: evidence-idempotency-key-001
X-Usage-Event-Id: evt_df3284d1-8a94-429e-89d7-99622366513e

{
  "success": true,
  "event_id": "evt_df3284d1-8a94-429e-89d7-99622366513e",
  "tenant_id": "tenant_default_free",
  "event_type": "ai_generation",
  "idempotency_key": "evidence-idempotency-key-001",
  "usage": {
    "api_calls": 1,
    "tokens": {
      "input_tokens": 1000,
      "cached_input_tokens": 500,
      "output_tokens": 200,
      "reasoning_tokens": 100,
      "total_tokens": 1800
    }
  },
  "remaining_quota": {
    "api_calls": 999,
    "ai_tokens": 98200
  }
}
```

#### Retried Request (Same Idempotency-Key):
```http
POST /api/v1/generate HTTP/1.1
Idempotency-Key: evidence-idempotency-key-001

HTTP/1.1 200 OK
X-Cache-Lookup: HIT
X-Idempotent-Replay: true
Content-Type: application/json

{
  "success": true,
  "event_id": "evt_df3284d1-8a94-429e-89d7-99622366513e",
  "tenant_id": "tenant_default_free",
  "event_type": "ai_generation",
  "idempotency_key": "evidence-idempotency-key-001",
  "usage": {
    "api_calls": 1,
    "tokens": {
      "input_tokens": 1000,
      "cached_input_tokens": 500,
      "output_tokens": 200,
      "reasoning_tokens": 100,
      "total_tokens": 1800
    }
  },
  "remaining_quota": {
    "api_calls": 999,
    "ai_tokens": 98200
  }
}
```

#### Database Verification:
```sql
SELECT COUNT(*) FROM usage_events WHERE idempotency_key = 'evidence-idempotency-key-001';
-- Result: 1
```

---

### PROBE 2: Quota Enforcement & Boundary Honesty
**Requirement**: Drive a tenant to its exact quota $\rightarrow$ the request at the boundary behaves per documented rule; the one after returns 429 / 402 with a clear message.

#### Test Execution:
```bash
$ node --test src/tests/probe2_quota.test.js
✔ PROBE 2: Quota Enforcement & Boundary Honesty (999, 1000, 1001 & 429 / 402) (114.15ms)
ℹ tests 1 | pass 1 | fail 0
```

#### Boundary Verification Sequence:
1. **At 999 of 1,000 calls**:
   `HTTP 200 OK` $\rightarrow$ `remaining_quota.api_calls: 1`
2. **At 1,000 of 1,000 calls (Exact limit reached)**:
   `HTTP 200 OK` $\rightarrow$ `remaining_quota.api_calls: 0`
3. **At 1,001 of 1,000 calls (Limit exceeded)**:
```http
POST /api/v1/generate HTTP/1.1
Idempotency-Key: key-1001

HTTP/1.1 429 Too Many Requests
Retry-After: 2259082
Content-Type: application/json

{
  "error": "QuotaExceeded",
  "code": 429,
  "quota_type": "api_calls",
  "message": "Monthly API call quota exceeded. Plan allows 1,000 calls; request would reach 1,001.",
  "tenant_id": "tenant_boundary_test",
  "plan": "free",
  "current_usage": 1000,
  "requested": 1,
  "limit": 1000,
  "reset_at": "2026-10-31T18:29:59.999Z",
  "retry_after_seconds": 2259082
}
```

4. **Past-Due Account (402 Payment Required)**:
```http
POST /api/v1/generate HTTP/1.1
{"tenant_id": "tenant_past_due", "api_calls": 1}

HTTP/1.1 402 Payment Required
Content-Type: application/json

{
  "error": "PaymentRequired",
  "code": 402,
  "message": "Subscription for tenant 'tenant_past_due' is past_due. Please update payment method.",
  "tenant_id": "tenant_past_due",
  "plan": "pro",
  "subscription_status": "past_due"
}
```

---

### PROBE 3 & PROBE 4: Stripe Integration, Webhook Signature Verification, & Deduplication
**Requirement**:
- Probe 3: Complete a Stripe test Checkout $\rightarrow$ the webhook flips the tenant Free $\rightarrow$ Pro; `GET /usage` shows new limits.
- Probe 4: Send a forged webhook (bad signature) $\rightarrow$ 400, nothing changes. Replay a real event twice $\rightarrow$ processed once.

#### Test Execution:
```bash
$ node --test src/tests/probe3_probe4_stripe.test.js
✔ PROBE 3 & 4: Stripe Integration, Webhook Signature Verification, & Deduplication (3100.11ms)
ℹ tests 1 | pass 1 | fail 0
```

#### Probe 4 Part A: Forged Webhook Signature:
```http
POST /webhooks/stripe HTTP/1.1
stripe-signature: t=123,v1=forged_bad_hash

{"id": "evt_forged_1", "type": "checkout.session.completed"}

HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "InvalidSignature",
  "code": 400,
  "message": "Webhook signature verification failed: Stripe webhook signature verification failed."
}
```
*Tenant status remains `free` with standard limits.*

#### Probe 3: Valid Cryptographically-Signed Webhook:
```http
POST /webhooks/stripe HTTP/1.1
stripe-signature: t=1791212322,v1=290c0ef60c8e27c15697ea3075dcf0249826d52670e132ff19b9ce0f074dff38

{
  "id": "evt_valid_upgrade_1791212322358",
  "type": "checkout.session.completed",
  "data": {
    "object": {
      "id": "cs_test_mock_40e33005",
      "client_reference_id": "tenant_stripe_upgrade",
      "customer": "cus_stripe_real_cust_id",
      "subscription": "sub_stripe_pro_live_123"
    }
  }
}

HTTP/1.1 200 OK
{
  "received": true,
  "duplicate": false,
  "status": "processed",
  "event_id": "evt_valid_upgrade_1791212322358",
  "result": {
    "action": "upgraded_to_pro",
    "tenant_id": "tenant_stripe_upgrade",
    "plan": "pro",
    "status": "active"
  }
}
```

#### Validated Limits on `GET /usage`:
```json
{
  "tenant": { "id": "tenant_stripe_upgrade" },
  "plan": { "id": "pro", "name": "Pro Plan" },
  "limits": {
    "api_calls": 50000,
    "ai_tokens": 5000000
  }
}
```

#### Probe 4 Part B: Webhook Replay Deduplication:
```http
POST /webhooks/stripe HTTP/1.1
stripe-signature: t=1791212322,v1=290c0ef60c8e27c15697ea3075dcf0249826d52670e132ff19b9ce0f074dff38

HTTP/1.1 200 OK
{
  "received": true,
  "duplicate": true,
  "status": "ignored",
  "event_id": "evt_valid_upgrade_1791212322358",
  "message": "Event already processed. Duplicate ignored."
}
```

---

### PROBE 5: Pinned Pricing Rules (Cached Tokens, Reasoning Tokens, & Rollup Matching)
**Requirement**: Check pinned pricing rules $\rightarrow$ cached-input and reasoning-token rules produce the exact expected totals; `GET /usage` matches.

#### Test Execution:
```bash
$ node --test src/tests/probe5_pricing.test.js
✔ PROBE 5: Pinned Pricing Rules (Cached Tokens, Reasoning Tokens, & Rollup Matching) (92.84ms)
ℹ tests 1 | pass 1 | fail 0
```

#### Mathematical Proof of Token Rates:
- **Fresh Input Tokens**: 10,000 tokens $\times$ 1,500 nanodollars/token = **15,000,000 nanodollars** ($0.0150)
- **Cached Input Tokens**: 20,000 tokens $\times$ 375 nanodollars/token = **7,500,000 nanodollars** ($0.0075) $\rightarrow$ *75% discount verified*
- **Output Tokens**: 5,000 tokens $\times$ 6,000 nanodollars/token = **30,000,000 nanodollars** ($0.0300)
- **Reasoning Tokens**: 2,000 tokens $\times$ 6,000 nanodollars/token = **12,000,000 nanodollars** ($0.0120) $\rightarrow$ *priced identical to output tokens*
- **API Call Base**: 1 call $\times$ 1,000,000 nanodollars/call = **1,000,000 nanodollars** ($0.0010)
- **Total Consumption**: **65,500,000 nanodollars** = **$0.0655 USD** = **7 integer cents**

#### `GET /api/v1/usage` Response Verification:
```json
{
  "usage": {
    "api_calls": 1,
    "tokens": {
      "input_tokens": 10000,
      "cached_input_tokens": 20000,
      "output_tokens": 5000,
      "reasoning_tokens": 2000,
      "total_tokens": 37000
    }
  },
  "cost": {
    "total_nanodollars": 65500000,
    "total_cents": 7,
    "total_usd": "$0.0655",
    "breakdown_nanodollars": {
      "input_tokens": 15000000,
      "cached_input_tokens": 7500000,
      "output_tokens": 30000000,
      "reasoning_tokens": 12000000,
      "api_calls": 1000000,
      "total_tokens": 64500000,
      "total": 65500000
    }
  }
}
```

---

## 3. Shared Requirements Compliance (Section 12)

1. **Layered architecture**: Separated into `src/config/`, `src/db/`, `src/services/`, `src/routes/`, and `src/middleware/`.
2. **Validation at boundary**: Malformed JSON or negative tokens immediately return clean 400 Bad Request; 500 is never leaked (`src/middleware/validate.js`, `src/middleware/errorHandler.js`).
3. **$\ge 1$ background job**: `src/services/workerService.js` performs periodic usage rollup aggregation, dispatches 80% & 100% quota warnings, and runs Stripe subscription reconciliation with exponential backoff retries.
4. **Real persistence**: Complete DDL migrations in `src/db/schema.sql` with WAL mode, foreign keys, and indexes for tenant isolation.
5. **Idempotency where it matters**: `MeterService` uses atomic SQLite transactions storing both `usage_events` and `idempotency_records` in one commit.
6. **Secrets clean**: Secrets are loaded via `.env` only. `.env` is git-ignored and safe `.env.example` is provided.
7. **Cost tracked**: Attributed per tenant and per request using integer nanodollars with zero floating point errors.
