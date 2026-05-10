/**
 * Feature Flag Service
 *
 * Centralized feature flag evaluation driven by plan data.
 * All flags derive from the pricing_tiers table — never manually toggled
 * (except admin override via subscription service).
 *
 * Uses in-memory caching with a 5-minute TTL to avoid repeated DB queries.
 */

import { getFeatureFlags, FeatureFlags } from './subscriptionService.js';

// ─── Cache ──────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedFlags {
  flags: FeatureFlags;
  expiresAt: number;
}

const flagsCache = new Map<string, CachedFlags>();

// Cleanup stale cache entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of flagsCache) {
    if (now > entry.expiresAt) {
      flagsCache.delete(key);
    }
  }
}, 10 * 60 * 1000);

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Get all feature flags for a tenant (cached).
 */
export async function getFlags(tenantId: string): Promise<FeatureFlags | null> {
  // Check cache
  const cached = flagsCache.get(tenantId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.flags;
  }

  // Fetch from DB
  const flags = await getFeatureFlags(tenantId);
  if (flags) {
    flagsCache.set(tenantId, {
      flags,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
  }

  return flags;
}

/**
 * Check if a specific feature is enabled for a tenant.
 */
export async function isFeatureEnabled(
  tenantId: string,
  feature: keyof FeatureFlags,
): Promise<boolean> {
  const flags = await getFlags(tenantId);
  if (!flags) return false;

  const value = flags[feature];
  return typeof value === 'boolean' ? value : !!value;
}

/**
 * Check if a mode is allowed for a tenant's plan.
 */
export async function isModeAllowed(tenantId: string, mode: string): Promise<boolean> {
  const flags = await getFlags(tenantId);
  if (!flags) return false;
  return flags.allowedModes.includes(mode);
}

/**
 * Get the multi-stage level for a tenant.
 */
export async function getMultiStageLevel(
  tenantId: string,
): Promise<'none' | 'limited' | 'full'> {
  const flags = await getFlags(tenantId);
  if (!flags) return 'none';
  return flags.multiStageLevel;
}

/**
 * Invalidate cached flags for a tenant (call after plan change).
 */
export function invalidateCache(tenantId: string): void {
  flagsCache.delete(tenantId);
}

/**
 * Invalidate all cached flags.
 */
export function invalidateAllCache(): void {
  flagsCache.clear();
}
