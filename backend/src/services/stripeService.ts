/**
 * Stripe Service
 *
 * Handles all Stripe API interactions:
 * - Customer creation
 * - Checkout session creation
 * - Customer portal sessions
 * - Webhook event handling
 */

import Stripe from 'stripe';
import { config } from '../config/index.js';
import { supabaseAdmin } from '../config/supabase.js';

// Only initialize Stripe when keys are configured
const stripe = config.stripe.isConfigured
  ? new Stripe(config.stripe.secretKey, {
      apiVersion: '2025-02-24.acacia' as any,
      typescript: true,
    })
  : null;

function requireStripe(): Stripe {
  if (!stripe) {
    throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_PUBLISHABLE_KEY.');
  }
  return stripe;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CheckoutSessionParams {
  tenantId: string;
  email: string;
  priceId: string;
  seats?: number;
  successUrl: string;
  cancelUrl: string;
}

export interface WebhookResult {
  event: string;
  handled: boolean;
  error?: string;
}

// ─── Customer Management ────────────────────────────────────────────────────

/**
 * Create or retrieve a Stripe customer for a tenant.
 */
export async function getOrCreateCustomer(
  tenantId: string,
  email: string,
  name?: string,
): Promise<string> {
  // Check if customer already exists
  const { data: subscription } = await supabaseAdmin
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('tenant_id', tenantId)
    .not('stripe_customer_id', 'is', null)
    .maybeSingle();

  if (subscription?.stripe_customer_id) {
    return subscription.stripe_customer_id;
  }

  // Create new Stripe customer
  const customer = await requireStripe().customers.create({
    email,
    name: name || email,
    metadata: {
      tenant_id: tenantId,
    },
  });

  // Update subscription record with customer ID
  await supabaseAdmin
    .from('subscriptions')
    .update({ stripe_customer_id: customer.id })
    .eq('tenant_id', tenantId);

  return customer.id;
}

// ─── Checkout ───────────────────────────────────────────────────────────────

/**
 * Create a Stripe Checkout Session for subscription purchase or upgrade.
 */
export async function createCheckoutSession(
  params: CheckoutSessionParams,
): Promise<{ url: string; sessionId: string }> {
  const { tenantId, email, priceId, seats, successUrl, cancelUrl } = params;

  const customerId = await getOrCreateCustomer(tenantId, email);

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    {
      price: priceId,
      quantity: seats || 1,
    },
  ];

  const session = await requireStripe().checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: lineItems,
    success_url: `${successUrl}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${cancelUrl}?checkout=canceled`,
    metadata: {
      tenant_id: tenantId,
    },
    subscription_data: {
      metadata: {
        tenant_id: tenantId,
      },
    },
    allow_promotion_codes: true,
    billing_address_collection: 'required',
  });

  return {
    url: session.url!,
    sessionId: session.id,
  };
}

// ─── Customer Portal ────────────────────────────────────────────────────────

/**
 * Create a Stripe Customer Portal session for managing billing.
 */
export async function createPortalSession(
  stripeCustomerId: string,
  returnUrl: string,
): Promise<{ url: string }> {
  const session = await requireStripe().billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl,
  });

  return { url: session.url };
}

// ─── Webhook Event Handling ─────────────────────────────────────────────────

/**
 * Verify and parse a Stripe webhook event.
 */
export function constructWebhookEvent(
  payload: Buffer,
  signature: string,
): Stripe.Event {
  return requireStripe().webhooks.constructEvent(
    payload,
    signature,
    config.stripe.webhookSecret,
  );
}

/**
 * Handle a Stripe webhook event — dispatches to individual handlers.
 */
export async function handleWebhookEvent(event: Stripe.Event): Promise<WebhookResult> {
  console.log(`[STRIPE] Webhook received: ${event.type}`);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        return { event: event.type, handled: true };

      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object as Stripe.Invoice);
        return { event: event.type, handled: true };

      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object as Stripe.Invoice);
        return { event: event.type, handled: true };

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        return { event: event.type, handled: true };

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        return { event: event.type, handled: true };

      default:
        console.log(`[STRIPE] Unhandled event: ${event.type}`);
        return { event: event.type, handled: false };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[STRIPE] Error handling ${event.type}:`, message);
    return { event: event.type, handled: false, error: message };
  }
}

// ─── Individual Webhook Handlers ────────────────────────────────────────────

/**
 * Checkout completed — activate subscription.
 */
async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const tenantId = session.metadata?.tenant_id;
  if (!tenantId) {
    console.error('[STRIPE] checkout.session.completed missing tenant_id in metadata');
    return;
  }

  const subscriptionId = session.subscription as string;
  const customerId = session.customer as string;

  // Fetch the Stripe subscription to get details
  const stripeSubscription = await requireStripe().subscriptions.retrieve(subscriptionId);
  const stripePriceId = stripeSubscription.items.data[0]?.price?.id;

  // Look up the pricing tier by Stripe price ID
  const { data: pricingTier } = await supabaseAdmin
    .from('pricing_tiers')
    .select('id, name')
    .or(`stripe_price_id_monthly.eq.${stripePriceId},stripe_price_id_yearly.eq.${stripePriceId}`)
    .maybeSingle();

  if (!pricingTier) {
    console.error(`[STRIPE] No pricing tier found for Stripe price: ${stripePriceId}`);
    return;
  }

  // Update subscription in database
  const { error } = await supabaseAdmin
    .from('subscriptions')
    .update({
      stripe_subscription_id: subscriptionId,
      stripe_customer_id: customerId,
      pricing_tier_id: pricingTier.id,
      status: 'active',
      current_period_start: new Date(stripeSubscription.current_period_start * 1000).toISOString(),
      current_period_end: new Date(stripeSubscription.current_period_end * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('tenant_id', tenantId);

  if (error) {
    console.error('[STRIPE] Failed to update subscription:', error.message);
    return;
  }

  // Update tenant plan
  await supabaseAdmin
    .from('tenants')
    .update({
      plan: pricingTier.name,
      pricing_tier_id: pricingTier.id,
      subscription_status: 'active',
    })
    .eq('id', tenantId);

  console.log(`[STRIPE] Subscription activated for tenant ${tenantId}, plan: ${pricingTier.name}`);
}

/**
 * Payment succeeded — extend period and reset credits.
 */
async function handlePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
  const subscriptionId = invoice.subscription as string;
  if (!subscriptionId) return;

  const stripeSubscription = await requireStripe().subscriptions.retrieve(subscriptionId);
  const tenantId = stripeSubscription.metadata?.tenant_id;
  if (!tenantId) return;

  // Extend subscription period
  await supabaseAdmin
    .from('subscriptions')
    .update({
      status: 'active',
      current_period_start: new Date(stripeSubscription.current_period_start * 1000).toISOString(),
      current_period_end: new Date(stripeSubscription.current_period_end * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('tenant_id', tenantId);

  // Ensure tenant status is active (recovers from past_due)
  await supabaseAdmin
    .from('tenants')
    .update({ subscription_status: 'active' })
    .eq('id', tenantId);

  console.log(`[STRIPE] Payment succeeded for tenant ${tenantId}`);
}

/**
 * Payment failed — set past_due with grace period.
 */
async function handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const subscriptionId = invoice.subscription as string;
  if (!subscriptionId) return;

  const stripeSubscription = await requireStripe().subscriptions.retrieve(subscriptionId);
  const tenantId = stripeSubscription.metadata?.tenant_id;
  if (!tenantId) return;

  const attemptCount = invoice.attempt_count || 1;

  // First failure: soft warning (past_due but still functional via grace)
  // After 3 attempts or 7+ days past_due: hard block
  const status = attemptCount >= 3 ? 'suspended' : 'past_due';

  await supabaseAdmin
    .from('subscriptions')
    .update({
      status: status,
      updated_at: new Date().toISOString(),
    })
    .eq('tenant_id', tenantId);

  await supabaseAdmin
    .from('tenants')
    .update({ subscription_status: status })
    .eq('id', tenantId);

  console.log(`[STRIPE] Payment failed for tenant ${tenantId}, status: ${status}, attempt: ${attemptCount}`);
}

/**
 * Subscription updated — handle plan changes (upgrade/downgrade).
 */
async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
  const tenantId = subscription.metadata?.tenant_id;
  if (!tenantId) return;

  const stripePriceId = subscription.items.data[0]?.price?.id;

  // Look up new pricing tier
  const { data: pricingTier } = await supabaseAdmin
    .from('pricing_tiers')
    .select('id, name')
    .or(`stripe_price_id_monthly.eq.${stripePriceId},stripe_price_id_yearly.eq.${stripePriceId}`)
    .maybeSingle();

  if (!pricingTier) return;

  // Map Stripe status to our status
  const statusMap: Record<string, string> = {
    active: 'active',
    past_due: 'past_due',
    canceled: 'canceled',
    unpaid: 'suspended',
    incomplete: 'pending',
    incomplete_expired: 'canceled',
    trialing: 'trialing',
    paused: 'suspended',
  };

  const dbStatus = statusMap[subscription.status] || 'active';

  await supabaseAdmin
    .from('subscriptions')
    .update({
      pricing_tier_id: pricingTier.id,
      status: dbStatus,
      current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('tenant_id', tenantId);

  await supabaseAdmin
    .from('tenants')
    .update({
      plan: pricingTier.name,
      pricing_tier_id: pricingTier.id,
      subscription_status: dbStatus,
    })
    .eq('id', tenantId);

  console.log(`[STRIPE] Subscription updated for tenant ${tenantId}, plan: ${pricingTier.name}, status: ${dbStatus}`);
}

/**
 * Subscription deleted — revoke access.
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  const tenantId = subscription.metadata?.tenant_id;
  if (!tenantId) return;

  await supabaseAdmin
    .from('subscriptions')
    .update({
      status: 'canceled',
      canceled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('tenant_id', tenantId);

  await supabaseAdmin
    .from('tenants')
    .update({ subscription_status: 'canceled' })
    .eq('id', tenantId);

  console.log(`[STRIPE] Subscription canceled for tenant ${tenantId}`);
}

// ─── Utility ────────────────────────────────────────────────────────────────

/**
 * Get Stripe subscription details for a tenant.
 */
export async function getStripeSubscription(
  stripeSubscriptionId: string,
): Promise<Stripe.Subscription | null> {
  try {
    return await requireStripe().subscriptions.retrieve(stripeSubscriptionId);
  } catch {
    return null;
  }
}

export { stripe };
