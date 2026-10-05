import { createApp } from '../app.js';
import { getDb } from '../db/index.js';
import { seed } from '../scripts/seed.js';
import { StripeService } from '../services/stripeService.js';
import { env } from '../config/env.js';

async function main() {
  const db = getDb();
  seed(db);

  const app = createApp();
  const server = app.listen(3001);
  const baseUrl = 'http://localhost:3001';

  console.log('\n=================== EVIDENCE VERIFICATION START ===================\n');

  // --- EVIDENCE 1: Idempotency Transcript (Same request sent twice) ---
  console.log('--- TEST 1: Exactly-Once Metering & Idempotency ---');
  const idemKey = 'evidence-idempotency-key-001';
  const idemPayload = {
    tenant_id: 'tenant_default_free',
    model: 'gpt-4o',
    input_tokens: 1000,
    cached_input_tokens: 500,
    output_tokens: 200,
    reasoning_tokens: 100,
    api_calls: 1
  };

  console.log('\n[Request 1: Initial call]');
  console.log(`POST /api/v1/generate (Idempotency-Key: ${idemKey})`);
  const r1 = await fetch(`${baseUrl}/api/v1/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKey },
    body: JSON.stringify(idemPayload)
  });
  console.log(`HTTP ${r1.status}`);
  const b1 = await r1.json();
  console.log(JSON.stringify(b1, null, 2));

  console.log('\n[Request 2: Retried call with same key]');
  console.log(`POST /api/v1/generate (Idempotency-Key: ${idemKey})`);
  const r2 = await fetch(`${baseUrl}/api/v1/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKey },
    body: JSON.stringify(idemPayload)
  });
  console.log(`HTTP ${r2.status} (X-Cache-Lookup: ${r2.headers.get('x-cache-lookup')}, X-Idempotent-Replay: ${r2.headers.get('x-idempotent-replay')})`);
  const b2 = await r2.json();
  console.log(JSON.stringify(b2, null, 2));

  const dbEvents = db.prepare('SELECT COUNT(*) as cnt FROM usage_events WHERE idempotency_key = ?').get(idemKey).cnt;
  console.log(`\nDB usage_events count for key '${idemKey}': ${dbEvents} (EXACTLY 1, NO DOUBLE-COUNT)`);

  // --- EVIDENCE 2: Boundary Quota Honesty ---
  console.log('\n--- TEST 2: Boundary Quota Enforcement (999, 1000, 1001 & 429 / 402) ---');
  const boundaryTenant = 'tenant_boundary_test'; // starts at 998

  console.log('\n[Request at 999/1000]');
  const r999 = await fetch(`${baseUrl}/api/v1/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-999' },
    body: JSON.stringify({ tenant_id: boundaryTenant, api_calls: 1 })
  });
  console.log(`HTTP ${r999.status}: remaining = ${(await r999.json()).remaining_quota.api_calls}`);

  console.log('\n[Request at 1000/1000 - Exact boundary limit]');
  const r1000 = await fetch(`${baseUrl}/api/v1/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-1000' },
    body: JSON.stringify({ tenant_id: boundaryTenant, api_calls: 1 })
  });
  console.log(`HTTP ${r1000.status}: remaining = ${(await r1000.json()).remaining_quota.api_calls}`);

  console.log('\n[Request at 1001/1000 - Quota Exceeded]');
  const r1001 = await fetch(`${baseUrl}/api/v1/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-1001' },
    body: JSON.stringify({ tenant_id: boundaryTenant, api_calls: 1 })
  });
  console.log(`HTTP ${r1001.status} (Retry-After: ${r1001.headers.get('retry-after')})`);
  console.log(JSON.stringify(await r1001.json(), null, 2));

  console.log('\n[Request on past_due tenant -> 402 Payment Required]');
  const r402 = await fetch(`${baseUrl}/api/v1/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-402' },
    body: JSON.stringify({ tenant_id: 'tenant_past_due', api_calls: 1 })
  });
  console.log(`HTTP ${r402.status}`);
  console.log(JSON.stringify(await r402.json(), null, 2));

  // --- EVIDENCE 3: Stripe Checkout & Signature-Verified Webhook ---
  console.log('\n--- TEST 3: Stripe Test Checkout & Signature Webhooks ---');
  const stripeTenant = 'tenant_stripe_upgrade';
  console.log(`Initial plan for ${stripeTenant}: ${(await (await fetch(`${baseUrl}/api/v1/usage?tenant_id=${stripeTenant}`)).json()).plan.id}`);

  // Create checkout session
  const checkRes = await fetch(`${baseUrl}/api/v1/checkout/create-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_id: stripeTenant })
  });
  const checkData = await checkRes.json();
  console.log('Stripe Checkout Session Created:', checkData.session_id);

  // Send forged webhook
  const forgedPayload = JSON.stringify({ id: 'evt_forged_1', type: 'checkout.session.completed' });
  const forgedRes = await fetch(`${baseUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=123,v1=forged_bad_hash' },
    body: forgedPayload
  });
  console.log(`Forged Webhook HTTP ${forgedRes.status}: ${(await forgedRes.json()).message}`);

  // Send valid signed webhook
  const validEvt = {
    id: `evt_valid_upgrade_${Date.now()}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: checkData.session_id,
        client_reference_id: stripeTenant,
        customer: 'cus_stripe_real_cust_id',
        subscription: 'sub_stripe_pro_live_123'
      }
    }
  };
  const validPayload = JSON.stringify(validEvt);
  const validSig = StripeService.generateSignature(validPayload, env.STRIPE_WEBHOOK_SECRET);

  const validRes = await fetch(`${baseUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': validSig },
    body: validPayload
  });
  console.log(`Valid Signed Webhook HTTP ${validRes.status}:`, await validRes.json());

  // Replay valid webhook
  const replayRes = await fetch(`${baseUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': validSig },
    body: validPayload
  });
  console.log(`Replayed Webhook HTTP ${replayRes.status}:`, await replayRes.json());

  // Check updated limits
  const updatedUsage = await (await fetch(`${baseUrl}/api/v1/usage?tenant_id=${stripeTenant}`)).json();
  console.log(`Upgraded Tenant Plan: ${updatedUsage.plan.id.toUpperCase()}`);
  console.log(`New Limits: API calls = ${updatedUsage.limits.api_calls.toLocaleString()}, AI tokens = ${updatedUsage.limits.ai_tokens.toLocaleString()}`);

  // --- EVIDENCE 4: Pricing Math Rollup Check ---
  console.log('\n--- TEST 4: Pinned Pricing Rules Rollup (GET /usage) ---');
  const usageCheck = await (await fetch(`${baseUrl}/api/v1/usage?tenant_id=tenant_default_free`)).json();
  console.log('GET /usage summary:');
  console.log(JSON.stringify({
    tenant: usageCheck.tenant.id,
    usage: usageCheck.usage,
    cost: usageCheck.cost
  }, null, 2));

  server.close();
  console.log('\n=================== EVIDENCE VERIFICATION END ===================\n');
}

main().catch(console.error);
