/**
 * Billing Routes
 *
 * Stripe integration endpoints:
 *   GET  /api/billing/config   — Stripe publishable key (public)
 *   GET  /api/billing/plans    — Available plan definitions (public)
 *   GET  /api/billing/status   — Subscription status + credits (auth)
 *   GET  /api/billing/usage    — Credit usage breakdown (auth)
 *   POST /api/billing/checkout — Create Stripe checkout session (auth)
 *   POST /api/billing/portal   — Create Stripe portal session (auth)
 *   POST /api/billing/webhook  — Stripe webhook handler (no auth, raw body)
 */

import { Router, Request, Response } from 'express';
import { config } from '../config/index.js';
import { requireAuth, requireSubscription } from '../middleware/subscription.js';
import {
  createCheckoutSession,
  createPortalSession,
  constructWebhookEvent,
  handleWebhookEvent,
} from '../services/stripeService.js';
import {
  getSubscription,
  getAvailablePlans,
  getFeatureFlags,
  getTenantMemberCount,
  getTenantDocumentCount,
} from '../services/subscriptionService.js';
import {
  checkCredit,
  getMonthlyUsageBreakdown,
  getUsageTrend,
} from '../services/creditService.js';

const router = Router();

// ─── Public Endpoints ───────────────────────────────────────────────────────

/**
 * GET /config — Returns Stripe publishable key for frontend initialization.
 */
router.get('/config', (_req: Request, res: Response) => {
  res.json({
    publishableKey: config.stripe.publishableKey || '',
    billingEnabled: config.stripe.isConfigured,
  });
});

/**
 * GET /plans — Returns all available plan definitions.
 */
router.get('/plans', async (_req: Request, res: Response) => {
  try {
    const plans = await getAvailablePlans();
    res.json({ plans: plans || [], billingEnabled: config.stripe.isConfigured });
  } catch (err) {
    console.error('Error fetching plans:', err);
    // Return empty plans instead of 500 — table may not exist yet
    res.json({ plans: [], billingEnabled: config.stripe.isConfigured });
  }
});

// ─── Authenticated Endpoints ────────────────────────────────────────────────

/**
 * GET /status — Returns subscription status, plan info, and credit usage.
 */
router.get('/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).tenantId;

    if (!tenantId) {
      res.json({
        hasSubscription: false,
        status: 'none',
        plan: null,
        credits: null,
        features: null,
      });
      return;
    }

    const [subscription, creditCheck, features, memberCount, documentCount] = await Promise.all([
      getSubscription(tenantId),
      checkCredit(tenantId),
      getFeatureFlags(tenantId),
      getTenantMemberCount(tenantId),
      getTenantDocumentCount(tenantId),
    ]);

    res.json({
      hasSubscription: !!subscription,
      status: subscription?.status || 'none',
      plan: subscription ? {
        name: subscription.plan.name,
        displayName: subscription.plan.display_name,
        priceMonthly: subscription.plan.price_monthly,
      } : null,
      billing: subscription ? {
        cycle: subscription.billing_cycle,
        currentPeriodEnd: subscription.current_period_end,
        canceledAt: subscription.canceled_at,
        hasStripeSubscription: !!subscription.stripe_subscription_id,
      } : null,
      credits: creditCheck,
      features,
      usage: {
        members: memberCount,
        maxMembers: features?.maxSeats || 1,
        documents: documentCount,
        maxDocuments: features?.maxDocuments || 0,
      },
    });
  } catch (err) {
    console.error('Error fetching billing status:', err);
    // Return a safe fallback instead of 500 — DB tables may not exist yet
    res.json({
      hasSubscription: false,
      status: 'unavailable',
      plan: null,
      billing: null,
      credits: null,
      features: null,
      usage: null,
      billingEnabled: config.stripe.isConfigured,
    });
  }
});

/**
 * GET /usage — Returns detailed credit usage breakdown (requires subscription).
 */
router.get('/usage', requireAuth, requireSubscription, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).tenantId;

    const [monthly, trend, creditCheck] = await Promise.all([
      getMonthlyUsageBreakdown(tenantId),
      getUsageTrend(tenantId, 6),
      checkCredit(tenantId),
    ]);

    res.json({
      currentMonth: monthly,
      trend,
      credits: creditCheck,
    });
  } catch (err) {
    console.error('Error fetching usage:', err);
    res.status(500).json({ error: 'Failed to fetch usage data' });
  }
});

/**
 * POST /checkout — Creates a Stripe Checkout Session.
 */
router.post('/checkout', requireAuth, async (req: Request, res: Response) => {
  if (!config.stripe.isConfigured) {
    res.status(503).json({ error: 'Billing is not configured. Please contact support.' });
    return;
  }
  try {
    const tenantId = (req as any).tenantId;
    const user = (req as any).user;
    const { priceId, seats } = req.body;

    if (!priceId) {
      res.status(400).json({ error: 'priceId is required' });
      return;
    }

    // ── Seat Validation per Plan ──
    // Look up which plan this priceId belongs to for validation
    const allPlans = await getAvailablePlans();
    const matchedPlan = allPlans.find(p =>
      p.features?.stripe_price_id_monthly === priceId ||
      p.features?.stripe_price_id_yearly === priceId
    );

    if (matchedPlan) {
      // Enterprise: must contact sales, no self-serve checkout
      if (matchedPlan.name === 'enterprise') {
        res.status(400).json({
          error: 'custom_pricing_required',
          message: 'Enterprise plans require custom pricing. Please contact sales@horizonlegal.ai.',
        });
        return;
      }

      // Starter: cannot exceed 1 seat
      if (matchedPlan.name === 'starter' && seats && seats > 1) {
        res.status(400).json({
          error: 'seat_limit_exceeded',
          message: 'Starter plan is limited to 1 seat.',
        });
        return;
      }

      // Team: base 3 seats, expandable up to 7 at $99/seat
      if (matchedPlan.name === 'team' && seats && seats > 7) {
        res.status(400).json({
          error: 'seat_limit_exceeded',
          message: 'Team plan supports up to 7 seats. For 8+ seats, consider the Firm plan.',
        });
        return;
      }

      // Firm: must have minimum 8 seats
      if (matchedPlan.name === 'firm' && (!seats || seats < 8)) {
        res.status(400).json({
          error: 'minimum_seats_required',
          message: 'Firm plan requires a minimum of 8 seats.',
        });
        return;
      }
    }

    if (!tenantId) {
      res.status(403).json({
        error: 'no_tenant',
        message: 'No organization found. Please contact support.',
      });
      return;
    }

    const origin = req.headers.origin || req.headers.referer || 'http://localhost:5173';

    const { url, sessionId } = await createCheckoutSession({
      tenantId,
      email: user.email,
      priceId,
      seats,
      successUrl: origin,
      cancelUrl: origin,
    });

    res.json({ url, sessionId });
  } catch (err) {
    console.error('Error creating checkout session:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

/**
 * POST /portal — Creates a Stripe Customer Portal session.
 */
router.post('/portal', requireAuth, requireSubscription, async (req: Request, res: Response) => {
  if (!config.stripe.isConfigured) {
    res.status(503).json({ error: 'Billing is not configured. Please contact support.' });
    return;
  }
  try {
    const tenantId = (req as any).tenantId;
    const subscription = await getSubscription(tenantId);

    if (!subscription?.stripe_customer_id) {
      res.status(400).json({
        error: 'no_stripe_customer',
        message: 'No Stripe customer found. Please contact support.',
      });
      return;
    }

    const origin = req.headers.origin || req.headers.referer || 'http://localhost:5173';

    const { url } = await createPortalSession(
      subscription.stripe_customer_id,
      origin,
    );

    res.json({ url });
  } catch (err) {
    console.error('Error creating portal session:', err);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// ─── Webhook (no auth — Stripe verifies via signature) ──────────────────────

/**
 * POST /webhook — Stripe webhook handler. Must receive raw body.
 * This route is mounted BEFORE express.json() in app.ts.
 */
router.post('/webhook', async (req: Request, res: Response) => {
  if (!config.stripe.isConfigured) {
    res.status(503).json({ error: 'Billing webhooks not configured' });
    return;
  }
  const signature = req.headers['stripe-signature'];

  if (!signature) {
    res.status(400).json({ error: 'Missing stripe-signature header' });
    return;
  }

  try {
    // req.body is a raw Buffer when mounted correctly
    const event = constructWebhookEvent(req.body as Buffer, signature as string);
    const result = await handleWebhookEvent(event);

    res.json({ received: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[WEBHOOK] Error:', message);
    res.status(400).json({ error: `Webhook error: ${message}` });
  }
});

export default router;
