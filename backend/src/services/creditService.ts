/**
 * Credit Service
 *
 * Credit-based usage metering system that replaces hourly rate limits.
 * Each operation type has a weighted credit cost:
 *   - simple_query: 1 credit
 *   - standard_rag: 2 credits
 *   - heavy_rag: 5 credits
 *   - multi_stage: 8 credits
 *   - document_processing: 3 credits
 *   - analysis: 5 credits
 *
 * Plans have monthly credit pools. Soft warning at 80%, hard block at 100%.
 */

import { supabaseAdmin } from '../config/supabase.js';

// ─── Credit Weights ─────────────────────────────────────────────────────────

export const CREDIT_WEIGHTS: Record<string, number> = {
  simple_query: 1,
  standard_rag: 2,
  heavy_rag: 5,
  multi_stage: 8,
  document_processing: 3,
  analysis: 5,
};

// ─── Types ──────────────────────────────────────────────────────────────────

export type OperationType = 
  | 'simple_query'
  | 'standard_rag'
  | 'heavy_rag'
  | 'multi_stage'
  | 'document_processing'
  | 'analysis';

export interface CreditCheckResult {
  allowed: boolean;
  used: number;
  limit: number;
  percent: number;
  warning: boolean;
  remaining: number;
  resetDate: string;
}

export interface CreditUsageEntry {
  tenant_id: string;
  user_id?: string;
  session_id?: string;
  case_id?: string;
  operation_type: OperationType;
  credits_consumed: number;
  metadata?: Record<string, any>;
}

// ─── Batch Buffer (like tokenUsageService) ──────────────────────────────────

const BATCH_SIZE = 15;
const FLUSH_INTERVAL_MS = 20_000; // 20 seconds

let creditBatch: CreditUsageEntry[] = [];
let creditFlushTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Core Functions ─────────────────────────────────────────────────────────

/**
 * Classify a chat task into an operation type based on mode, RAG usage, and document count.
 */
export function classifyTaskWeight(
  mode: string,
  subOptions: string[],
  hasRag: boolean,
  documentCount: number,
  multiStageLevel: string = 'none',
): { operationType: OperationType; credits: number } {
  // Multi-stage pipeline
  if (multiStageLevel === 'full' && (mode === 'legal_research' || mode === 'contract_review' || mode === 'multi_document')) {
    return { operationType: 'multi_stage', credits: CREDIT_WEIGHTS.multi_stage };
  }

  // Limited multi-stage (Starter plan)
  if (multiStageLevel === 'limited' && (mode === 'legal_research' || mode === 'contract_review')) {
    return { operationType: 'heavy_rag', credits: CREDIT_WEIGHTS.heavy_rag };
  }

  // Heavy RAG: specialized modes with RAG + multiple docs, or deep_analysis
  if (hasRag && documentCount > 2 && mode !== 'general') {
    return { operationType: 'heavy_rag', credits: CREDIT_WEIGHTS.heavy_rag };
  }

  // Heavy RAG: certain modes are inherently heavy
  if (['multi_document', 'contract_review', 'legal_research'].includes(mode) && hasRag) {
    return { operationType: 'heavy_rag', credits: CREDIT_WEIGHTS.heavy_rag };
  }

  // Standard RAG: any mode with RAG
  if (hasRag) {
    return { operationType: 'standard_rag', credits: CREDIT_WEIGHTS.standard_rag };
  }

  // Deep analysis sub-options bump to heavy
  if (subOptions.includes('deep_analysis') || subOptions.includes('irac_structure')) {
    return { operationType: 'heavy_rag', credits: CREDIT_WEIGHTS.heavy_rag };
  }

  // Simple query: no RAG, general mode
  return { operationType: 'simple_query', credits: CREDIT_WEIGHTS.simple_query };
}

/**
 * Check credit allowance for a tenant against their plan limits.
 */
export async function checkCredit(tenantId: string): Promise<CreditCheckResult> {
  // Get current month usage
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const { data: usageRows, error: usageError } = await supabaseAdmin
    .from('credit_usage')
    .select('credits_consumed')
    .eq('tenant_id', tenantId)
    .gte('created_at', monthStart.toISOString())
    .lt('created_at', monthEnd.toISOString());

  if (usageError) {
    console.error('[CREDITS] Error fetching usage:', usageError.message);
    // Fail open to avoid blocking users due to a DB error
    return {
      allowed: true, used: 0, limit: 999999, percent: 0,
      warning: false, remaining: 999999, resetDate: monthEnd.toISOString(),
    };
  }

  const used = (usageRows || []).reduce((sum, row) => sum + (row.credits_consumed || 0), 0);

  // Get plan credit limit
  const { data: sub } = await supabaseAdmin
    .from('subscriptions')
    .select('pricing_tier_id, status, pricing_tiers (monthly_credits)')
    .eq('tenant_id', tenantId)
    .in('status', ['active', 'trialing'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const limit = (sub?.pricing_tiers as any)?.monthly_credits || 0;
  const percent = limit > 0 ? Math.round((used / limit) * 1000) / 10 : 100;

  return {
    allowed: used < limit,
    used,
    limit,
    percent,
    warning: percent >= 80,
    remaining: Math.max(0, limit - used),
    resetDate: monthEnd.toISOString(),
  };
}

/**
 * Record credit usage (batched for efficiency).
 */
export function recordCreditUsage(entry: CreditUsageEntry): void {
  creditBatch.push(entry);

  if (creditBatch.length >= BATCH_SIZE) {
    flushCreditBatch();
  } else if (!creditFlushTimer) {
    creditFlushTimer = setTimeout(flushCreditBatch, FLUSH_INTERVAL_MS);
  }
}

/**
 * Record credit usage immediately (for critical operations).
 */
export async function recordCreditUsageImmediate(entry: CreditUsageEntry): Promise<void> {
  const { error } = await supabaseAdmin
    .from('credit_usage')
    .insert(entry);

  if (error) {
    console.error('[CREDITS] Failed to record credit usage:', error.message);
  }
}

/**
 * Flush pending credit entries to database.
 */
async function flushCreditBatch(): Promise<void> {
  if (creditFlushTimer) {
    clearTimeout(creditFlushTimer);
    creditFlushTimer = null;
  }

  if (creditBatch.length === 0) return;

  const batch = [...creditBatch];
  creditBatch = [];

  try {
    const { error } = await supabaseAdmin
      .from('credit_usage')
      .insert(batch);

    if (error) {
      console.error('[CREDITS] Flush failed:', error.message);
      // Re-add failed entries (capped to prevent memory leak)
      if (creditBatch.length < 200) {
        creditBatch.push(...batch);
      }
    } else {
      console.log(`[CREDITS] Flushed ${batch.length} credit entries`);
    }
  } catch (err) {
    console.error('[CREDITS] Flush error:', err);
  }
}

/**
 * Force flush pending credits (call on shutdown).
 */
export async function flushPendingCredits(): Promise<void> {
  await flushCreditBatch();
}

/**
 * Get monthly credit usage breakdown for a tenant.
 */
export async function getMonthlyUsageBreakdown(tenantId: string): Promise<{
  total_credits: number;
  by_operation: Record<string, { count: number; credits: number }>;
  by_user: Record<string, { count: number; credits: number }>;
  daily: Array<{ date: string; credits: number; operations: number }>;
}> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const { data, error } = await supabaseAdmin
    .from('credit_usage')
    .select('user_id, operation_type, credits_consumed, created_at')
    .eq('tenant_id', tenantId)
    .gte('created_at', monthStart.toISOString())
    .order('created_at', { ascending: true });

  if (error) throw error;

  const byOperation: Record<string, { count: number; credits: number }> = {};
  const byUser: Record<string, { count: number; credits: number }> = {};
  const dailyMap: Record<string, { credits: number; operations: number }> = {};
  let totalCredits = 0;

  for (const row of data || []) {
    totalCredits += row.credits_consumed;

    // By operation
    const op = row.operation_type;
    if (!byOperation[op]) byOperation[op] = { count: 0, credits: 0 };
    byOperation[op].count++;
    byOperation[op].credits += row.credits_consumed;

    // By user
    const uid = row.user_id || 'unknown';
    if (!byUser[uid]) byUser[uid] = { count: 0, credits: 0 };
    byUser[uid].count++;
    byUser[uid].credits += row.credits_consumed;

    // Daily
    const day = row.created_at.split('T')[0];
    if (!dailyMap[day]) dailyMap[day] = { credits: 0, operations: 0 };
    dailyMap[day].credits += row.credits_consumed;
    dailyMap[day].operations++;
  }

  const daily = Object.entries(dailyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, stats]) => ({ date, ...stats }));

  return { total_credits: totalCredits, by_operation: byOperation, by_user: byUser, daily };
}

/**
 * Get usage trend for last N months.
 */
export async function getUsageTrend(
  tenantId: string,
  months: number = 6,
): Promise<Array<{ month: string; credits: number; operations: number }>> {
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);
  startDate.setDate(1);

  const { data, error } = await supabaseAdmin
    .from('credit_usage')
    .select('credits_consumed, created_at')
    .eq('tenant_id', tenantId)
    .gte('created_at', startDate.toISOString());

  if (error) throw error;

  const monthlyMap: Record<string, { credits: number; operations: number }> = {};

  for (const row of data || []) {
    const month = row.created_at.substring(0, 7); // YYYY-MM
    if (!monthlyMap[month]) monthlyMap[month] = { credits: 0, operations: 0 };
    monthlyMap[month].credits += row.credits_consumed;
    monthlyMap[month].operations++;
  }

  return Object.entries(monthlyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, stats]) => ({ month, ...stats }));
}
