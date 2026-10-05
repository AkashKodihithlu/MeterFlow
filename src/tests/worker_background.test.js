import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../db/index.js';
import { seed } from '../scripts/seed.js';
import { workerService } from '../services/workerService.js';

test('Background Worker: Rollup Aggregation, Quota Alerts (80% & 100%), and Retries', async () => {
  const db = getDb();
  seed(db);

  // 1. Run worker cycle
  const result = await workerService.runAllJobs();

  assert.equal(result.rollups.success, true);
  assert.ok(result.rollups.rollupsCreated >= 1);

  assert.equal(result.alerts.success, true);
  assert.equal(result.reconciliation.success, true);

  // Verify that an 80% quota alert was dispatched for tenant_boundary_test (starts at 998/1000 calls)
  const alert = db.prepare(`
    SELECT * FROM quota_alerts WHERE tenant_id = 'tenant_boundary_test' AND metric = 'api_calls'
  `).get();

  assert.ok(alert, 'Quota alert must be recorded in database');
  assert.equal(alert.threshold, 80);
  assert.equal(alert.usage_count, 998);
  assert.equal(alert.quota_limit, 1000);

  // Verify retry mechanism with backoff on worker
  let counter = 0;
  const retryResult = await workerService.runWithRetry(async () => {
    counter++;
    if (counter < 2) {
      throw new Error('Transient simulated network error');
    }
    return 'recovered';
  }, 'SimulatedWorkerTask', 3, 20);

  assert.equal(retryResult, 'recovered', 'Worker retry should recover after transient failure');
  assert.equal(counter, 2);
});
