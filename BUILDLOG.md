# MeterFlow Build Log (BUILDLOG.md)

**Project**: MeterFlow — SaaS Usage Metering & Billing Engine  
**Intern / Author**: Akash Kodihithlu  
**Date**: October 5, 2026  

---

## 1. Overview & Approach

The goal of this build was to deliver a production-grade, zero-credit-card, deterministic metering and billing engine conforming to the FlyRank Capstone specification. The build strictly followed the 4-phase milestone path:
1. **Design**: Relational schema, token pricing formulation, and architecture doc.
2. **Core Billing Logic**: Exactly-once idempotency deduplication and honest boundary quota enforcement (429/402).
3. **Stripe Integration**: Test-mode Checkout sessions, HMAC-SHA256 signature verification, and duplicate webhook filtering.
4. **Cost & Finalization**: Precise integer money math (nanodollars), background worker rollups/alerts, and probe verification.

---

## 2. Where AI Helped

1. **Schema & Layer Separation**:
   - AI helped scaffold the relational schema with isolated tables: `tenants`, `plans`, `subscriptions`, `usage_events`, `idempotency_records`, `webhook_events`, and `quota_alerts`.
   - Clear separation between the HTTP transport layer (`src/routes`), business logic (`src/services`), and persistence layer (`src/db`).

2. **Integer Currency Architecture (Zero Float Drift)**:
   - Floating-point representations in JavaScript (`0.1 + 0.2 === 0.30000000000000004`) cause devastating rounding accumulation in billing engines.
   - AI formulated the integer **nanodollar model** ($1\text{ USD} = 1,000,000,000\text{ nanodollars} = 10,000,000\text{ nanodollars per cent}$):
     - Fresh input: $1,500\text{ nUSD / token}$
     - Cached input (75% discount): $375\text{ nUSD / token}$
     - Output & reasoning: $6,000\text{ nUSD / token}$
     - API gateway call: $1,000,000\text{ nUSD / call}$ ($0.001)

3. **Background Worker Design**:
   - AI implemented a multi-task background worker incorporating periodic usage rollup snapshots, 80% & 100% quota alerts, and subscription reconciliation with exponential backoff retries.

---

## 3. Where AI Was Wrong & How It Was Corrected

1. **Bug 1: Parameter Name Deserialization Mismatch in Router**
   - *What AI did wrong*: In `src/routes/meterRoutes.js`, the request body was destructured as snake_case:
     ```js
     const { input_tokens, cached_input_tokens, output_tokens, reasoning_tokens } = req.body;
     ```
     However, when passing arguments into `meterService.record()`, AI incorrectly typed `cachedInputTokens` and `reasoningTokens` instead of the destructured variables.
   - *Error*: During `npm test`, Node caught `ReferenceError: cachedInputTokens is not defined`.
   - *Correction*: Updated `meterRoutes.js` to cleanly bind `cachedInputTokens: cached_input_tokens` and `reasoningTokens: reasoning_tokens`.

2. **Bug 2: Parallel Test Runner Shared DB Contamination**
   - *What AI did wrong*: Node 22/24's native `node:test` runner executes test files concurrently across multiple threads. Because all test files opened `./data/meterflow.db` and called `seed()`, `probe1_idempotency.test.js` and `probe5_pricing.test.js` cross-contaminated the token and event counts of `tenant_default_free`.
   - *Error*: Probe 5 asserted 10,000 input tokens, but found 11,200 (10,000 + 1,200 from concurrent probe 1).
   - *Correction*:
     1. Configured `--test-concurrency=1` in `package.json` so test suites run in deterministic sequential order.
     2. Isolated `probe5_pricing.test.js` to use a dedicated test tenant (`tenant_pricing_isolated`), guaranteeing complete isolation.

3. **Bug 3: Express Raw Body Parsing for Stripe Webhooks**
   - *What AI initially proposed*: Standard `express.json()` middleware parses JSON into objects before the route handler, which modifies string representations and invalidates HMAC-SHA256 signature verification.
   - *Correction*: Added custom `verify` callback to `express.json()` in `src/app.js` to capture and preserve `req.rawBody = buf`, ensuring cryptographic webhook verification succeeds in all environments.

---

## 4. Key Learnings & Engineering Takeaways

- **Idempotency is an architectural pattern, not a patch**: Storing both the domain event (`usage_events`) and the client response payload (`idempotency_records`) inside an atomic database transaction guarantees that retried requests return the exact same HTTP response with zero state distortion.
- **Boundary checks must be strictly honest**: Exact equality (`used + requested === limit`) must succeed, while the first call exceeding it (`> limit`) must fail with clear machine-readable headers (`Retry-After`, 429) rather than silent clipping or vague errors.
