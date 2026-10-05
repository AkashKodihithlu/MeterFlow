import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { getDb } from '../db/index.js';
import { seed } from '../scripts/seed.js';

test('PROBE 1: Exactly-Once Metering & Idempotency Key Deduplication', async (t) => {
  const db = getDb();
  seed(db);

  const app = createApp();
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(() => {
    server.close();
  });

  const tenantId = 'tenant_default_free';
  const idempotencyKey = `probe1-idem-${Date.now()}`;
  const payload = {
    tenant_id: tenantId,
    model: 'gpt-4o',
    input_tokens: 1200,
    cached_input_tokens: 300,
    output_tokens: 450,
    reasoning_tokens: 150,
    api_calls: 1
  };

  // 1. Initial Request
  const res1 = await fetch(`${baseUrl}/api/v1/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify(payload)
  });

  assert.equal(res1.status, 200, 'Initial request must succeed with 200 OK');
  const body1 = await res1.json();
  assert.equal(body1.success, true);
  assert.equal(body1.tenant_id, tenantId);
  assert.equal(body1.usage.tokens.input_tokens, 1200);
  assert.equal(body1.usage.tokens.cached_input_tokens, 300);
  assert.equal(body1.usage.tokens.output_tokens, 450);
  assert.equal(body1.usage.tokens.reasoning_tokens, 150);
  assert.equal(body1.usage.tokens.total_tokens, 2100);

  // Check Database Event Count
  const eventsCount1 = db.prepare(`
    SELECT COUNT(*) as cnt FROM usage_events WHERE idempotency_key = ?
  `).get(idempotencyKey).cnt;
  assert.equal(eventsCount1, 1, 'Database must contain exactly 1 usage event');

  // 2. Duplicate Request (Retried request with exact same idempotency key)
  const res2 = await fetch(`${baseUrl}/api/v1/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify(payload)
  });

  assert.equal(res2.status, 200, 'Retried request must return 200 OK');
  const body2 = await res2.json();

  // Acceptance Criteria: The second response mirrors the first
  assert.deepEqual(body2, body1, 'Second response must mirror the first response payload exactly');

  // Verify header signals cache replay
  assert.equal(res2.headers.get('x-cache-lookup'), 'HIT');
  assert.equal(res2.headers.get('x-idempotent-replay'), 'true');

  // Check Database Event Count again
  const eventsCount2 = db.prepare(`
    SELECT COUNT(*) as cnt FROM usage_events WHERE idempotency_key = ?
  `).get(idempotencyKey).cnt;
  assert.equal(eventsCount2, 1, 'Database must STILL contain exactly 1 usage event (double-counting prevented)');
});
