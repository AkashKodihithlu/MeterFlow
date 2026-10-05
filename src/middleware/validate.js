/**
 * Input boundary validator for metering & generation requests.
 */

export function validateMeterRequest(req, res, next) {
  const body = req.body || {};
  const idempotencyKey = req.headers['idempotency-key'] || body.idempotency_key;

  if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    return res.status(400).json({
      error: 'MissingIdempotencyKey',
      code: 400,
      message: "An 'Idempotency-Key' header or body field is required for billable requests."
    });
  }

  const tenantId = body.tenant_id;
  if (!tenantId || typeof tenantId !== 'string' || tenantId.trim().length === 0) {
    return res.status(400).json({
      error: 'MissingTenantId',
      code: 400,
      message: "A non-empty 'tenant_id' string is required."
    });
  }

  // Validate token fields if present
  const tokenFields = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'api_calls'];
  for (const field of tokenFields) {
    if (field in body) {
      const val = body[field];
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) {
        return res.status(400).json({
          error: 'InvalidParameter',
          code: 400,
          message: `Field '${field}' must be a non-negative integer.`
        });
      }
    }
  }

  // Attach parsed idempotencyKey to req
  req.idempotencyKey = idempotencyKey.trim();
  next();
}
