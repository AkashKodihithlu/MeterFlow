/**
 * MeterFlow Pinned Pricing Constants & Currency Math
 * 
 * Money is stored and computed strictly using integers (nanodollars) to prevent any
 * IEEE 754 floating-point rounding errors.
 * 1 USD = 100 Cents = 1,000,000,000 Nanodollars
 * 1 Cent = 10,000,000 Nanodollars
 */

export const CURRENCY = {
  NANODOLLARS_PER_USD: 1000000000,
  NANODOLLARS_PER_CENT: 10000000,
  MICROCENTS_PER_CENT: 1000000
};

export const PINNED_PRICING = {
  // Rates per single unit in Nanodollars
  // Formula: (Price per 1M units / 1,000,000) * 1,000,000,000
  INPUT_TOKEN_NANODOLLARS: 1500,           // $1.50 per 1M tokens ($0.00000150/token)
  CACHED_INPUT_TOKEN_NANODOLLARS: 375,     // $0.375 per 1M tokens ($0.000000375/token) -> 75% discount
  OUTPUT_TOKEN_NANODOLLARS: 6000,          // $6.00 per 1M tokens ($0.00000600/token)
  REASONING_TOKEN_NANODOLLARS: 6000,       // $6.00 per 1M tokens -> reasoning tokens count as output tokens
  API_CALL_NANODOLLARS: 1000000            // $0.001 per API call ($1.00 per 1,000 calls)
};

/**
 * Calculates cost breakdown for token & call consumption using pure integer math.
 * 
 * @param {Object} usage
 * @param {number} usage.input_tokens
 * @param {number} usage.cached_input_tokens
 * @param {number} usage.output_tokens
 * @param {number} usage.reasoning_tokens
 * @param {number} usage.api_calls
 * @returns {Object} Cost details in nanodollars, cents, and formatted USD
 */
export function calculateUsageCost({
  input_tokens = 0,
  cached_input_tokens = 0,
  output_tokens = 0,
  reasoning_tokens = 0,
  api_calls = 0
}) {
  const inputTokensCostNano = BigInt(Math.max(0, input_tokens)) * BigInt(PINNED_PRICING.INPUT_TOKEN_NANODOLLARS);
  const cachedInputCostNano = BigInt(Math.max(0, cached_input_tokens)) * BigInt(PINNED_PRICING.CACHED_INPUT_TOKEN_NANODOLLARS);
  const outputTokensCostNano = BigInt(Math.max(0, output_tokens)) * BigInt(PINNED_PRICING.OUTPUT_TOKEN_NANODOLLARS);
  const reasoningTokensCostNano = BigInt(Math.max(0, reasoning_tokens)) * BigInt(PINNED_PRICING.REASONING_TOKEN_NANODOLLARS);
  const apiCallsCostNano = BigInt(Math.max(0, api_calls)) * BigInt(PINNED_PRICING.API_CALL_NANODOLLARS);

  const totalTokensCostNano = inputTokensCostNano + cachedInputCostNano + outputTokensCostNano + reasoningTokensCostNano;
  const totalCostNano = totalTokensCostNano + apiCallsCostNano;

  // Convert to integer cents (standard rounding to nearest cent)
  const totalCents = Number((totalCostNano + BigInt(CURRENCY.NANODOLLARS_PER_CENT / 2)) / BigInt(CURRENCY.NANODOLLARS_PER_CENT));
  
  // Format to standard human-readable USD with 6 decimal places for precision display
  const totalUsdFormatted = (Number(totalCostNano) / CURRENCY.NANODOLLARS_PER_USD).toFixed(6);

  return {
    breakdown_nanodollars: {
      input_tokens: Number(inputTokensCostNano),
      cached_input_tokens: Number(cachedInputCostNano),
      output_tokens: Number(outputTokensCostNano),
      reasoning_tokens: Number(reasoningTokensCostNano),
      api_calls: Number(apiCallsCostNano),
      total_tokens: Number(totalTokensCostNano),
      total: Number(totalCostNano)
    },
    total_cost_nanodollars: Number(totalCostNano),
    total_cost_cents: totalCents,
    total_cost_usd: `$${(Number(totalCostNano) / CURRENCY.NANODOLLARS_PER_USD).toFixed(4)}`,
    raw_usd_value: Number(totalCostNano) / CURRENCY.NANODOLLARS_PER_USD,
    pricing_model: {
      fresh_input_rate_per_1m: '$1.50',
      cached_input_rate_per_1m: '$0.375',
      output_rate_per_1m: '$6.00',
      reasoning_rate_per_1m: '$6.00',
      api_call_rate: '$0.001'
    }
  };
}
