import express from 'express';
import { quotaService } from '../services/quotaService.js';
import { costService } from '../services/costService.js';

const router = express.Router();

function handleGetUsage(req, res, next) {
  try {
    const tenantId = req.query.tenant_id || req.headers['x-tenant-id'];

    if (!tenantId) {
      return res.status(400).json({
        error: 'MissingTenantId',
        code: 400,
        message: "Query parameter 'tenant_id' or header 'x-tenant-id' is required."
      });
    }

    const sub = quotaService.getTenantSubscription(tenantId);
    if (!sub) {
      return res.status(404).json({
        error: 'NotFound',
        code: 404,
        message: `Tenant '${tenantId}' was not found.`
      });
    }

    const usage = quotaService.getPeriodUsage(tenantId, sub.current_period_start, sub.current_period_end);
    const costDetails = costService.calculate({
      input_tokens: usage.input_tokens,
      cached_input_tokens: usage.cached_input_tokens,
      output_tokens: usage.output_tokens,
      reasoning_tokens: usage.reasoning_tokens,
      api_calls: usage.api_calls
    });

    const remainingApiCalls = Math.max(0, sub.api_calls_quota - usage.api_calls);
    const remainingAiTokens = Math.max(0, sub.ai_tokens_quota - usage.total_tokens);

    return res.status(200).json({
      tenant: {
        id: sub.tenant_id,
        name: sub.tenant_name,
        email: sub.tenant_email,
        stripe_customer_id: sub.stripe_customer_id
      },
      plan: {
        id: sub.plan_id,
        name: sub.plan_name,
        monthly_price_cents: sub.monthly_price_cents
      },
      subscription: {
        id: sub.subscription_id,
        status: sub.status,
        current_period_start: new Date(sub.current_period_start).toISOString(),
        current_period_end: new Date(sub.current_period_end).toISOString()
      },
      usage: {
        api_calls: usage.api_calls,
        tokens: {
          input_tokens: usage.input_tokens,
          cached_input_tokens: usage.cached_input_tokens,
          output_tokens: usage.output_tokens,
          reasoning_tokens: usage.reasoning_tokens,
          total_tokens: usage.total_tokens
        }
      },
      limits: {
        api_calls: sub.api_calls_quota,
        ai_tokens: sub.ai_tokens_quota
      },
      remaining: {
        api_calls: remainingApiCalls,
        ai_tokens: remainingAiTokens
      },
      cost: {
        total_nanodollars: costDetails.total_cost_nanodollars,
        total_cents: costDetails.total_cost_cents,
        total_usd: costDetails.total_cost_usd,
        breakdown_nanodollars: costDetails.breakdown_nanodollars
      },
      pricing_rules: costService.getPricingModel()
    });
  } catch (err) {
    next(err);
  }
}

router.get('/api/v1/usage', handleGetUsage);
router.get('/usage', handleGetUsage);

export default router;
