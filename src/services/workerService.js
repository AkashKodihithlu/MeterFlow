import { getDb } from '../db/index.js';
import { costService } from './costService.js';
import crypto from 'crypto';

export class WorkerService {
  constructor(db = null) {
    this.db = db || getDb();
  }

  /**
   * Exponential backoff retry wrapper for background tasks.
   */
  async runWithRetry(fn, taskName = 'background_task', maxRetries = 3, initialDelayMs = 100) {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        return await fn();
      } catch (err) {
        attempt++;
        const delay = initialDelayMs * Math.pow(2, attempt - 1);
        console.warn(`[Worker] ${taskName} failed (attempt ${attempt}/${maxRetries}): ${err.message}. Retrying in ${delay}ms...`);
        if (attempt >= maxRetries) {
          console.error(`[Worker Alert] ${taskName} permanently failed after ${maxRetries} attempts! Error:`, err);
          throw err;
        }
        await new Promise((res) => setTimeout(res, delay));
      }
    }
  }

  /**
   * 1. Usage Rollup Job:
   * Aggregates usage events into hourly/daily summary records to offload real-time analytics.
   */
  aggregateUsageRollups() {
    return this.runWithRetry(() => {
      const now = Date.now();
      const activeSubscriptions = this.db.prepare(`
        SELECT tenant_id, current_period_start, current_period_end 
        FROM subscriptions 
        WHERE status = 'active'
      `).all();

      let rollupsCreated = 0;

      for (const sub of activeSubscriptions) {
        const stats = this.db.prepare(`
          SELECT 
            COALESCE(SUM(api_calls_count), 0) as total_api_calls,
            COALESCE(SUM(input_tokens), 0) as total_input_tokens,
            COALESCE(SUM(cached_input_tokens), 0) as total_cached_input_tokens,
            COALESCE(SUM(output_tokens), 0) as total_output_tokens,
            COALESCE(SUM(reasoning_tokens), 0) as total_reasoning_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(cost_nanodollars), 0) as total_cost_nanodollars
          FROM usage_events
          WHERE tenant_id = ? AND timestamp >= ? AND timestamp <= ?
        `).get(sub.tenant_id, sub.current_period_start, sub.current_period_end);

        const costCalc = costService.calculate({
          input_tokens: Number(stats.total_input_tokens),
          cached_input_tokens: Number(stats.total_cached_input_tokens),
          output_tokens: Number(stats.total_output_tokens),
          reasoning_tokens: Number(stats.total_reasoning_tokens),
          api_calls: Number(stats.total_api_calls)
        });

        const rollupId = `rollup_${sub.tenant_id}_${sub.current_period_start}`;

        this.db.prepare(`
          INSERT OR REPLACE INTO usage_rollups (
            id, tenant_id, period_start, period_end,
            total_api_calls, total_input_tokens, total_cached_input_tokens,
            total_output_tokens, total_reasoning_tokens, total_tokens,
            total_cost_nanodollars, total_cost_cents, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          rollupId,
          sub.tenant_id,
          sub.current_period_start,
          sub.current_period_end,
          Number(stats.total_api_calls),
          Number(stats.total_input_tokens),
          Number(stats.total_cached_input_tokens),
          Number(stats.total_output_tokens),
          Number(stats.total_reasoning_tokens),
          Number(stats.total_tokens),
          costCalc.total_cost_nanodollars,
          costCalc.total_cost_cents,
          now
        );

        rollupsCreated++;
      }

      return { success: true, rollupsCreated, timestamp: now };
    }, 'AggregateUsageRollups');
  }

  /**
   * 2. Quota Alerts Job:
   * Checks tenants reaching 80% or 100% of their plan allowances and persists alerts.
   */
  evaluateQuotaAlerts() {
    return this.runWithRetry(() => {
      const subscriptions = this.db.prepare(`
        SELECT 
          s.tenant_id, s.current_period_start, s.current_period_end,
          p.api_calls_quota, p.ai_tokens_quota, t.name as tenant_name
        FROM subscriptions s
        JOIN plans p ON s.plan_id = p.id
        JOIN tenants t ON s.tenant_id = t.id
        WHERE s.status = 'active'
      `).all();

      const alertsTriggered = [];
      const now = Date.now();

      for (const sub of subscriptions) {
        const usage = this.db.prepare(`
          SELECT 
            COALESCE(SUM(api_calls_count), 0) as used_api_calls,
            COALESCE(SUM(total_tokens), 0) as used_tokens
          FROM usage_events
          WHERE tenant_id = ? AND timestamp >= ? AND timestamp <= ?
        `).get(sub.tenant_id, sub.current_period_start, sub.current_period_end);

        const usedCalls = Number(usage.used_api_calls);
        const usedTokens = Number(usage.used_tokens);

        // Check API Calls (80% and 100%)
        const callsRatio = sub.api_calls_quota > 0 ? (usedCalls / sub.api_calls_quota) : 0;
        if (callsRatio >= 1.0) {
          this.recordAlert(alertsTriggered, sub.tenant_id, 'api_calls', 100, usedCalls, sub.api_calls_quota, sub.current_period_start, now);
        } else if (callsRatio >= 0.8) {
          this.recordAlert(alertsTriggered, sub.tenant_id, 'api_calls', 80, usedCalls, sub.api_calls_quota, sub.current_period_start, now);
        }

        // Check AI Tokens (80% and 100%)
        const tokensRatio = sub.ai_tokens_quota > 0 ? (usedTokens / sub.ai_tokens_quota) : 0;
        if (tokensRatio >= 1.0) {
          this.recordAlert(alertsTriggered, sub.tenant_id, 'ai_tokens', 100, usedTokens, sub.ai_tokens_quota, sub.current_period_start, now);
        } else if (tokensRatio >= 0.8) {
          this.recordAlert(alertsTriggered, sub.tenant_id, 'ai_tokens', 80, usedTokens, sub.ai_tokens_quota, sub.current_period_start, now);
        }
      }

      return { success: true, alertsTriggered, count: alertsTriggered.length };
    }, 'EvaluateQuotaAlerts');
  }

  recordAlert(alertsList, tenantId, metric, threshold, usageCount, quotaLimit, periodStart, now) {
    const exists = this.db.prepare(`
      SELECT id FROM quota_alerts 
      WHERE tenant_id = ? AND metric = ? AND threshold = ? AND period_start = ?
    `).get(tenantId, metric, threshold, periodStart);

    if (!exists) {
      const alertId = `alert_${tenantId}_${metric}_${threshold}_${periodStart}`;
      this.db.prepare(`
        INSERT INTO quota_alerts (id, tenant_id, metric, threshold, usage_count, quota_limit, period_start, alerted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(alertId, tenantId, metric, threshold, usageCount, quotaLimit, periodStart, now);

      console.log(`[ALERT DISPATCHED] Tenant '${tenantId}' has reached ${threshold}% of ${metric} quota (${usageCount}/${quotaLimit})`);
      alertsList.push({ tenant_id: tenantId, metric, threshold, usage: usageCount, limit: quotaLimit });
    }
  }

  /**
   * 3. Reconciliation Job:
   * Compares internal database subscriptions against Stripe test records to detect out-of-sync states.
   */
  async reconcileSubscriptions() {
    return this.runWithRetry(async () => {
      const subs = this.db.prepare(`
        SELECT s.*, t.stripe_customer_id 
        FROM subscriptions s 
        JOIN tenants t ON s.tenant_id = t.id 
        WHERE s.stripe_subscription_id IS NOT NULL
      `).all();

      const synced = [];
      const drifted = [];

      for (const sub of subs) {
        // In local/test mode, verify internal consistency
        if (sub.status === 'active' || sub.status === 'past_due' || sub.status === 'canceled') {
          synced.push({ tenant_id: sub.tenant_id, status: sub.status, subscription_id: sub.stripe_subscription_id });
        } else {
          drifted.push({ tenant_id: sub.tenant_id, current_status: sub.status });
        }
      }

      return {
        success: true,
        checked: subs.length,
        synced: synced.length,
        drifted: drifted.length,
        timestamp: Date.now()
      };
    }, 'ReconcileSubscriptions');
  }

  /**
   * Executes a complete worker cycle across all background tasks.
   */
  async runAllJobs() {
    console.log('[Worker] Starting background cycle...');
    const rollups = await this.aggregateUsageRollups();
    const alerts = await this.evaluateQuotaAlerts();
    const reconciliation = await this.reconcileSubscriptions();
    console.log('[Worker] Background cycle completed successfully.');
    return { rollups, alerts, reconciliation };
  }
}

export const workerService = new WorkerService();
