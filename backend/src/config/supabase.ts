import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './index.js';

// Admin client with service role key (bypasses RLS)
export const supabaseAdmin: SupabaseClient = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

/**
 * Create a Supabase client with a user's JWT token for auth verification
 */
export function createUserClient(authToken: string): SupabaseClient {
  return createClient(config.supabase.url, config.supabase.anonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    },
  });
}

/**
 * Verify a JWT token and return the user
 */
export async function verifyToken(token: string) {
  const client = createUserClient(token);
  const { data, error } = await client.auth.getUser(token);
  
  if (error || !data.user) {
    return null;
  }
  
  return data.user;
}
