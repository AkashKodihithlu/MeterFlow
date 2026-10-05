import express from 'express';
import { validateMeterRequest } from '../middleware/validate.js';
import { meterService } from '../services/meterService.js';

const router = express.Router();

/**
 * Billable action handler (dummy AI generation endpoint).
 * Exercises: Idempotent metering -> Quota Check -> Exact Token Cost Calculation
 */
function handleBillableGeneration(req, res, next) {
  try {
    const {
      tenant_id,
      model = 'gpt-4o-mini',
      prompt = '',
      input_tokens = 500,
      cached_input_tokens = 0,
      output_tokens = 150,
      reasoning_tokens = 0,
      api_calls = 1
    } = req.body;

    const result = meterService.record({
      tenantId: tenant_id,
      idempotencyKey: req.idempotencyKey,
      eventType: 'ai_generation',
      apiCalls: api_calls,
      inputTokens: input_tokens,
      cachedInputTokens: cached_input_tokens,
      outputTokens: output_tokens,
      reasoningTokens: reasoning_tokens,
      rawRequestPayload: req.body
    });

    // Apply response headers (e.g. Retry-After, X-Idempotency-Key)
    if (result.headers) {
      for (const [key, value] of Object.entries(result.headers)) {
        res.setHeader(key, value);
      }
    }

    if (result.isReplay) {
      res.setHeader('X-Cache-Lookup', 'HIT');
      res.setHeader('X-Idempotent-Replay', 'true');
    }

    return res.status(result.statusCode).json(result.body);
  } catch (err) {
    next(err);
  }
}

// Support both standard v1 path and direct root path per capstone spec
router.post('/api/v1/generate', validateMeterRequest, handleBillableGeneration);
router.post('/generate', validateMeterRequest, handleBillableGeneration);

// Explicit meter recording endpoint
router.post('/api/v1/meter/record', validateMeterRequest, (req, res, next) => {
  try {
    const {
      tenant_id,
      event_type = 'api_call',
      api_calls = 1,
      input_tokens = 0,
      cached_input_tokens = 0,
      output_tokens = 0,
      reasoning_tokens = 0
    } = req.body;

    const result = meterService.record({
      tenantId: tenant_id,
      idempotencyKey: req.idempotencyKey,
      eventType: event_type,
      apiCalls: api_calls,
      inputTokens: input_tokens,
      cachedInputTokens: cached_input_tokens,
      outputTokens: output_tokens,
      reasoningTokens: reasoning_tokens,
      rawRequestPayload: req.body
    });

    if (result.headers) {
      for (const [key, value] of Object.entries(result.headers)) {
        res.setHeader(key, value);
      }
    }

    if (result.isReplay) {
      res.setHeader('X-Cache-Lookup', 'HIT');
    }

    return res.status(result.statusCode).json(result.body);
  } catch (err) {
    next(err);
  }
});

export default router;
