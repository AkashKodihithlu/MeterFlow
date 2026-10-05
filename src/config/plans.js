/**
 * MeterFlow Subscription Plans & Quota Definitions
 */

export const PLANS = {
  free: {
    id: 'free',
    name: 'Free Plan',
    monthly_price_cents: 0,
    quotas: {
      api_calls: 1000,           // 1,000 calls / month
      ai_tokens: 100000          // 100k tokens / month
    },
    features: [
      'Basic API Access',
      'Community Support',
      'Standard Rate Limits'
    ]
  },
  pro: {
    id: 'pro',
    name: 'Pro Plan',
    monthly_price_cents: 4900,  // $49.00 / month
    stripe_price_id: 'price_meterflow_pro_monthly',
    quotas: {
      api_calls: 50000,          // 50,000 calls / month
      ai_tokens: 5000000         // 5,000,000 tokens / month (5M)
    },
    features: [
      'High-throughput API Access',
      'Dedicated Support',
      'Advanced Token Metering & Rollups',
      'Reasoning Token Optimization'
    ]
  }
};

export function getPlan(planId) {
  return PLANS[planId] || PLANS.free;
}
