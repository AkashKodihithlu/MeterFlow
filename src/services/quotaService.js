import { getDb } from '../db/index.js';
import { getPlan } from '../config/plans.js';

export class QuotaService {
  constructor(db = null) {
    this.db = db || getDb();
  }

  /**
   * Retrieves tenant subscription, plan, and current billing period boundaries.
   */
  getTenantSubscription(tenantId) {
    const query = this.db.prepare(`
      SELECT 
        s.id as subscription_id,
        s.tenant_id,
        s.plan_id,
        s.status,
        s.current_period_start,
        s.current_period_end,
        t.name as tenant_name,
        t.email as tenant_email,
        t.stripe_customer_id,
        p.name as plan_name,
        p.monthly_price_cents,
        p.api_calls_quota,
        p.ai_tokens_quota
      FROM tenants t
      LEFT JOIN subscriptions s ON t.id = s.tenant_id
      LEFT JOIN plans p ON s.plan_id = p.id
      WHERE t.id = ?
      ORDER BY s.created_at DESC
      LIMIT 1
    `);

    return query.get(tenantId);
  }

  /**
   * Calculates current aggregate usage within the active billing period.
   */
  getPeriodUsage(tenantId, periodStart, periodEnd) {
    const query = this.db.prepare(`
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
    `);

    const row = query.get(tenantId, periodStart, periodEnd);
    return {
      api_calls: Number(row.total_api_calls),
      input_tokens: Number(row.total_input_tokens),
      cached_input_tokens: Number(row.total_cached_input_tokens),
      output_tokens: Number(row.total_output_tokens),
      reasoning_tokens: Number(row.total_reasoning_tokens),
      total_tokens: Number(row.total_tokens),
      cost_nanodollars: Number(row.total_cost_nanodollars)
    };
  }

  /**
   * Performs an honest boundary quota check before allowing a billable action.
   * 
   * @param {Object} params
   * @param {string} params.tenantId
   * @param {number} params.requestedApiCalls
   * @param {number} params.requestedTokens
   * @returns {Object} Allowed flag and status details
   */
  checkQuota({ tenantId, requestedApiCalls = 1, requestedTokens = 0 }) {
    const sub = this.getTenantSubscription(tenantId);

    if (!sub) {
      return {
        allowed: false,
        status: 404,
        error: {
          error: 'NotFound',
          code: 404,
          message: `Tenant '${tenantId}' does not exist.`
        }
      };
    }

    // Check payment / subscription health
    if (sub.status === 'past_due' || sub.status === 'unpaid') {
      return {
        allowed: false,
        status: 402,
        error: {
          error: 'PaymentRequired',
          code: 402,
          message: `Subscription for tenant '${tenantId}' is ${sub.status}. Please update payment method.`,
          tenant_id: tenantId,
          plan: sub.plan_id,
          subscription_status: sub.status
        }
      };
    }

    if (sub.status === 'canceled') {
      return {
        allowed: false,
        status: 402,
        error: {
          error: 'PaymentRequired',
          code: 402,
          message: `Subscription is canceled for tenant '${tenantId}'. Please re-activate or subscribe to continue.`,
          tenant_id: tenantId,
          plan: sub.plan_id
        }
      };
    }

    const currentUsage = this.getPeriodUsage(tenantId, sub.current_period_start, sub.current_period_end);

    const newApiCalls = currentUsage.api_calls + requestedApiCalls;
    const newTokens = currentUsage.total_tokens + requestedTokens;

    const secondsUntilReset = Math.max(1, Math.ceil((sub.current_period_end - Date.now()) / 1000));

    // Boundary rule: exactly at limit is ALLOWED. Above limit is BLOCKED (429).
    if (newApiCalls > sub.api_calls_quota) {
      return {
        allowed: false,
        status: 429,
        retryAfter: secondsUntilReset,
        error: {
          error: 'QuotaExceeded',
          code: 429,
          quota_type: 'api_calls',
          message: `Monthly API call quota exceeded. Plan allows ${sub.api_calls_quota.toLocaleString()} calls; request would reach ${newApiCalls.toLocaleString()}.`,
          tenant_id: tenantId,
          plan: sub.plan_id,
          current_usage: currentUsage.api_calls,
          requested: requestedApiCalls,
          limit: sub.api_calls_quota,
          reset_at: new Date(sub.current_period_end).toISOString(),
          retry_after_seconds: secondsUntilReset
        }
      };
    }

    if (newTokens > sub.ai_tokens_quota) {
      return {
        allowed: false,
        status: 429,
        retryAfter: secondsUntilReset,
        error: {
          error: 'QuotaExceeded',
          code: 429,
          quota_type: 'ai_tokens',
          message: `Monthly AI token quota exceeded. Plan allows ${sub.ai_tokens_quota.toLocaleString()} tokens; request would reach ${newTokens.toLocaleString()}.`,
          tenant_id: tenantId,
          plan: sub.plan_id,
          current_usage: currentUsage.total_tokens,
          requested: requestedTokens,
          limit: sub.ai_tokens_quota,
          reset_at: new Date(sub.current_period_end).toISOString(),
          retry_after_seconds: secondsUntilReset
        }
      };
    }

    return {
      allowed: true,
      subscription: sub,
      currentUsage,
      projectedUsage: {
        api_calls: newApiCalls,
        tokens: newTokens
      }
    };
  }
}

export const quotaService = new QuotaService();
