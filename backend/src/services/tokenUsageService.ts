/**
 * Token Usage Tracking Service
 * 
 * Tracks all OpenAI API token consumption for cost monitoring and optimization.
 * Uses batched inserts to minimize DB overhead.
 * 
 * Pricing (as of 2025, in USD per 1M tokens):
 * - gpt-4o:              $2.50 input / $10.00 output
 * - gpt-4o-mini:         $0.15 input / $0.60 output
 * - gpt-3.5-turbo:       $0.50 input / $1.50 output
 * - text-embedding-3-small: $0.02 input
 */

import { supabaseAdmin } from '../config/supabase.js';

// ─── Pricing Table (microdollars per token) ─────────────────────────────────

interface ModelPricing {
  inputPerToken: number;  // microdollars per token
  outputPerToken: number; // microdollars per token
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'gpt-4o': {
    inputPerToken: 2.5,      // $2.50 per 1M = 2.5 microdollars per token
    outputPerToken: 10.0,    // $10.00 per 1M
  },
  'gpt-4o-mini': {
    inputPerToken: 0.15,     // $0.15 per 1M
    outputPerToken: 0.60,    // $0.60 per 1M
  },
  'gpt-4.1': {
    inputPerToken: 2.0,      // $2.00 per 1M
    outputPerToken: 8.0,     // $8.00 per 1M
  },
  'gpt-4.1-mini': {
    inputPerToken: 0.40,     // $0.40 per 1M
    outputPerToken: 1.60,    // $1.60 per 1M
  },
  'gpt-4.1-nano': {
    inputPerToken: 0.10,     // $0.10 per 1M
    outputPerToken: 0.40,    // $0.40 per 1M
  },
  'gpt-3.5-turbo': {
    inputPerToken: 0.50,     // $0.50 per 1M
    outputPerToken: 1.50,    // $1.50 per 1M
  },
  'text-embedding-3-small': {
    inputPerToken: 0.02,     // $0.02 per 1M
    outputPerToken: 0,
  },
  'text-embedding-3-large': {
    inputPerToken: 0.13,     // $0.13 per 1M
    outputPerToken: 0,
  },
};

// Fallback pricing for unknown models  
const DEFAULT_PRICING: ModelPricing = {
  inputPerToken: 1.0,
  outputPerToken: 3.0,
};

// ─── Token Usage Entry ──────────────────────────────────────────────────────

export interface TokenUsageEntry {
  tenant_id: string;
  user_id?: string;
  operation: 'chat' | 'extraction' | 'classification' | 'validation' | 'summary' | 'conflict_detection' | 'embedding' | 'other';
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated_cost_microdollars: number;
  case_id?: string;
  session_id?: string;
  file_id?: string;
  metadata?: Record<string, any>;
}

// ─── Batch Buffer ───────────────────────────────────────────────────────────

const BATCH_SIZE = 20;
const FLUSH_INTERVAL_MS = 30_000; // 30 seconds

let usageBatch: TokenUsageEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Calculate estimated cost in microdollars.
 */
export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = MODEL_PRICING[model] || DEFAULT_PRICING;
  return Math.round(pricing.inputPerToken * promptTokens + pricing.outputPerToken * completionTokens);
}

/**
 * Track token usage. Batches entries and flushes periodically.
 */
export function trackTokenUsage(entry: Omit<TokenUsageEntry, 'total_tokens' | 'estimated_cost_microdollars'> & { total_tokens?: number; estimated_cost_microdollars?: number }): void {
  const totalTokens = entry.total_tokens ?? (entry.prompt_tokens + entry.completion_tokens);
  const estimatedCost = entry.estimated_cost_microdollars ?? estimateCost(entry.model, entry.prompt_tokens, entry.completion_tokens);

  usageBatch.push({
    ...entry,
    total_tokens: totalTokens,
    estimated_cost_microdollars: estimatedCost,
  });

  // Flush if batch is full
  if (usageBatch.length >= BATCH_SIZE) {
    flushUsageBatch();
  } else if (!flushTimer) {
    // Schedule flush
    flushTimer = setTimeout(flushUsageBatch, FLUSH_INTERVAL_MS);
  }
}

/**
 * Flush accumulated usage entries to the database.
 */
async function flushUsageBatch(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  if (usageBatch.length === 0) return;

  const batch = [...usageBatch];
  usageBatch = [];

  try {
    const { error } = await supabaseAdmin
      .from('token_usage')
      .insert(batch);

    if (error) {
      console.error('Failed to flush token usage batch:', error.message);
      // Re-add failed entries (capped to prevent memory leak)
      if (usageBatch.length < 200) {
        usageBatch.push(...batch);
      }
    } else {
      console.log(`[TOKEN_USAGE] Flushed ${batch.length} entries`);
    }
  } catch (err) {
    console.error('Token usage flush error:', err);
  }
}

/**
 * Force flush any pending usage data (call on shutdown).
 */
export async function flushPendingUsage(): Promise<void> {
  await flushUsageBatch();
}

/**
 * Get usage summary for a tenant within a date range.
 */
export async function getTenantUsageSummary(
  tenantId: string,
  startDate?: string,
  endDate?: string,
): Promise<{
  total_requests: number;
  total_tokens: number;
  total_cost_usd: number;
  by_model: Record<string, { requests: number; tokens: number; cost_usd: number }>;
  by_operation: Record<string, { requests: number; tokens: number; cost_usd: number }>;
}> {
  let query = supabaseAdmin
    .from('token_usage')
    .select('model, operation, prompt_tokens, completion_tokens, total_tokens, estimated_cost_microdollars')
    .eq('tenant_id', tenantId);

  if (startDate) query = query.gte('created_at', startDate);
  if (endDate) query = query.lte('created_at', endDate);

  const { data, error } = await query;

  if (error) throw error;

  const byModel: Record<string, { requests: number; tokens: number; cost_usd: number }> = {};
  const byOperation: Record<string, { requests: number; tokens: number; cost_usd: number }> = {};
  let totalRequests = 0;
  let totalTokens = 0;
  let totalCostMicro = 0;

  for (const row of data || []) {
    totalRequests++;
    totalTokens += row.total_tokens;
    totalCostMicro += row.estimated_cost_microdollars;

    // By model
    if (!byModel[row.model]) byModel[row.model] = { requests: 0, tokens: 0, cost_usd: 0 };
    byModel[row.model].requests++;
    byModel[row.model].tokens += row.total_tokens;
    byModel[row.model].cost_usd += row.estimated_cost_microdollars / 1_000_000;

    // By operation
    if (!byOperation[row.operation]) byOperation[row.operation] = { requests: 0, tokens: 0, cost_usd: 0 };
    byOperation[row.operation].requests++;
    byOperation[row.operation].tokens += row.total_tokens;
    byOperation[row.operation].cost_usd += row.estimated_cost_microdollars / 1_000_000;
  }

  return {
    total_requests: totalRequests,
    total_tokens: totalTokens,
    total_cost_usd: totalCostMicro / 1_000_000,
    by_model: byModel,
    by_operation: byOperation,
  };
}

/**
 * Get daily usage breakdown for charts.
 */
export async function getDailyUsage(
  tenantId: string,
  days: number = 30,
): Promise<Array<{ date: string; requests: number; tokens: number; cost_usd: number }>> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const { data, error } = await supabaseAdmin
    .from('token_usage')
    .select('created_at, total_tokens, estimated_cost_microdollars')
    .eq('tenant_id', tenantId)
    .gte('created_at', startDate.toISOString())
    .order('created_at', { ascending: true });

  if (error) throw error;

  const dailyMap: Record<string, { requests: number; tokens: number; cost_micro: number }> = {};

  for (const row of data || []) {
    const day = row.created_at.split('T')[0];
    if (!dailyMap[day]) dailyMap[day] = { requests: 0, tokens: 0, cost_micro: 0 };
    dailyMap[day].requests++;
    dailyMap[day].tokens += row.total_tokens;
    dailyMap[day].cost_micro += row.estimated_cost_microdollars;
  }

  return Object.entries(dailyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, stats]) => ({
      date,
      requests: stats.requests,
      tokens: stats.tokens,
      cost_usd: stats.cost_micro / 1_000_000,
    }));
}
