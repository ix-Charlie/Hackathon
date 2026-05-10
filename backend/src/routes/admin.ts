/**
 * Admin Routes
 *
 * Protected endpoints for admin operations:
 *   POST /api/admin/provision     — Provision a new tenant with subscription
 *   POST /api/admin/override-plan — Change a tenant's plan
 *   GET  /api/admin/tenants       — List all tenants with status
 */

import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/subscription.js';
import { config } from '../config/index.js';
import { supabaseAdmin } from '../config/supabase.js';
import { provisionSubscription, getSubscription } from '../services/subscriptionService.js';
import { checkCredit } from '../services/creditService.js';
import { invalidateCache } from '../services/featureFlagService.js';

const router = Router();

// Apply auth + admin check to all routes
router.use(requireAuth, requireAdmin(config.admin.emails));

/**
 * POST /provision — Create tenant + subscription for a new user.
 * Called by admin after a sales call to set up a customer account.
 *
 * Body: { userId, organizationName, planName, seats? }
 */
router.post('/provision', async (req: Request, res: Response) => {
  try {
    const { userId, organizationName, planName, seats } = req.body;

    if (!userId || !planName) {
      res.status(400).json({ error: 'userId and planName are required' });
      return;
    }

    // Verify user exists
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, email')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Check if user already has a tenant
    const { data: existingMember } = await supabaseAdmin
      .from('tenant_members')
      .select('tenant_id')
      .eq('user_id', userId)
      .maybeSingle();

    if (existingMember) {
      res.status(409).json({
        error: 'User already has a tenant',
        tenantId: existingMember.tenant_id,
      });
      return;
    }

    // Use the DB function to provision
    const { data, error } = await supabaseAdmin
      .rpc('provision_tenant_for_user', {
        p_user_id: userId,
        p_plan_name: planName,
        p_organization_name: organizationName || 'My Organization',
      });

    if (error) {
      console.error('Provision error:', error);
      res.status(500).json({ error: 'Failed to provision tenant', details: error.message });
      return;
    }

    res.json({
      success: true,
      ...data,
      message: `Tenant provisioned for ${user.email} on ${planName} plan`,
    });
  } catch (err) {
    console.error('Provision error:', err);
    res.status(500).json({ error: 'Failed to provision tenant' });
  }
});

/**
 * POST /override-plan — Change a tenant's plan (admin override).
 *
 * Body: { tenantId, planName }
 */
router.post('/override-plan', async (req: Request, res: Response) => {
  try {
    const { tenantId, planName } = req.body;

    if (!tenantId || !planName) {
      res.status(400).json({ error: 'tenantId and planName are required' });
      return;
    }

    const result = await provisionSubscription(tenantId, planName);

    // Invalidate feature flag cache
    invalidateCache(tenantId);

    res.json({
      success: true,
      ...result,
      message: `Tenant ${tenantId} upgraded to ${planName}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Override plan error:', message);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /tenants — List all tenants with subscription + usage info.
 */
router.get('/tenants', async (_req: Request, res: Response) => {
  try {
    const { data: tenants, error } = await supabaseAdmin
      .from('tenants')
      .select(`
        id, name, plan, subscription_status, created_at,
        pricing_tiers (name, display_name, price_monthly, monthly_credits),
        tenant_members (user_id, role, users (email, first_name, last_name))
      `)
      .order('created_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch tenants' });
      return;
    }

    // Enrich with credit usage (parallel)
    const enriched = await Promise.all(
      (tenants || []).map(async (tenant: any) => {
        try {
          const credits = await checkCredit(tenant.id);
          return { ...tenant, credits };
        } catch {
          return { ...tenant, credits: null };
        }
      }),
    );

    res.json({ tenants: enriched });
  } catch (err) {
    console.error('Error listing tenants:', err);
    res.status(500).json({ error: 'Failed to list tenants' });
  }
});

/**
 * GET /tenant/:tenantId — Get detailed info for a single tenant.
 */
router.get('/tenant/:tenantId', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;

    const [subscription, credits] = await Promise.all([
      getSubscription(tenantId),
      checkCredit(tenantId),
    ]);

    const { data: members } = await supabaseAdmin
      .from('tenant_members')
      .select('user_id, role, joined_at, users (email, first_name, last_name)')
      .eq('tenant_id', tenantId);

    res.json({
      subscription,
      credits,
      members: members || [],
    });
  } catch (err) {
    console.error('Error fetching tenant details:', err);
    res.status(500).json({ error: 'Failed to fetch tenant details' });
  }
});

export default router;
