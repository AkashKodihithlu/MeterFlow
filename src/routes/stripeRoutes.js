import express from 'express';
import { stripeService } from '../services/stripeService.js';

const router = express.Router();

/**
 * Initiates a Stripe Checkout Session for upgrading a tenant to Pro.
 */
router.post('/api/v1/checkout/create-session', async (req, res, next) => {
  try {
    const { tenant_id, success_url, cancel_url } = req.body;

    if (!tenant_id) {
      return res.status(400).json({
        error: 'MissingTenantId',
        code: 400,
        message: "Field 'tenant_id' is required to create a checkout session."
      });
    }

    const session = await stripeService.createCheckoutSession({
      tenantId: tenant_id,
      successUrl: success_url,
      cancelUrl: cancel_url
    });

    return res.status(200).json({
      success: true,
      session_id: session.session_id,
      url: session.url,
      plan_id: session.plan_id,
      tenant_id: session.tenant_id
    });
  } catch (err) {
    next(err);
  }
});

router.post('/checkout/create-session', (req, res, next) => {
  // Alias to v1
  req.url = '/api/v1/checkout/create-session';
  router.handle(req, res, next);
});

/**
 * Stripe Webhook Ingestion Endpoint.
 * Expects raw body buffer for signature verification.
 */
router.post('/webhooks/stripe', (req, res, next) => {
  const signature = req.headers['stripe-signature'];
  const rawBody = req.rawBody || req.body;

  if (!signature) {
    return res.status(400).json({
      error: 'MissingSignature',
      code: 400,
      message: 'No stripe-signature header provided on webhook request.'
    });
  }

  let event;
  try {
    event = stripeService.verifyWebhookSignature(rawBody, signature);
  } catch (err) {
    // Probe 4: Forged signature -> 400 Bad Request
    return res.status(400).json({
      error: 'InvalidSignature',
      code: 400,
      message: `Webhook signature verification failed: ${err.message}`
    });
  }

  try {
    const outcome = stripeService.handleWebhookEvent(event);
    return res.status(200).json(outcome);
  } catch (err) {
    next(err);
  }
});

export default router;
