import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  // Server
  PORT: z.string().default('3001'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Supabase
  SUPABASE_URL: z.string().min(1, 'SUPABASE_URL is required'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY is required'),

  // OpenAI
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  EXTRACTION_MODEL: z.string().default('gpt-4.1-mini'),
  REASONING_MODEL: z.string().default('gpt-4.1'),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_MAX_RETRIES: z.string().default('3'),
  REDIS_CONNECT_TIMEOUT: z.string().default('10000'),

  // Processing
  MAX_FILE_SIZE_MB: z.string().default('100'),
  CHUNK_SIZE: z.string().default('1500'),
  CHUNK_OVERLAP: z.string().default('200'),

  // CORS
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  // Stripe (optional — billing features disabled when not set)
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  STRIPE_PUBLISHABLE_KEY: z.string().default(''),

  // Admin
  ADMIN_EMAILS: z.string().default(''),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const config = {
  port: parseInt(parsed.data.PORT, 10),
  nodeEnv: parsed.data.NODE_ENV,
  isProduction: parsed.data.NODE_ENV === 'production',

  supabase: {
    url: parsed.data.SUPABASE_URL,
    serviceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
    anonKey: parsed.data.SUPABASE_ANON_KEY,
  },

  openai: {
    apiKey: parsed.data.OPENAI_API_KEY,
    embeddingModel: 'text-embedding-3-small',
    extractionModel: parsed.data.EXTRACTION_MODEL,
    reasoningModel: parsed.data.REASONING_MODEL,
  },

  redis: {
    url: parsed.data.REDIS_URL,
    maxRetries: parseInt(parsed.data.REDIS_MAX_RETRIES, 10),
    connectTimeout: parseInt(parsed.data.REDIS_CONNECT_TIMEOUT, 10),
  },

  processing: {
    maxFileSizeMB: parseInt(parsed.data.MAX_FILE_SIZE_MB, 10),
    maxFileSizeBytes: parseInt(parsed.data.MAX_FILE_SIZE_MB, 10) * 1024 * 1024,
    chunkSize: parseInt(parsed.data.CHUNK_SIZE, 10),
    chunkOverlap: parseInt(parsed.data.CHUNK_OVERLAP, 10),
  },

  cors: {
    origins: parsed.data.CORS_ORIGINS.split(',').map(s => s.trim()),
  },

  stripe: {
    secretKey: parsed.data.STRIPE_SECRET_KEY,
    webhookSecret: parsed.data.STRIPE_WEBHOOK_SECRET,
    publishableKey: parsed.data.STRIPE_PUBLISHABLE_KEY,
    isConfigured: !!(parsed.data.STRIPE_SECRET_KEY && parsed.data.STRIPE_WEBHOOK_SECRET && parsed.data.STRIPE_PUBLISHABLE_KEY),
  },

  admin: {
    emails: parsed.data.ADMIN_EMAILS
      ? parsed.data.ADMIN_EMAILS.split(',').map(s => s.trim().toLowerCase())
      : [],
  },
} as const;

export type Config = typeof config;
