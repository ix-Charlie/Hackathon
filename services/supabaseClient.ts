import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config';

// Initialize Supabase Client
// Ensure SUPABASE_URL and SUPABASE_ANON_KEY are set in services/config.ts
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
