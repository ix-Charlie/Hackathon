/**
 * PricingOverlay
 *
 * Full-screen overlay shown when a user has no active subscription.
 * Displays the 4 plan cards with pricing, features, and checkout CTAs.
 * Cannot be dismissed if no active subscription (blocking overlay).
 */

import React, { useState, useEffect } from 'react';
import type { PlanInfo } from '../types';
import { getAvailablePlans, createCheckout, getBillingConfig } from '../services/billingService';

interface PricingOverlayProps {
  isBlocking: boolean; // true = cannot dismiss, user has no active sub
  onClose?: () => void;
  currentPlan?: string | null;
}

const PLAN_COLORS: Record<string, { bg: string; border: string; badge: string; cta: string }> = {
  starter: {
    bg: 'bg-slate-50 dark:bg-slate-950/30',
    border: 'border-slate-300 dark:border-slate-700',
    badge: 'bg-slate-100 text-slate-800 dark:bg-slate-900 dark:text-slate-200',
    cta: 'bg-slate-800 hover:bg-slate-900 text-white dark:bg-slate-600 dark:hover:bg-slate-500',
  },
  team: {
    bg: 'bg-purple-50 dark:bg-purple-950/30',
    border: 'border-purple-200 dark:border-purple-800',
    badge: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
    cta: 'bg-purple-600 hover:bg-purple-700 text-white',
  },
  firm: {
    bg: 'bg-slate-50 dark:bg-slate-950/30',
    border: 'border-slate-300 dark:border-slate-700',
    badge: 'bg-slate-100 text-slate-800 dark:bg-slate-900 dark:text-slate-200',
    cta: 'bg-slate-800 hover:bg-slate-900 text-white dark:bg-slate-600 dark:hover:bg-slate-500',
  },
  enterprise: {
    bg: 'bg-slate-50 dark:bg-slate-950/30',
    border: 'border-slate-300 dark:border-slate-700',
    badge: 'bg-slate-100 text-slate-800 dark:bg-slate-900 dark:text-slate-200',
    cta: 'bg-slate-800 hover:bg-slate-900 text-white dark:bg-slate-600 dark:hover:bg-slate-500',
  },
};

const PLAN_FEATURES: Record<string, string[]> = {
  starter: [
    '1 user',
    'Core AI research + drafting',
    'Limited monthly AI workload',
    '20 GB secure vault',
    'Email support',
  ],
  team: [
    '3 users included (up to 7 at $99/seat)',
    'Shared workspace',
    'Matter-level memory',
    'Multi-document reasoning',
    '200 GB shared vault',
    'Structured exports',
    'Priority email support',
  ],
  firm: [
    '$129/seat (min 8 seats)',
    'Pooled AI workload',
    'Shared knowledge base reuse',
    'Admin dashboard & analytics',
    '1 TB+ storage',
    'Cross-matter analysis',
    'Audit logs',
    'SLA support',
  ],
  enterprise: [
    'Dedicated deployment',
    'Custom AI workload',
    'API access',
    'Compliance modules',
    'On-prem / VPC option',
    'Dedicated support',
  ],
};

// Static fallback plans used when API is unreachable or DB isn't seeded yet
const STATIC_PLANS: PlanInfo[] = [
  {
    id: 'static-starter',
    name: 'starter',
    display_name: 'Starter',
    description: 'Solo lawyers testing AI. Core research and drafting with a limited monthly workload.',
    price_monthly: 99,
    monthly_credits: 300,
    max_documents: 50,
    max_file_size_mb: 25,
    max_users_per_tenant: 1,
    max_storage_mb: 20480,
    enable_multi_stage_reasoning: true,
    multi_stage_level: 'limited',
    response_priority: 'standard',
    allowed_modes: ['general', 'summary', 'legal_research', 'contract_review', 'drafting'],
    per_seat_price_monthly: 0,
    enable_structured_export: false,
    enable_admin_dashboard: false,
    enable_usage_dashboard: false,
    enable_api_access: false,
    enable_shared_knowledge_base: false,
    features: {},
  },
  {
    id: 'static-team',
    name: 'team',
    display_name: 'Team',
    description: 'Small law practices. Shared workspace with matter-level memory and multi-document reasoning.',
    price_monthly: 299,
    monthly_credits: 1500,
    max_documents: 300,
    max_file_size_mb: 50,
    max_users_per_tenant: 7,
    max_storage_mb: 204800,
    enable_multi_stage_reasoning: true,
    multi_stage_level: 'full',
    response_priority: 'fast',
    allowed_modes: ['general', 'summary', 'legal_research', 'contract_review', 'multi_document', 'drafting'],
    per_seat_price_monthly: 99,
    enable_structured_export: true,
    enable_admin_dashboard: false,
    enable_usage_dashboard: true,
    enable_api_access: false,
    enable_shared_knowledge_base: false,
    features: { base_seats: 3 },
  },
  {
    id: 'static-firm',
    name: 'firm',
    display_name: 'Firm',
    description: 'Medium-large law firms. Pooled AI workload, shared knowledge base, admin dashboard, and SLA support.',
    price_monthly: 1032,
    monthly_credits: 8000,
    max_documents: 2000,
    max_file_size_mb: 100,
    max_users_per_tenant: 999,
    max_storage_mb: 1048576,
    enable_multi_stage_reasoning: true,
    multi_stage_level: 'full',
    response_priority: 'priority',
    allowed_modes: ['general', 'summary', 'legal_research', 'contract_review', 'multi_document', 'drafting'],
    per_seat_price_monthly: 129,
    enable_structured_export: true,
    enable_admin_dashboard: true,
    enable_usage_dashboard: true,
    enable_api_access: false,
    enable_shared_knowledge_base: true,
    features: {},
  },
  {
    id: 'static-enterprise',
    name: 'enterprise',
    display_name: 'Enterprise',
    description: 'Large organizations with complex needs. Dedicated deployment, custom AI workload, and compliance modules.',
    price_monthly: 0,
    monthly_credits: 999999,
    max_documents: 999999,
    max_file_size_mb: 500,
    max_users_per_tenant: 9999,
    max_storage_mb: 999999,
    enable_multi_stage_reasoning: true,
    multi_stage_level: 'full',
    response_priority: 'priority',
    allowed_modes: ['general', 'summary', 'legal_research', 'contract_review', 'multi_document', 'drafting'],
    per_seat_price_monthly: 0,
    enable_structured_export: true,
    enable_admin_dashboard: true,
    enable_usage_dashboard: true,
    enable_api_access: true,
    enable_shared_knowledge_base: true,
    features: {},
  },
];

export default function PricingOverlay({ isBlocking, onClose, currentPlan }: PricingOverlayProps) {
  // Start with static plans for instant display, update from API in background
  const [plans, setPlans] = useState<PlanInfo[]>(STATIC_PLANS);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [firmSeats, setFirmSeats] = useState(8);
  const [teamSeats, setTeamSeats] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const [billingEnabled, setBillingEnabled] = useState(false);

  // Prevent body scroll when overlay is mounted
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  useEffect(() => {
    loadPlans();
  }, []);

  async function loadPlans() {
    // Load in background, keep static plans visible for instant UX
    try {
      // Parallel API calls for faster loading
      const [billingConfig, availablePlans] = await Promise.all([
        getBillingConfig().catch(() => null),
        getAvailablePlans().catch(() => [])
      ]);
      
      setBillingEnabled(!!billingConfig?.billingEnabled);

      // Only update if we got valid plans from API
      const hasNewTiers = availablePlans.some(p => ['starter', 'team', 'firm'].includes(p.name));
      if (availablePlans.length > 0 && hasNewTiers) {
        const newPlans = availablePlans.filter(p => ['starter', 'team', 'firm', 'enterprise'].includes(p.name));
        if (newPlans.length > 0) {
          setPlans(newPlans);
        }
      }
    } catch (err) {
      // Silent fail - static plans already visible
      console.warn('Could not load plans from API, using static fallback:', err);
    }
  }

  function handleClose() {
    if (!onClose) return;
    onClose();
  }

  async function handleSelectPlan(plan: PlanInfo) {
    if (plan.name === 'enterprise') {
      window.location.href = 'mailto:sales@horizonlegal.ai?subject=Enterprise%20Plan%20Inquiry';
      return;
    }

    // If Stripe isn't configured, redirect to contact
    if (!billingEnabled) {
      window.location.href = `mailto:sales@horizonlegal.ai?subject=${encodeURIComponent(plan.display_name + ' Plan Inquiry')}`;
      return;
    }

    setCheckoutLoading(plan.name);
    setError(null);

    try {
      const priceId = plan.features?.stripe_price_id_monthly;
      if (!priceId) {
        setError('Plan configuration error. Please contact support.');
        return;
      }

      const seats = plan.name === 'firm' ? firmSeats : plan.name === 'team' ? teamSeats : undefined;
      await createCheckout(priceId, seats);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout failed');
      setCheckoutLoading(null);
    }
  }

  function formatPrice(plan: PlanInfo): string {
    if (plan.name === 'enterprise') return 'Custom';
    if (plan.name === 'firm') return `$${plan.per_seat_price_monthly}`;
    return `$${plan.price_monthly.toLocaleString()}`;
  }

  return (
    <div className="fixed inset-0 z-50 bg-white dark:bg-gray-900 overflow-y-auto">
      <div className="min-h-screen w-full max-w-6xl mx-auto px-4 py-8 sm:py-12">
        {/* Back Button */}
        {onClose && (
          <button
            onClick={handleClose}
            className="flex items-center gap-2 mb-6 px-4 py-2 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-all duration-200 hover:gap-3"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            <span className="font-semibold">Back</span>
          </button>
        )}

        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-white mb-3">
            Choose Your Plan
          </h1>
          <p className="text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
            Select a plan to unlock Horizon's legal AI capabilities. All plans include our core document analysis and chat features.
          </p>
          {isBlocking && (
            <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">
              A subscription is required to continue using Horizon.
            </p>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="max-w-lg mx-auto mb-6 p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-300 text-sm text-center">
            {error}
          </div>
        )}

        {/* Plan Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {(plans.length > 0 ? plans : []).map((plan) => {
            const colors = PLAN_COLORS[plan.name] || PLAN_COLORS.starter;
            const features = PLAN_FEATURES[plan.name] || [];
            const isCurrent = currentPlan === plan.name;
            const isLoading = checkoutLoading === plan.name;
            
            // Mobile order: Team first (order-1), others follow (order-2)
            const mobileOrder = plan.name === 'team' ? 'order-1' : 'order-2';

            return (
              <div
                key={plan.name}
                className={`relative rounded-2xl border-2 ${colors.border} ${colors.bg} p-6 flex flex-col transition-all duration-200 hover:shadow-lg ${mobileOrder} md:order-none ${
                  plan.name === 'team' ? 'ring-2 ring-purple-400 dark:ring-purple-500' : ''
                }`}
              >
                {/* Popular Badge */}
                {plan.name === 'team' && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="px-3 py-1 text-xs font-semibold bg-purple-600 text-white rounded-full">
                      Most Popular
                    </span>
                  </div>
                )}

                {/* Plan Name */}
                <div className="mb-4">
                  <span className={`inline-block px-2.5 py-0.5 text-xs font-semibold rounded-full ${colors.badge}`}>
                    {plan.display_name}
                  </span>
                </div>

                {/* Price */}
                <div className="mb-4">
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold text-gray-900 dark:text-white">
                      {formatPrice(plan)}
                    </span>
                    {plan.name !== 'enterprise' && (
                      <span className="text-sm text-gray-500 dark:text-gray-400">
                        {plan.name === 'firm' ? '/seat/mo' : '/month'}
                      </span>
                    )}
                  </div>
                  {plan.name === 'team' && (
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      3 seats included · extra seats $99/mo each
                    </p>
                  )}
                  {plan.name === 'firm' && (
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      Minimum 8 seats (${(8 * plan.per_seat_price_monthly).toLocaleString()}/mo)
                    </p>
                  )}
                </div>

                {/* Description */}
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-5">
                  {plan.description}
                </p>

                {/* Features */}
                <ul className="flex-1 space-y-2 mb-6">
                  {features.map((feature, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                      <svg className="w-4 h-4 mt-0.5 text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      {feature}
                    </li>
                  ))}
                </ul>

                {/* Seat Selector (Team) */}
                {plan.name === 'team' && (
                  <div className="mb-4">
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                      Team size
                    </label>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setTeamSeats(Math.max(3, teamSeats - 1))}
                        className="w-8 h-8 rounded-lg border border-gray-300 dark:border-gray-600 flex items-center justify-center text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        -
                      </button>
                      <span className="w-8 text-center text-sm font-medium text-gray-800 dark:text-gray-200">
                        {teamSeats}
                      </span>
                      <button
                        onClick={() => setTeamSeats(Math.min(7, teamSeats + 1))}
                        className="w-8 h-8 rounded-lg border border-gray-300 dark:border-gray-600 flex items-center justify-center text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        +
                      </button>
                      <span className="text-xs text-gray-500 dark:text-gray-400 ml-1">
                        seats
                      </span>
                    </div>
                    {teamSeats > 3 && (
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        Total: ${(plan.price_monthly + (teamSeats - 3) * (plan.per_seat_price_monthly || 99)).toLocaleString()}/month
                      </p>
                    )}
                  </div>
                )}

                {/* Seat Selector (Firm) */}
                {plan.name === 'firm' && (
                  <div className="mb-4">
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                      Team size
                    </label>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setFirmSeats(Math.max(8, firmSeats - 1))}
                        className="w-8 h-8 rounded-lg border border-gray-300 dark:border-gray-600 flex items-center justify-center text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        -
                      </button>
                      <span className="w-8 text-center text-sm font-medium text-gray-800 dark:text-gray-200">
                        {firmSeats}
                      </span>
                      <button
                        onClick={() => setFirmSeats(firmSeats + 1)}
                        className="w-8 h-8 rounded-lg border border-gray-300 dark:border-gray-600 flex items-center justify-center text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        +
                      </button>
                      <span className="text-xs text-gray-500 dark:text-gray-400 ml-1">
                        seats
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      Total: ${(firmSeats * plan.per_seat_price_monthly).toLocaleString()}/month
                    </p>
                  </div>
                )}

                {/* CTA */}
                <button
                  onClick={() => handleSelectPlan(plan)}
                  disabled={isCurrent || isLoading}
                  className={`w-full py-2.5 px-4 rounded-xl font-medium text-sm transition-colors ${
                    isCurrent
                      ? 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed'
                      : colors.cta
                  } ${isLoading ? 'opacity-75 cursor-wait' : ''}`}
                >
                  {isCurrent
                    ? 'Current Plan'
                    : isLoading
                    ? 'Redirecting...'
                    : plan.name === 'enterprise' || !billingEnabled
                    ? 'Contact Sales'
                    : 'Get Started'}
                </button>
              </div>
            );
          })}
        </div>

        {/* Close Button (only if not blocking) */}
        {!isBlocking && onClose && (
          <div className="text-center mt-6">
            <button
              onClick={handleClose}
              className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline"
            >
              Continue with current plan
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="text-center mt-8">
          <p className="text-xs text-gray-400 dark:text-gray-500">
            All plans are billed monthly. Cancel anytime. Prices in USD.
          </p>
        </div>
      </div>
    </div>
  );
}
