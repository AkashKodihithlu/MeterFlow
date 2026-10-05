import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { getDb } from '../db/index.js';
import { seed } from '../scripts/seed.js';
import { PINNED_PRICING, calculateUsageCost } from '../config/pricing.js';

test('PROBE 5: Pinned Pricing Rules (Cached Tokens, Reasoning Tokens, & Rollup Matching)', async (t) => {
  const db = getDb();
  seed(db);

  const app = createApp();
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(() => {
    server.close();
  });

  const tenantId = 'tenant_pricing_isolated';
  
  // Create isolated test tenant
  const now = Date.now();
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const endOfMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59, 999).getTime();

  db.prepare(`
    INSERT OR REPLACE INTO tenants (id, name, email, stripe_customer_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tenantId, 'Pricing Test Tenant', 'pricing@test.internal', null, now, now);

  db.prepare(`
    INSERT OR REPLACE INTO subscriptions (id, tenant_id, plan_id, stripe_subscription_id, status, current_period_start, current_period_end, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(`sub_${tenantId}`, tenantId, 'pro', null, 'active', startOfMonth, endOfMonth, now, now);

  db.prepare('DELETE FROM usage_events WHERE tenant_id = ?').run(tenantId);
  db.prepare('DELETE FROM idempotency_records WHERE tenant_id = ?').run(tenantId);

  // Specific quantities to test every rule
  const inputTokens = 10000;         // 10k fresh input tokens
  const cachedInputTokens = 20000;   // 20k cached input tokens (cheaper)
  const outputTokens = 5000;         // 5k output tokens
  const reasoningTokens = 2000;      // 2k reasoning tokens (must price as output)
  const apiCalls = 1;

  // 1. Direct Engine Calculation Check
  const expectedCost = calculateUsageCost({
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
    api_calls: apiCalls
  });

  // Verify individual components
  assert.equal(expectedCost.breakdown_nanodollars.input_tokens, 15000000);        // 10,000 * 1,500
  assert.equal(expectedCost.breakdown_nanodollars.cached_input_tokens, 7500000);  // 20,000 * 375
  assert.equal(expectedCost.breakdown_nanodollars.output_tokens, 30000000);       // 5,000 * 6,000
  assert.equal(expectedCost.breakdown_nanodollars.reasoning_tokens, 12000000);    // 2,000 * 6,000 (priced identical to output)
  assert.equal(expectedCost.breakdown_nanodollars.api_calls, 1000000);            // 1 * 1,000,000
  assert.equal(expectedCost.total_cost_nanodollars, 65500000);                    // Total $0.0655

  // Verify reasoning tokens price identically to output tokens
  const reasoningRate = expectedCost.breakdown_nanodollars.reasoning_tokens / reasoningTokens;
  const outputRate = expectedCost.breakdown_nanodollars.output_tokens / outputTokens;
  assert.equal(reasoningRate, outputRate, 'Reasoning tokens must be billed at the exact output token rate');

  // Verify cached input discount: cached rate must be 25% of fresh input rate (75% discount)
  const cachedRate = expectedCost.breakdown_nanodollars.cached_input_tokens / cachedInputTokens;
  const freshInputRate = expectedCost.breakdown_nanodollars.input_tokens / inputTokens;
  assert.equal(cachedRate, freshInputRate * 0.25, 'Cached tokens must receive a 75% discount');

  // 2. Transact through HTTP API
  const genRes = await fetch(`${baseUrl}/api/v1/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `pricing-probe-call-${Date.now()}`
    },
    body: JSON.stringify({
      tenant_id: tenantId,
      input_tokens: inputTokens,
      cached_input_tokens: cachedInputTokens,
      output_tokens: outputTokens,
      reasoning_tokens: reasoningTokens,
      api_calls: apiCalls
    })
  });

  assert.equal(genRes.status, 200);
  const genData = await genRes.json();
  assert.equal(genData.cost.total_nanodollars, 65500000);

  // 3. Verify GET /usage matches exact pinned pricing totals
  const usageRes = await fetch(`${baseUrl}/api/v1/usage?tenant_id=${tenantId}`);
  assert.equal(usageRes.status, 200);
  const usageData = await usageRes.json();

  assert.equal(usageData.usage.tokens.input_tokens, inputTokens);
  assert.equal(usageData.usage.tokens.cached_input_tokens, cachedInputTokens);
  assert.equal(usageData.usage.tokens.output_tokens, outputTokens);
  assert.equal(usageData.usage.tokens.reasoning_tokens, reasoningTokens);
  assert.equal(usageData.usage.tokens.total_tokens, inputTokens + cachedInputTokens + outputTokens + reasoningTokens);

  assert.equal(usageData.cost.total_nanodollars, 65500000, 'GET /usage total nanodollars must match pinned pricing');
  assert.equal(usageData.cost.total_usd, '$0.0655', 'GET /usage formatted USD string must match pinned pricing');
});
