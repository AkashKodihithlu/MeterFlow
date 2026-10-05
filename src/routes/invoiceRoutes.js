import express from 'express';
import { quotaService } from '../services/quotaService.js';
import { costService } from '../services/costService.js';
import { workerService } from '../services/workerService.js';

const router = express.Router();

/**
 * Health check endpoint
 */
router.get('/health', (req, res) => {
  return res.status(200).json({
    status: 'healthy',
    system: 'MeterFlow Usage Metering & Billing Engine',
    timestamp: new Date().toISOString()
  });
});

/**
 * Generates an itemized monthly invoice statement for a tenant.
 */
router.get('/api/v1/tenants/:id/invoice', (req, res, next) => {
  try {
    const tenantId = req.params.id;
    const sub = quotaService.getTenantSubscription(tenantId);

    if (!sub) {
      return res.status(404).json({
        error: 'NotFound',
        code: 404,
        message: `Tenant '${tenantId}' was not found.`
      });
    }

    const usage = quotaService.getPeriodUsage(tenantId, sub.current_period_start, sub.current_period_end);
    const cost = costService.calculate({
      input_tokens: usage.input_tokens,
      cached_input_tokens: usage.cached_input_tokens,
      output_tokens: usage.output_tokens,
      reasoning_tokens: usage.reasoning_tokens,
      api_calls: usage.api_calls
    });

    const subscriptionFeeCents = sub.monthly_price_cents;
    const totalDueCents = subscriptionFeeCents + cost.total_cents;

    return res.status(200).json({
      invoice_number: `INV-${tenantId.toUpperCase()}-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}`,
      tenant: {
        id: sub.tenant_id,
        name: sub.tenant_name,
        email: sub.tenant_email
      },
      billing_period: {
        start: new Date(sub.current_period_start).toISOString(),
        end: new Date(sub.current_period_end).toISOString()
      },
      line_items: [
        {
          description: `${sub.plan_name} Recurring Base Subscription`,
          unit_amount_cents: subscriptionFeeCents,
          quantity: 1,
          total_cents: subscriptionFeeCents
        },
        {
          description: `API Gateway Calls Metering (${usage.api_calls.toLocaleString()} calls @ $0.001/call)`,
          unit_amount_cents: Math.round(cost.breakdown_nanodollars.api_calls / 10000000),
          quantity: usage.api_calls,
          total_cents: Math.round(cost.breakdown_nanodollars.api_calls / 10000000)
        },
        {
          description: `AI Fresh Input Tokens (${usage.input_tokens.toLocaleString()} tokens @ $1.50/1M)`,
          unit_amount_cents: Math.round(cost.breakdown_nanodollars.input_tokens / 10000000),
          quantity: usage.input_tokens,
          total_cents: Math.round(cost.breakdown_nanodollars.input_tokens / 10000000)
        },
        {
          description: `AI Cached Input Tokens (${usage.cached_input_tokens.toLocaleString()} tokens @ $0.375/1M - 75% Discount)`,
          unit_amount_cents: Math.round(cost.breakdown_nanodollars.cached_input_tokens / 10000000),
          quantity: usage.cached_input_tokens,
          total_cents: Math.round(cost.breakdown_nanodollars.cached_input_tokens / 10000000)
        },
        {
          description: `AI Output & Reasoning Tokens (${(usage.output_tokens + usage.reasoning_tokens).toLocaleString()} tokens @ $6.00/1M)`,
          unit_amount_cents: Math.round((cost.breakdown_nanodollars.output_tokens + cost.breakdown_nanodollars.reasoning_tokens) / 10000000),
          quantity: usage.output_tokens + usage.reasoning_tokens,
          total_cents: Math.round((cost.breakdown_nanodollars.output_tokens + cost.breakdown_nanodollars.reasoning_tokens) / 10000000)
        }
      ],
      summary: {
        subtotal_cents: totalDueCents,
        currency: 'USD',
        total_due_formatted: `$${(totalDueCents / 100).toFixed(2)}`,
        status: sub.status === 'past_due' ? 'PAST_DUE' : 'READY_FOR_PAYMENT'
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Trigger background job execution on demand
 */
router.post('/api/v1/worker/trigger', async (req, res, next) => {
  try {
    const results = await workerService.runAllJobs();
    return res.status(200).json({
      success: true,
      message: 'Background worker jobs executed successfully.',
      results
    });
  } catch (err) {
    next(err);
  }
});

export default router;
