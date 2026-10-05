# MeterFlow

[![Node.js CI](https://img.shields.io/badge/Node.js-v20%2B-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/Acceptance%20Probes-5%2F5%20Passed-success)](./EVIDENCE.md)
[![Stripe Test Mode](https://img.shields.io/badge/Stripe-Test%20Mode-blueviolet)](https://stripe.com)

**MeterFlow** is a high-precision SaaS usage metering and billing engine built with **exactly-once idempotency guarantees**, **strict boundary quota enforcement**, **integer-precision money math**, and **cryptographically-verified Stripe test-mode subscription synchronization**.

---

## Architecture Diagram

```
                                  +---------------------------------------+
                                  |     Client / API Gateway / Agent      |
                                  +-------------------+-------------------+
                                                      |
                                                      v
                                  +---------------------------------------+
                                  |       Boundary Validation Layer       |
                                  |   (Input check, Idempotency Header)   |
                                  +-------------------+-------------------+
                                                      |
                           +--------------------------+--------------------------+
                           |                                                     |
                           v                                                     v
        +--------------------------------------+             +---------------------------------------+
        |        POST /api/v1/generate         |             |         POST /webhooks/stripe         |
        |      (Billable Action Endpoint)      |             |         (Stripe Webhook Sync)         |
        +------------------+-------------------+             +-------------------+-------------------+
                           |                                                     |
                           v                                                     v
        +--------------------------------------+             +---------------------------------------+
        |             MeterService             |             |             StripeService             |
        |  1. Check Idempotency Key in Store   |             |  1. Verify Signature (HMAC SHA-256)   |
        |     (Found? Return Cached Response)  |             |     (Bad signature -> 400)            |
        |  2. Check Quota Balance via          |             |  2. Check Event Replay in Store       |
        |     QuotaService (429 / 402)         |             |     (Duplicate? Ignore gracefully)    |
        |  3. Compute Exact Integer Cost       |             |  3. Apply Subscription State Change   |
        |     via CostService                  |             |     (Free <-> Pro, Active, Past-Due)  |
        |  4. Atomic DB Transaction Insert     |             +-------------------+-------------------+
        +------------------+-------------------+                                 |
                           |                                                     |
                           +--------------------------+--------------------------+
                                                      |
                                                      v
                                  +---------------------------------------+
                                  |     SQLite WAL Database (ACID)        |
                                  |  - tenants         - usage_events     |
                                  |  - plans           - idempotency_store|
                                  |  - subscriptions   - webhook_events   |
                                  +-------------------+-------------------+
                                                      ^
                                                      |
                                  +-------------------+-------------------+
                                  |       Background Worker Service       |
                                  |  - Hourly/Daily Rollup Aggregation    |
                                  |  - 80% & 100% Quota Alerts            |
                                  |  - Stripe Reconciliation with Retries |
                                  +---------------------------------------+
```

---

## Key Features

1. **Exactly-Once Metering**:
   - Every billable request requires an `Idempotency-Key` header.
   - Retried requests return the identical cached payload and HTTP status code without double-incrementing usage counts or incurring duplicate charges.
2. **Honest Boundary Quota Enforcement**:
   - Evaluated before billable work executes.
   - Exact boundary behavior: 1,000 / 1,000 calls is **Allowed (200 OK)**; 1,001 / 1,000 returns **HTTP 429 Too Many Requests** with `Retry-After` header.
   - Accounts with `past_due` status return **HTTP 402 Payment Required**.
3. **Zero-Drift Integer Money Math**:
   - Eliminates IEEE 754 floating-point inaccuracies by storing all monetary quantities in **integer nanodollars** ($1\text{ USD} = 1,000,000,000\text{ nUSD} = 10,000,000\text{ nUSD/cent}$).
   - Encodes complex AI pricing rules:
     - **Fresh Input Tokens**: $1.50 per 1M tokens (1,500 nUSD / token)
     - **Cached Input Tokens**: $0.375 per 1M tokens (375 nUSD / token — 75% discount)
     - **Output Tokens**: $6.00 per 1M tokens (6,000 nUSD / token)
     - **Reasoning / Thinking Tokens**: $6.00 per 1M tokens (priced as output tokens)
     - **API Gateway Calls**: $0.001 per call (1,000,000 nUSD / call)
4. **Stripe Test Mode Integration**:
   - Checkout session generation (`POST /api/v1/checkout/create-session`).
   - Cryptographic HMAC-SHA256 signature verification on `/webhooks/stripe` (forgeries return 400).
   - Replay deduplication: repeated webhook deliveries are safely ignored.
5. **Background Jobs & Monitoring**:
   - Automated rollups aggregation into `usage_rollups`.
   - Threshold monitoring: automated alerting when tenants reach 80% and 100% of plan quotas.
   - Stripe subscription reconciliation with exponential backoff retries.

---

## Subscription Plans & Quotas

| Plan | Price / Month | API Calls Quota | AI Tokens Quota | Overages / Policy |
| :--- | :--- | :--- | :--- | :--- |
| **Free** | $0.00 (0¢) | 1,000 calls / month | 100,000 tokens / month | Hard cap: 429 on quota exhaustion |
| **Pro** | $49.00 (4,900¢) | 50,000 calls / month | 5,000,000 tokens / month | Priority limits, high-throughput |

---

## Quickstart & Setup

### Prerequisites
- Node.js v20.x or v22.x+
- Git

### 1. Installation
```bash
git clone https://github.com/AkashKodihithlu/MeterFlow.git
cd MeterFlow
npm install
```

### 2. Environment Configuration
Copy the provided `.env.example` to `.env`:
```bash
cp .env.example .env
```
*(The defaults in `.env.example` are preconfigured to run locally with zero external setup.)*

### 3. Seed Demo Data
Initialize the SQLite WAL database and seed test plans and tenants:
```bash
npm run seed
```

This seeds:
- `tenant_default_free`: Free tier tenant with 0 usage.
- `tenant_boundary_test`: Free tier tenant pre-seeded with 998/1000 calls to immediately test boundary conditions (999, 1000, 1001).
- `tenant_pro_corp`: Pro tier customer with 50,000 call / 5M token limits.
- `tenant_stripe_upgrade`: Free tier tenant ready for Stripe checkout upgrade.
- `tenant_past_due`: Past-due subscription to test HTTP 402.

### 4. Run the Server
```bash
npm start
```
The server will start at `http://localhost:3000`.

### 5. Run the Automated Tests (5/5 Probes)
```bash
npm test
```

---

## API Endpoints Reference

### 1. Billable Action / Generation
**`POST /api/v1/generate`** (or `/generate`)
- **Headers**:
  - `Content-Type: application/json`
  - `Idempotency-Key: <unique-uuid-or-string>`
- **Request Body**:
```json
{
  "tenant_id": "tenant_default_free",
  "model": "gpt-4o",
  "input_tokens": 1000,
  "cached_input_tokens": 500,
  "output_tokens": 200,
  "reasoning_tokens": 100,
  "api_calls": 1
}
```
- **Response (`200 OK`)**:
```json
{
  "success": true,
  "event_id": "evt_df3284d1-8a94-429e-89d7-99622366513e",
  "tenant_id": "tenant_default_free",
  "event_type": "ai_generation",
  "idempotency_key": "my-client-key-1",
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
  "cost": {
    "total_nanodollars": 4487500,
    "total_cents": 0,
    "total_usd": "$0.0045"
  },
  "remaining_quota": {
    "api_calls": 999,
    "ai_tokens": 98200
  }
}
```

### 2. Tenant Usage Rollup
**`GET /api/v1/usage?tenant_id=tenant_default_free`** (or `/usage`)
- Returns plan metadata, active period, consumed tokens, remaining allowances, and exact cost calculations.

### 3. Stripe Checkout Session
**`POST /api/v1/checkout/create-session`**
```json
{
  "tenant_id": "tenant_stripe_upgrade"
}
```
- Returns session URL and ID for test mode checkout.

### 4. Stripe Webhook Ingestion
**`POST /webhooks/stripe`**
- **Headers**: `stripe-signature: t=<timestamp>,v1=<hash>`
- Verifies signature, filters replays, and executes plan state transitions (`checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`).

### 5. Itemized Invoice Statement
**`GET /api/v1/tenants/tenant_default_free/invoice`**
- Returns a itemized monthly breakdown (recurring plan fee, API calls, and individual token categories).

### 6. Background Worker Trigger
**`POST /api/v1/worker/trigger`** (or `npm run worker`)
- Manually runs rollups aggregation, threshold quota evaluations, and Stripe subscription reconciliation.

---

## Limitations & Production Notes

1. **Database Backend**: MeterFlow uses high-concurrency SQLite with Write-Ahead Logging (`WAL` mode) and synchronous `NORMAL` pragmas, making it lightweight and runnable on any clean machine with zero dependencies. In a distributed multi-instance deployment across multiple Kubernetes pods, the persistence layer should connect to a distributed PostgreSQL cluster.
2. **Stripe Test Mode**: All billing actions operate in Stripe Test Mode using mock or test sandbox cards (`4242 4242 4242 4242`). Live production keys and automated live invoicing/ACH collections are deliberately disabled to prevent accidental monetary transfer.
3. **AI Generation**: The `/api/v1/generate` endpoint measures and meters real token metrics (fresh, cached, output, reasoning) without incurring external LLM API costs.
