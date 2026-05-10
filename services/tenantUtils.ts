import { supabase } from './supabaseClient';

// Cache tenant_id to avoid repeated lookups
let cachedTenantId: string | null = null;
let tenantIdCacheTime: number = 0;
const TENANT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get the tenant_id for the current authenticated user (with caching)
 */
export async function getUserTenantId(): Promise<string | null> {
  // Return cached value if still valid
  if (cachedTenantId && Date.now() - tenantIdCacheTime < TENANT_CACHE_TTL) {
    return cachedTenantId;
  }

  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    console.error('No authenticated user');
    return null;
  }

  const { data, error } = await supabase
    .from('tenant_members')
    .select('tenant_id')
    .eq('user_id', user.id)
    .single();

  if (error) {
    console.error('Error fetching tenant_id:', error);
    return null;
  }

  // Cache the result
  cachedTenantId = data?.tenant_id || null;
  tenantIdCacheTime = Date.now();

  return cachedTenantId;
}

/**
 * Clear tenant cache (call on logout)
 */
export function clearTenantCache(): void {
  cachedTenantId = null;
  tenantIdCacheTime = 0;
}
