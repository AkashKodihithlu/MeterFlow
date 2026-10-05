import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { getDb } from '../db/index.js';
import { seed } from '../scripts/seed.js';

test('PROBE 2: Quota Enforcement & Boundary Honesty (999, 1000, 1001 & 429 / 402)', async (t) => {
  const db = getDb();
  seed(db);

  const app = createApp();
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(() => {
    server.close();
  });

  const boundaryTenant = 'tenant_boundary_test'; // Pre-seeded with 998 calls

  // Step 1: Request 999 (998 used + 1 requested = 999 <= 1000)
  const res999 = await fetch(`${baseUrl}/api/v1/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `boundary-call-999-${Date.now()}`
    },
    body: JSON.stringify({
      tenant_id: boundaryTenant,
      api_calls: 1,
      input_tokens: 10,
      output_tokens: 10
    })
  });

  assert.equal(res999.status, 200, 'Call 999 of 1000 must succeed (200 OK)');
  const body999 = await res999.json();
  assert.equal(body999.remaining_quota.api_calls, 1, 'Remaining calls after 999 should be 1');

  // Step 2: Request 1000 (999 used + 1 requested = 1000 <= 1000) - EXACT BOUNDARY
  const res1000 = await fetch(`${baseUrl}/api/v1/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `boundary-call-1000-${Date.now()}`
    },
    body: JSON.stringify({
      tenant_id: boundaryTenant,
      api_calls: 1,
      input_tokens: 10,
      output_tokens: 10
    })
  });

  assert.equal(res1000.status, 200, 'Call exactly at boundary 1000 of 1000 must succeed (200 OK)');
  const body1000 = await res1000.json();
  assert.equal(body1000.remaining_quota.api_calls, 0, 'Remaining calls after 1000 should be 0');

  // Step 3: Request 1001 (1000 used + 1 requested = 1001 > 1000) - BOUNDARY EXCEEDED
  const res1001 = await fetch(`${baseUrl}/api/v1/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `boundary-call-1001-${Date.now()}`
    },
    body: JSON.stringify({
      tenant_id: boundaryTenant,
      api_calls: 1,
      input_tokens: 10,
      output_tokens: 10
    })
  });

  assert.equal(res1001.status, 429, 'Call exceeding quota must return 429 Too Many Requests');
  assert.ok(res1001.headers.has('retry-after'), '429 response must provide Retry-After header');

  const body1001 = await res1001.json();
  assert.equal(body1001.error, 'QuotaExceeded');
  assert.equal(body1001.code, 429);
  assert.equal(body1001.quota_type, 'api_calls');
  assert.equal(body1001.limit, 1000);
  assert.equal(body1001.current_usage, 1000);
  assert.ok(body1001.message.includes('Monthly API call quota exceeded'));

  // Step 4: Test 402 Payment Required on Past Due / Lapsed Tenant
  const res402 = await fetch(`${baseUrl}/api/v1/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `past-due-call-${Date.now()}`
    },
    body: JSON.stringify({
      tenant_id: 'tenant_past_due',
      api_calls: 1
    })
  });

  assert.equal(res402.status, 402, 'Lapsed/past-due plan must return 402 Payment Required');
  const body402 = await res402.json();
  assert.equal(body402.error, 'PaymentRequired');
  assert.equal(body402.code, 402);
  assert.ok(body402.message.includes('past_due'));
});
