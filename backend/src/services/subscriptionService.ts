/**
 * Subscription Service
 *
 * Manages subscription state, feature flags per plan, and tenant provisioning.
 * All plan-based gating is driven by the pricing_tiers table — never hardcoded.
 */

import { supabaseAdmin } from '../config/supabase.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SubscriptionInfo {
  id: string;
  tenant_id: string;
  pricing_tier_id: string;
  status: string;
  billing_cycle: string;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  current_period_start: string;
  current_period_end: string;
  canceled_at: string | null;
  plan: PlanInfo;
}

export interface PlanInfo {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  price_monthly: number;
  monthly_credits: number;
  max_documents: number;
  max_file_size_mb: number;
  max_users_per_tenant: number;
  max_storage_mb: number;
  enable_multi_stage_reasoning: boolean;
  multi_stage_level: string;
  response_priority: string;
  allowed_modes: string[];
  per_seat_price_monthly: number;
  enable_structured_export: boolean;
  enable_admin_dashboard: boolean;
  enable_usage_dashboard: boolean;
  enable_api_access: boolean;
  enable_shared_knowledge_base: boolean;
  features: Record<string, any>;
}

export interface FeatureFlags {
  planName: string;
  planDisplayName: string;
  enableMultiStage: boolean;
  multiStageLevel: 'none' | 'limited' | 'full';
  monthlyCredits: number;
  maxDocuments: number;
  maxFileSizeMb: number;
  maxStorageMb: number;
  maxSeats: number;
  responsePriority: 'standard' | 'fast' | 'priority';
  allowedModes: string[];
  perSeatPriceMonthly: number;
  enableStructuredExport: boolean;
  enableAdminDashboard: boolean;
  enableUsageDashboard: boolean;
  enableApiAccess: boolean;
  enableSharedKnowledgeBase: boolean;
  supportLevel: string;
}

// ─── Subscription Queries ───────────────────────────────────────────────────

/**
 * Get the active subscription for a tenant.
 */
export async function getSubscription(tenantId: string): Promise<SubscriptionInfo | null> {
  const { data, error } = await supabaseAdmin
    .from('subscriptions')
    .select(`
      id, tenant_id, pricing_tier_id, status, billing_cycle,
      stripe_subscription_id, stripe_customer_id,
      current_period_start, current_period_end, canceled_at,
      pricing_tiers (
        id, name, display_name, description,
        price_monthly, monthly_credits,
        max_documents, max_file_size_mb, max_users_per_tenant, max_storage_mb,
        enable_multi_stage_reasoning, multi_stage_level,
        response_priority, allowed_modes, per_seat_price_monthly,
        enable_structured_export, enable_admin_dashboard, enable_usage_dashboard,
        enable_api_access, enable_shared_knowledge_base, features
      )
    `)
    .eq('tenant_id', tenantId)
    .in('status', ['active', 'trialing', 'past_due'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    // Safety net: tenant has pricing_tier_id on tenants table but no subscription row.
    // This happens for tenants created before the subscription system was introduced.
    // Auto-provision a subscription so the user isn't blocked.
    return autoProvisionSubscription(tenantId);
  }

  const tier = data.pricing_tiers as any;
  if (!tier) return null;

  return {
    id: data.id,
    tenant_id: data.tenant_id,
    pricing_tier_id: data.pricing_tier_id,
    status: data.status,
    billing_cycle: data.billing_cycle,
    stripe_subscription_id: data.stripe_subscription_id,
    stripe_customer_id: data.stripe_customer_id,
    current_period_start: data.current_period_start,
    current_period_end: data.current_period_end,
    canceled_at: data.canceled_at,
    plan: {
      id: tier.id,
      name: tier.name,
      display_name: tier.display_name,
      description: tier.description,
      price_monthly: tier.price_monthly,
      monthly_credits: tier.monthly_credits,
      max_documents: tier.max_documents,
      max_file_size_mb: tier.max_file_size_mb,
      max_users_per_tenant: tier.max_users_per_tenant,
      max_storage_mb: tier.max_storage_mb,
      enable_multi_stage_reasoning: tier.enable_multi_stage_reasoning,
      multi_stage_level: tier.multi_stage_level,
      response_priority: tier.response_priority,
      allowed_modes: tier.allowed_modes || [],
      per_seat_price_monthly: tier.per_seat_price_monthly || 0,
      enable_structured_export: tier.enable_structured_export,
      enable_admin_dashboard: tier.enable_admin_dashboard,
      enable_usage_dashboard: tier.enable_usage_dashboard,
      enable_api_access: tier.enable_api_access,
      enable_shared_knowledge_base: tier.enable_shared_knowledge_base,
      features: tier.features || {},
    },
  };
}

/**
 * Get feature flags for a tenant based on their plan.
 */
export async function getFeatureFlags(tenantId: string): Promise<FeatureFlags | null> {
  const sub = await getSubscription(tenantId);
  if (!sub) return null;

  return {
    planName: sub.plan.name,
    planDisplayName: sub.plan.display_name,
    enableMultiStage: sub.plan.enable_multi_stage_reasoning,
    multiStageLevel: sub.plan.multi_stage_level as FeatureFlags['multiStageLevel'],
    monthlyCredits: sub.plan.monthly_credits,
    maxDocuments: sub.plan.max_documents,
    maxFileSizeMb: sub.plan.max_file_size_mb,
    maxStorageMb: sub.plan.max_storage_mb,
    maxSeats: sub.plan.max_users_per_tenant,
    responsePriority: sub.plan.response_priority as FeatureFlags['responsePriority'],
    allowedModes: sub.plan.allowed_modes,
    perSeatPriceMonthly: sub.plan.per_seat_price_monthly,
    enableStructuredExport: sub.plan.enable_structured_export,
    enableAdminDashboard: sub.plan.enable_admin_dashboard,
    enableUsageDashboard: sub.plan.enable_usage_dashboard,
    enableApiAccess: sub.plan.enable_api_access,
    enableSharedKnowledgeBase: sub.plan.enable_shared_knowledge_base,
    supportLevel: sub.plan.features?.support_level || 'email',
  };
}

/**
 * Check if a tenant has an active subscription.
 */
export async function isSubscriptionActive(tenantId: string): Promise<{
  active: boolean;
  status: string;
  graceEndsAt?: string;
}> {
  const { data } = await supabaseAdmin
    .from('subscriptions')
    .select('status, current_period_end, updated_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) {
    return { active: false, status: 'none' };
  }

  // Active or trialing = full access
  if (data.status === 'active' || data.status === 'trialing') {
    return { active: true, status: data.status };
  }

  // Past due = grace period (3 days from when it went past_due)
  if (data.status === 'past_due') {
    const updatedAt = new Date(data.updated_at);
    const gracePeriodEnd = new Date(updatedAt.getTime() + 3 * 24 * 60 * 60 * 1000);
    const now = new Date();

    if (now < gracePeriodEnd) {
      return {
        active: true,
        status: 'past_due',
        graceEndsAt: gracePeriodEnd.toISOString(),
      };
    }
    return { active: false, status: 'past_due', graceEndsAt: gracePeriodEnd.toISOString() };
  }

  // Canceled, suspended, etc.
  return { active: false, status: data.status };
}

/**
 * Provision a new subscription for a tenant (admin use).
 */
export async function provisionSubscription(
  tenantId: string,
  pricingTierName: string,
): Promise<{ subscriptionId: string; pricingTierId: string }> {
  // Look up pricing tier
  const { data: tier, error: tierError } = await supabaseAdmin
    .from('pricing_tiers')
    .select('id, name')
    .eq('name', pricingTierName)
    .eq('is_active', true)
    .single();

  if (tierError || !tier) {
    throw new Error(`Pricing tier not found: ${pricingTierName}`);
  }

  const now = new Date();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  // Create or update subscription
  const { data: sub, error: subError } = await supabaseAdmin
    .from('subscriptions')
    .upsert(
      {
        tenant_id: tenantId,
        pricing_tier_id: tier.id,
        status: 'active',
        billing_cycle: 'monthly',
        current_period_start: now.toISOString(),
        current_period_end: periodEnd.toISOString(),
        updated_at: now.toISOString(),
      },
      { onConflict: 'tenant_id' },
    )
    .select('id')
    .single();

  if (subError || !sub) {
    throw new Error(`Failed to create subscription: ${subError?.message}`);
  }

  // Update tenant
  await supabaseAdmin
    .from('tenants')
    .update({
      plan: tier.name,
      pricing_tier_id: tier.id,
      subscription_status: 'active',
    })
    .eq('id', tenantId);

  return { subscriptionId: sub.id, pricingTierId: tier.id };
}

/**
 * Get all available pricing tiers (for pricing page).
 */
export async function getAvailablePlans(): Promise<PlanInfo[]> {
  const { data, error } = await supabaseAdmin
    .from('pricing_tiers')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });

  if (error) throw error;

  return (data || []).map((tier: any) => ({
    id: tier.id,
    name: tier.name,
    display_name: tier.display_name,
    description: tier.description,
    price_monthly: tier.price_monthly,
    monthly_credits: tier.monthly_credits,
    max_documents: tier.max_documents,
    max_file_size_mb: tier.max_file_size_mb,
    max_users_per_tenant: tier.max_users_per_tenant,
    max_storage_mb: tier.max_storage_mb,
    enable_multi_stage_reasoning: tier.enable_multi_stage_reasoning,
    multi_stage_level: tier.multi_stage_level,
    response_priority: tier.response_priority,
    allowed_modes: tier.allowed_modes || [],
    per_seat_price_monthly: tier.per_seat_price_monthly || 0,
    enable_structured_export: tier.enable_structured_export,
    enable_admin_dashboard: tier.enable_admin_dashboard,
    enable_usage_dashboard: tier.enable_usage_dashboard,
    enable_api_access: tier.enable_api_access,
    enable_shared_knowledge_base: tier.enable_shared_knowledge_base,
    features: tier.features || {},
  }));
}

/**
 * Get tenant member count.
 */
export async function getTenantMemberCount(tenantId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('tenant_members')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);

  if (error) return 0;
  return count || 0;
}

/**
 * Get tenant document count.
 */
export async function getTenantDocumentCount(tenantId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('vault_assets')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);

  if (error) return 0;
  return count || 0;
}

// ─── Auto-Provision Safety Net ──────────────────────────────────────────────

/**
 * Auto-provision a subscription for tenants that have a pricing_tier_id
 * on the tenants table but no subscription row. This handles legacy tenants
 * created before the subscription system was introduced.
 */
async function autoProvisionSubscription(tenantId: string): Promise<SubscriptionInfo | null> {
  // Look up the tenant's pricing_tier_id
  const { data: tenant } = await supabaseAdmin
    .from('tenants')
    .select('pricing_tier_id, plan')
    .eq('id', tenantId)
    .maybeSingle();

  if (!tenant?.pricing_tier_id) return null;

  console.log(`[SUBSCRIPTION] Auto-provisioning subscription for tenant ${tenantId} (plan: ${tenant.plan})`);

  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  // Insert the subscription
  const { error: insertErr } = await supabaseAdmin
    .from('subscriptions')
    .insert({
      tenant_id: tenantId,
      pricing_tier_id: tenant.pricing_tier_id,
      status: 'active',
      billing_cycle: 'monthly',
      current_period_start: periodStart.toISOString(),
      current_period_end: periodEnd.toISOString(),
    });

  if (insertErr) {
    console.error(`[SUBSCRIPTION] Auto-provision failed for ${tenantId}:`, insertErr.message);
    return null;
  }

  // Re-fetch using the normal query so we get the full SubscriptionInfo
  return getSubscription(tenantId);
}
