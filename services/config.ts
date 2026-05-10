/**
 * Application Configuration
 * All values must be set in the .env file
 */

export const SUPABASE_URL = process.env.SUPABASE_URL;
if (!SUPABASE_URL) {
  throw new Error("SUPABASE_URL is not set in environment variables");
}

export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_ANON_KEY) {
  throw new Error("SUPABASE_ANON_KEY is not set in environment variables");
}

/**
 * Backend API URL for document processing
 * In development: http://localhost:3001
 * In production: Your Railway/Render backend URL
 */
export const BACKEND_API_URL = import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001';

/**
 * Optional: Set this to your production URL (e.g., "https://maks.thehectagon.com")
 * This ensures that email verification links always point to the live site,
 * even if you trigger the request from localhost.
 */
export const APP_DOMAIN = process.env.APP_DOMAIN || "";