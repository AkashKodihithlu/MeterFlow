import { calculateUsageCost, PINNED_PRICING, CURRENCY } from '../config/pricing.js';

export class CostService {
  /**
   * Calculates cost for a specific billable action or period aggregate.
   */
  calculate(usage) {
    return calculateUsageCost(usage);
  }

  /**
   * Returns metadata and rate table for transparency.
   */
  getPricingModel() {
    return {
      currency: 'USD',
      precision: 'nanodollars (10^-9 USD) / integer cents',
      rates: {
        input_tokens: {
          rate_per_1m: '$1.50',
          cost_per_token_nanodollars: PINNED_PRICING.INPUT_TOKEN_NANODOLLARS,
          description: 'Standard prompt input tokens'
        },
        cached_input_tokens: {
          rate_per_1m: '$0.375',
          cost_per_token_nanodollars: PINNED_PRICING.CACHED_INPUT_TOKEN_NANODOLLARS,
          discount: '75% discount compared to fresh input'
        },
        output_tokens: {
          rate_per_1m: '$6.00',
          cost_per_token_nanodollars: PINNED_PRICING.OUTPUT_TOKEN_NANODOLLARS,
          description: 'Model generated output tokens'
        },
        reasoning_tokens: {
          rate_per_1m: '$6.00',
          cost_per_token_nanodollars: PINNED_PRICING.REASONING_TOKEN_NANODOLLARS,
          description: 'Model reasoning / thinking tokens (priced as output)'
        },
        api_calls: {
          rate_per_call: '$0.001',
          cost_per_call_nanodollars: PINNED_PRICING.API_CALL_NANODOLLARS,
          description: 'Base gateway request processing'
        }
      }
    };
  }
}

export const costService = new CostService();
