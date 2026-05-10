/**
 * Subscription Middleware
 *
 * Server-side enforcement of subscription status, feature access, and credit limits.
 * These middleware functions are applied to routes that require an active subscription.
 */

import { Request, Response, NextFunction } from 'express';
import { isSubscriptionActive, getFeatureFlags } from '../services/subscriptionService.js';
import { checkCredit } from '../services/creditService.js';
import { supabaseAdmin } from '../config/supabase.js';
import { verifyToken } from '../config/supabase.js';

// ─── Auth + Tenant Resolution ───────────────────────────────────────────────

/**
 * Shared auth middleware that verifies JWT and resolves tenant.
 * Sets req.user, req.tenantId, req.userRole on the request.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.replace('Bearer ', '');
  const user = await verifyToken(token);
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  // Resolve tenant
  const { data: tenantMember } = await supabaseAdmin
    .from('tenant_members')
    .select('tenant_id, role')
    .eq('user_id', user.id)
    .maybeSingle();

  (req as any).user = user;
  (req as any).tenantId = tenantMember?.tenant_id || null;
  (req as any).userRole = tenantMember?.role || null;

  next();
}

// ─── Subscription Enforcement ───────────────────────────────────────────────

/**
 * Requires an active subscription for the tenant.
 * Returns 403 if no subscription, 402 if payment required.
 */
export async function requireSubscription(req: Request, res: Response, next: NextFunction): Promise<void> {
  const tenantId = (req as any).tenantId;

  if (!tenantId) {
    res.status(403).json({
      error: 'subscription_required',
      message: 'No organization found. Please contact support to set up your account.',
      redirect: 'pricing',
    });
    return;
  }

  const status = await isSubscriptionActive(tenantId);

  if (!status.active) {
    if (status.status === 'past_due') {
      res.status(402).json({
        error: 'payment_required',
        message: 'Your payment has failed. Please update your payment method.',
        graceEndsAt: status.graceEndsAt,
      });
      return;
    }

    if (status.status === 'canceled') {
      res.status(403).json({
        error: 'subscription_canceled',
        message: 'Your subscription has been canceled. Please subscribe to continue using Horizon.',
        redirect: 'pricing',
      });
      return;
    }

    res.status(403).json({
      error: 'subscription_required',
      message: 'An active subscription is required to access this feature.',
      redirect: 'pricing',
    });
    return;
  }

  // Attach subscription status for downstream use
  (req as any).subscriptionStatus = status;
  next();
}

// ─── Feature Gating ─────────────────────────────────────────────────────────

/**
 * Middleware factory: requires a specific feature to be enabled by the plan.
 */
export function requireFeature(featureName: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const tenantId = (req as any).tenantId;
    if (!tenantId) {
      res.status(403).json({ error: 'no_tenant', message: 'No organization found.' });
      return;
    }

    const flags = await getFeatureFlags(tenantId);
    if (!flags) {
      res.status(403).json({ error: 'no_subscription', message: 'No active subscription found.' });
      return;
    }

    // Check if the feature exists and is enabled
    const value = (flags as any)[featureName];
    if (value === false || value === undefined) {
      res.status(403).json({
        error: 'feature_not_available',
        message: `This feature requires a higher plan.`,
        feature: featureName,
        currentPlan: flags.planName,
      });
      return;
    }

    (req as any).featureFlags = flags;
    next();
  };
}

// ─── Credit Checking ────────────────────────────────────────────────────────

/**
 * Checks credit allowance before processing.
 * Returns 429 at 100% usage. Attaches warning flag at ≥80%.
 */
export async function checkCredits(req: Request, res: Response, next: NextFunction): Promise<void> {
  const tenantId = (req as any).tenantId;
  if (!tenantId) {
    next();
    return;
  }

  try {
    const creditCheck = await checkCredit(tenantId);

    if (!creditCheck.allowed) {
      res.status(429).json({
        error: 'credit_limit_reached',
        message: 'Monthly credit limit reached. Upgrade your plan or wait for the next billing cycle.',
        used: creditCheck.used,
        limit: creditCheck.limit,
        percent: creditCheck.percent,
        resetDate: creditCheck.resetDate,
      });
      return;
    }

    // Attach credit info for downstream use
    (req as any).creditCheck = creditCheck;

    // Set warning header if approaching limit
    if (creditCheck.warning) {
      res.setHeader('X-Credit-Warning', 'true');
      res.setHeader('X-Credit-Used', creditCheck.used.toString());
      res.setHeader('X-Credit-Limit', creditCheck.limit.toString());
      res.setHeader('X-Credit-Percent', creditCheck.percent.toString());
    }

    next();
  } catch (err) {
    // Fail open — don't block users due to credit check errors
    console.error('[CREDITS] Check failed, allowing request:', err);
    next();
  }
}

// ─── Admin Check ────────────────────────────────────────────────────────────

/**
 * Requires the user to be an admin (checked against ADMIN_EMAILS env var).
 */
export function requireAdmin(adminEmails: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as any).user;
    if (!user?.email || !adminEmails.includes(user.email.toLowerCase())) {
      res.status(403).json({ error: 'admin_required', message: 'Admin access required.' });
      return;
    }
    next();
  };
}
