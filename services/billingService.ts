/**
 * Billing Service
 *
 * Frontend service for subscription management, credit tracking, and feature flags.
 * Communicates with the backend billing API routes.
 */

import { BACKEND_API_URL } from './config';
import { supabase } from './supabaseClient';
import type { BillingStatus, PlanInfo, FeatureFlags, CreditCheck } from '../types';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error('Not authenticated');
  }
  return {
    'Authorization': `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  };
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = await getAuthHeaders();
  try {
    const res = await fetch(`${BACKEND_API_URL}${path}`, {
      ...options,
      headers: { ...headers, ...options?.headers },
    });
    recordConnectivity(true);

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || body.message || `Request failed: ${res.status}`);
    }

    return res.json();
  } catch (err) {
    // Network-level failure (connection refused, timeout, etc.)
    if (err instanceof TypeError || (err instanceof DOMException && err.name === 'AbortError')) {
      recordConnectivity(false);
    }
    throw err;
  }
}

// ─── Backend Connectivity ───────────────────────────────────────────────────
// Tracks whether the backend is reachable WITHOUT making probe requests.
// Instead, connectivity is inferred from actual API call results (piggyback).
// When the backend is detected as unreachable, we cache that result with
// exponential backoff (10s → 20s → 40s → … → 5min cap) to avoid hammering
// a down server and flooding the console with ERR_CONNECTION_REFUSED.

let backendReachable: boolean | null = null;
let lastConnectivityCheck = 0;
let connectivityBackoffMs = 10_000; // starts at 10s, doubles on each failure
const MAX_BACKOFF = 5 * 60 * 1000; // cap at 5 minutes

/**
 * Record the result of an actual API call.
 * Called internally after every real request attempt.
 */
function recordConnectivity(reachable: boolean): void {
  backendReachable = reachable;
  lastConnectivityCheck = Date.now();
  if (reachable) {
    connectivityBackoffMs = 10_000; // reset backoff on success
  } else {
    connectivityBackoffMs = Math.min(connectivityBackoffMs * 2, MAX_BACKOFF);
  }
}

/**
 * Check cached connectivity state. Returns true (allow requests) if:
 * - We've never checked (first request), OR
 * - Backend was previously reachable, OR
 * - Enough time has passed since last failure (backoff expired)
 */
function shouldAttemptRequest(): boolean {
  if (backendReachable === null) return true; // first ever call, allow it
  if (backendReachable) return true;
  // Backend was down — check if backoff has elapsed
  return Date.now() - lastConnectivityCheck >= connectivityBackoffMs;
}

/** Reset cached connectivity (e.g. after known backend restart). */
export function resetBackendConnectivity(): void {
  backendReachable = null;
  lastConnectivityCheck = 0;
  connectivityBackoffMs = 10_000;
}

// ─── In-Memory Cache ────────────────────────────────────────────────────────

let cachedFeatures: FeatureFlags | null = null;
let featuresCacheTime = 0;
const FEATURES_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Get Stripe publishable key.
 */
export async function getBillingConfig(): Promise<{ publishableKey: string; billingEnabled: boolean } | null> {
  if (!shouldAttemptRequest()) return null;
  try {
    const res = await fetch(`${BACKEND_API_URL}/api/billing/config`);
    recordConnectivity(true);
    return res.json();
  } catch {
    recordConnectivity(false);
    return null;
  }
}

/**
 * Get all available plans.
 */
export async function getAvailablePlans(): Promise<PlanInfo[]> {
  if (!shouldAttemptRequest()) return [];
  try {
    const res = await fetch(`${BACKEND_API_URL}/api/billing/plans`);
    recordConnectivity(true);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.plans) ? data.plans : [];
  } catch {
    recordConnectivity(false);
    return [];
  }
}

const BILLING_STATUS_FALLBACK: BillingStatus = {
  hasSubscription: false,
  status: 'unavailable',
  plan: null,
  billing: null,
  credits: null,
  features: null,
  usage: null,
};

/**
 * Get current billing status (subscription, credits, features, usage).
 * Skips request when backend is known to be unreachable (exponential backoff).
 */
export async function getBillingStatus(): Promise<BillingStatus> {
  if (!shouldAttemptRequest()) {
    return BILLING_STATUS_FALLBACK;
  }
  try {
    return await apiFetch<BillingStatus>('/api/billing/status');
  } catch {
    return BILLING_STATUS_FALLBACK;
  }
}

/**
 * Get feature flags (cached for 5 minutes).
 * Skips request when backend is known to be unreachable.
 */
export async function getFeatures(): Promise<FeatureFlags | null> {
  const now = Date.now();
  if (cachedFeatures && (now - featuresCacheTime) < FEATURES_CACHE_TTL) {
    return cachedFeatures;
  }

  if (!shouldAttemptRequest()) {
    return cachedFeatures;
  }

  try {
    const data = await apiFetch<{ hasSubscription: boolean; flags: FeatureFlags | null }>('/api/features');
    cachedFeatures = data.flags;
    featuresCacheTime = now;
    return data.flags;
  } catch {
    return cachedFeatures;
  }
}

/**
 * Invalidate the features cache (call after plan change).
 */
export function invalidateFeaturesCache(): void {
  cachedFeatures = null;
  featuresCacheTime = 0;
}

/**
 * Get current credit usage.
 */
export async function getCreditUsage(): Promise<CreditCheck | null> {
  try {
    const status = await getBillingStatus();
    return status.credits;
  } catch {
    return null;
  }
}

/**
 * Get detailed usage breakdown.
 */
export async function getUsageBreakdown(): Promise<{
  currentMonth: any;
  trend: any;
  credits: CreditCheck;
} | null> {
  try {
    return await apiFetch('/api/billing/usage');
  } catch {
    return null;
  }
}

/**
 * Create a Stripe checkout session and redirect to it.
 */
export async function createCheckout(priceId: string, seats?: number): Promise<void> {
  const data = await apiFetch<{ url: string }>('/api/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ priceId, seats }),
  });

  // Redirect to Stripe Checkout
  window.location.href = data.url;
}

/**
 * Open Stripe Customer Portal.
 */
export async function openBillingPortal(): Promise<void> {
  const data = await apiFetch<{ url: string }>('/api/billing/portal', {
    method: 'POST',
  });

  // Open portal in same tab (user can return via portal's return URL)
  window.location.href = data.url;
}

/**
 * Check if a mode is allowed by the current plan.
 */
export function isModeAllowed(mode: string): boolean {
  if (!cachedFeatures) return true; // Fail open if cache empty
  return cachedFeatures.allowedModes.includes(mode);
}

/**
 * Get the plan display name from cached features.
 */
export function getPlanDisplayName(): string {
  return cachedFeatures?.planDisplayName || '';
}
