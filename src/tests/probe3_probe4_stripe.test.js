import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { getDb } from '../db/index.js';
import { seed } from '../scripts/seed.js';
import { StripeService } from '../services/stripeService.js';
import { env } from '../config/env.js';

test('PROBE 3 & 4: Stripe Integration, Webhook Signature Verification, & Deduplication', async (t) => {
  const db = getDb();
  seed(db);

  const app = createApp();
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(() => {
    server.close();
  });

  const tenantId = 'tenant_stripe_upgrade';

  // 1. Verify Tenant Starts on Free Plan
  const initialUsageRes = await fetch(`${baseUrl}/api/v1/usage?tenant_id=${tenantId}`);
  const initialUsage = await initialUsageRes.json();
  assert.equal(initialUsage.plan.id, 'free');
  assert.equal(initialUsage.limits.api_calls, 1000);
  assert.equal(initialUsage.limits.ai_tokens, 100000);

  // 2. Checkout Session Creation
  const checkoutRes = await fetch(`${baseUrl}/api/v1/checkout/create-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_id: tenantId })
  });
  assert.equal(checkoutRes.status, 200);
  const checkoutData = await checkoutRes.json();
  assert.ok(checkoutData.session_id);
  assert.equal(checkoutData.plan_id, 'pro');

  // PROBE 4 Part A: Send Forged Webhook with Bad Signature -> 400 Bad Request
  const eventPayload = {
    id: `evt_stripe_test_${Date.now()}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: checkoutData.session_id,
        client_reference_id: tenantId,
        customer: 'cus_stripe_real_cust_id',
        subscription: 'sub_stripe_pro_live_123',
        metadata: {
          tenant_id: tenantId
        }
      }
    }
  };

  const payloadString = JSON.stringify(eventPayload);

  const forgedRes = await fetch(`${baseUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': 't=1234567,v1=bad_forged_hex_signature_deadbeef'
    },
    body: payloadString
  });

  assert.equal(forgedRes.status, 400, 'Forged signature must be rejected with 400 Bad Request');
  const forgedBody = await forgedRes.json();
  assert.equal(forgedBody.error, 'InvalidSignature');

  // Verify tenant is STILL Free after forged attempt
  const usageAfterForged = await (await fetch(`${baseUrl}/api/v1/usage?tenant_id=${tenantId}`)).json();
  assert.equal(usageAfterForged.plan.id, 'free', 'Plan must remain Free after forged webhook');

  // PROBE 3: Send Valid Signed Webhook -> Flips tenant from Free to Pro
  const validSignature = StripeService.generateSignature(payloadString, env.STRIPE_WEBHOOK_SECRET);

  const validRes = await fetch(`${baseUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': validSignature
    },
    body: payloadString
  });

  assert.equal(validRes.status, 200, 'Valid signed webhook must return 200 OK');
  const validBody = await validRes.json();
  assert.equal(validBody.received, true);
  assert.equal(validBody.status, 'processed');

  // Verify Tenant Plan flipped to Pro and GET /usage shows new limits (50k calls, 5M tokens)
  const upgradedUsageRes = await fetch(`${baseUrl}/api/v1/usage?tenant_id=${tenantId}`);
  const upgradedUsage = await upgradedUsageRes.json();

  assert.equal(upgradedUsage.plan.id, 'pro', 'Tenant plan must now be Pro');
  assert.equal(upgradedUsage.limits.api_calls, 50000, 'Pro limit must be 50,000 API calls');
  assert.equal(upgradedUsage.limits.ai_tokens, 5000000, 'Pro limit must be 5,000,000 AI tokens');

  // PROBE 4 Part B: Replay the Exact Same Real Event Twice -> Processed Once, Duplicate Ignored
  const replayRes = await fetch(`${baseUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': validSignature
    },
    body: payloadString
  });

  assert.equal(replayRes.status, 200, 'Replayed event must return 200 OK');
  const replayBody = await replayRes.json();
  assert.equal(replayBody.duplicate, true, 'Replayed webhook must be marked duplicate: true');
  assert.equal(replayBody.status, 'ignored', 'Duplicate webhook must be ignored');

  // Verify only 1 webhook event was recorded in the database
  const webhookRecordCount = db.prepare(`
    SELECT COUNT(*) as count FROM webhook_events WHERE stripe_event_id = ?
  `).get(eventPayload.id).count;
  assert.equal(webhookRecordCount, 1, 'Database must record the webhook event exactly once');
});
