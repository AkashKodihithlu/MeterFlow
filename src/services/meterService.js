import { getDb } from '../db/index.js';
import { quotaService } from './quotaService.js';
import { costService } from './costService.js';
import crypto from 'crypto';

export class MeterService {
  constructor(db = null) {
    this.db = db || getDb();
  }

  /**
   * Generates a deterministic hash of the request payload to ensure idempotency keys
   * are not mismatched with different payloads.
   */
  hashRequest(payload) {
    return crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex');
  }

  /**
   * Records a billable action with strict exactly-once idempotency guarantees.
   * 
   * @param {Object} params
   * @param {string} params.tenantId
   * @param {string} params.idempotencyKey
   * @param {string} params.eventType
   * @param {number} params.apiCalls
   * @param {number} params.inputTokens
   * @param {number} params.cachedInputTokens
   * @param {number} params.outputTokens
   * @param {number} params.reasoningTokens
   * @param {Object} params.rawRequestPayload
   * @returns {Object} Resulting HTTP status, headers, body, and replay indicator
   */
  record({
    tenantId,
    idempotencyKey,
    eventType = 'ai_generation',
    apiCalls = 1,
    inputTokens = 0,
    cachedInputTokens = 0,
    outputTokens = 0,
    reasoningTokens = 0,
    rawRequestPayload = {}
  }) {
    if (!idempotencyKey) {
      throw new Error('Idempotency key is strictly required for billable operations.');
    }

    const requestHash = this.hashRequest(rawRequestPayload);

    // 1. Check if idempotency key has already been processed
    const existing = this.db.prepare(`
      SELECT * FROM idempotency_records WHERE idempotency_key = ?
    `).get(idempotencyKey);

    if (existing) {
      // Replay original response identically
      return {
        isReplay: true,
        statusCode: existing.status_code,
        headers: JSON.parse(existing.response_headers || '{}'),
        body: JSON.parse(existing.response_body)
      };
    }

    // 2. Perform Quota Check before recording billable action
    const totalTokens = Math.max(0, inputTokens) + 
                        Math.max(0, cachedInputTokens) + 
                        Math.max(0, outputTokens) + 
                        Math.max(0, reasoningTokens);

    const quotaCheck = quotaService.checkQuota({
      tenantId,
      requestedApiCalls: apiCalls,
      requestedTokens: totalTokens
    });

    if (!quotaCheck.allowed) {
      const errorHeaders = {};
      if (quotaCheck.retryAfter) {
        errorHeaders['Retry-After'] = String(quotaCheck.retryAfter);
      }

      // Persist the rejection so client retries receive the exact same response
      const saveRejection = this.db.prepare(`
        INSERT INTO idempotency_records (idempotency_key, tenant_id, request_hash, status_code, response_headers, response_body, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      saveRejection.run(
        idempotencyKey,
        tenantId,
        requestHash,
        quotaCheck.status,
        JSON.stringify(errorHeaders),
        JSON.stringify(quotaCheck.error),
        Date.now()
      );

      return {
        isReplay: false,
        statusCode: quotaCheck.status,
        headers: errorHeaders,
        body: quotaCheck.error
      };
    }

    // 3. Calculate Cost using Pinned Pricing Rules
    const costCalculation = costService.calculate({
      input_tokens: inputTokens,
      cached_input_tokens: cachedInputTokens,
      output_tokens: outputTokens,
      reasoning_tokens: reasoningTokens,
      api_calls: apiCalls
    });

    const now = Date.now();
    const eventId = `evt_${crypto.randomUUID()}`;

    const responseBody = {
      success: true,
      event_id: eventId,
      tenant_id: tenantId,
      event_type: eventType,
      idempotency_key: idempotencyKey,
      timestamp: new Date(now).toISOString(),
      usage: {
        api_calls: apiCalls,
        tokens: {
          input_tokens: inputTokens,
          cached_input_tokens: cachedInputTokens,
          output_tokens: outputTokens,
          reasoning_tokens: reasoningTokens,
          total_tokens: totalTokens
        }
      },
      cost: {
        total_nanodollars: costCalculation.total_cost_nanodollars,
        total_cents: costCalculation.total_cost_cents,
        total_usd: costCalculation.total_cost_usd,
        breakdown_nanodollars: costCalculation.breakdown_nanodollars
      },
      remaining_quota: {
        api_calls: quotaCheck.subscription.api_calls_quota - quotaCheck.projectedUsage.api_calls,
        ai_tokens: quotaCheck.subscription.ai_tokens_quota - quotaCheck.projectedUsage.tokens
      }
    };

    const responseHeaders = {
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey,
      'X-Usage-Event-Id': eventId
    };

    // 4. Atomic Execution: Write usage_event and idempotency_record together
    const insertTransaction = this.db.transaction(() => {
      const insertEvent = this.db.prepare(`
        INSERT INTO usage_events (
          id, tenant_id, event_type, api_calls_count, 
          input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, 
          total_tokens, cost_nanodollars, idempotency_key, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertEvent.run(
        eventId,
        tenantId,
        eventType,
        apiCalls,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningTokens,
        totalTokens,
        costCalculation.total_cost_nanodollars,
        idempotencyKey,
        now
      );

      const insertIdempotency = this.db.prepare(`
        INSERT INTO idempotency_records (
          idempotency_key, tenant_id, request_hash, status_code, 
          response_headers, response_body, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      insertIdempotency.run(
        idempotencyKey,
        tenantId,
        requestHash,
        200,
        JSON.stringify(responseHeaders),
        JSON.stringify(responseBody),
        now
      );
    });

    insertTransaction();

    return {
      isReplay: false,
      statusCode: 200,
      headers: responseHeaders,
      body: responseBody
    };
  }
}

export const meterService = new MeterService();
