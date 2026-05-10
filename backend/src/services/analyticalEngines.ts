/**
 * Analytical Engines Service
 * Specialized processing functions for legal intelligence analysis:
 * - Conflict detection across documents
 * - Obligation compliance tracking
 * - Risk aggregation and scoring
 * - Timeline analysis with gap detection
 * - Cross-reference validation
 */

import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/index.js';

// ============================================================================
// TYPES
// ============================================================================

export interface ConflictDetectionResult {
  conflicts: Array<{
    type: 'contradictory_clause' | 'date_mismatch' | 'party_inconsistency' | 'term_conflict' | 'obligation_overlap';
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    source_a: { file_id: string; detail: string };
    source_b: { file_id: string; detail: string };
    recommendation: string;
  }>;
  total_documents_analyzed: number;
  analysis_timestamp: string;
}

export interface ObligationComplianceResult {
  summary: {
    total: number;
    pending: number;
    completed: number;
    overdue: number;
    upcoming_7_days: number;
    upcoming_30_days: number;
  };
  overdue_obligations: Array<{
    id: string;
    description: string;
    due_date: string;
    days_overdue: number;
    responsible_party: string | null;
    has_penalty: boolean;
  }>;
  upcoming_obligations: Array<{
    id: string;
    description: string;
    due_date: string;
    days_until_due: number;
    responsible_party: string | null;
  }>;
  by_party: Record<string, { total: number; pending: number; completed: number; overdue: number }>;
}

export interface RiskMatrixResult {
  matrix: Record<string, Record<string, number>>; // severity → category → count
  total_risks: number;
  critical_risks: Array<{
    id: string;
    description: string;
    severity: string;
    category: string;
    affected_clause: string | null;
    mitigation: string | null;
  }>;
  risk_score: number; // 0-100 composite score
  risk_trend: 'increasing' | 'stable' | 'decreasing' | 'unknown';
}

export interface TimelineAnalysisResult {
  events: Array<{
    date: string;
    type: string;
    description: string;
    source: string;
    is_deadline: boolean;
  }>;
  gaps: Array<{
    from_date: string;
    to_date: string;
    gap_days: number;
    context: string;
  }>;
  critical_path: Array<{
    date: string;
    description: string;
    is_overdue: boolean;
  }>;
  span_days: number;
}

// ============================================================================
// CONFLICT DETECTION ENGINE
// ============================================================================

export async function detectConflicts(
  caseId: string,
  tenantId: string,
  openaiApiKey: string,
): Promise<ConflictDetectionResult> {
  const now = new Date().toISOString();

  // Fetch all clauses, entities, dates, and obligations for cross-referencing
  const [clausesRes, entitiesRes, datesRes, obligationsRes] = await Promise.all([
    supabaseAdmin
      .from('matter_clauses')
      .select('id, clause_type, clause_text, summary, risk_level, source_file_id')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId),
    supabaseAdmin
      .from('matter_entities')
      .select('id, entity_name, entity_type, role, source_file_id')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId),
    supabaseAdmin
      .from('matter_dates')
      .select('id, date_value, date_type, description, source_file_id')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId),
    supabaseAdmin
      .from('matter_obligations')
      .select('id, description, obligation_type, responsible_party, due_date, source_file_id')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId),
  ]);

  const clauses = clausesRes.data || [];
  const entities = entitiesRes.data || [];
  const dates = datesRes.data || [];
  const obligations = obligationsRes.data || [];

  // Get unique file IDs
  const fileIds = new Set<string>();
  [...clauses, ...entities, ...dates, ...obligations].forEach((item: any) => {
    if (item.source_file_id) fileIds.add(item.source_file_id);
  });

  const conflicts: ConflictDetectionResult['conflicts'] = [];

  // 1. Detect contradictory clauses (same type, different content across files)
  const clausesByType = new Map<string, typeof clauses>();
  for (const clause of clauses) {
    const existing = clausesByType.get(clause.clause_type) || [];
    existing.push(clause);
    clausesByType.set(clause.clause_type, existing);
  }

  for (const [clauseType, typeClauses] of clausesByType) {
    if (typeClauses.length < 2) continue;

    // Compare clauses from different files
    for (let i = 0; i < typeClauses.length; i++) {
      for (let j = i + 1; j < typeClauses.length; j++) {
        if (typeClauses[i].source_file_id === typeClauses[j].source_file_id) continue;

        // Use LLM to detect if clauses contradict each other
        try {
          const conflictCheck = await checkClauseConflict(
            typeClauses[i],
            typeClauses[j],
            clauseType,
            openaiApiKey,
          );
          if (conflictCheck) {
            conflicts.push(conflictCheck);
          }
        } catch (err) {
          console.error(`Conflict check failed for ${clauseType}:`, err);
        }
      }
    }
  }

  // 2. Detect date mismatches (same type of date with different values across files)
  const datesByType = new Map<string, typeof dates>();
  for (const date of dates) {
    const existing = datesByType.get(date.date_type) || [];
    existing.push(date);
    datesByType.set(date.date_type, existing);
  }

  for (const [dateType, typeDates] of datesByType) {
    if (typeDates.length < 2) continue;
    const uniqueValues = new Set(typeDates.map(d => d.date_value?.split('T')[0]));
    if (uniqueValues.size > 1) {
      // Different dates for the same type across documents
      const sorted = typeDates.sort((a: any, b: any) => a.date_value.localeCompare(b.date_value));
      conflicts.push({
        type: 'date_mismatch',
        severity: dateType === 'deadline' || dateType === 'effective_date' ? 'high' : 'medium',
        description: `Conflicting ${dateType} dates found: ${[...uniqueValues].join(' vs ')}`,
        source_a: { file_id: sorted[0].source_file_id, detail: `${dateType}: ${sorted[0].date_value?.split('T')[0]}` },
        source_b: { file_id: sorted[sorted.length - 1].source_file_id, detail: `${dateType}: ${sorted[sorted.length - 1].date_value?.split('T')[0]}` },
        recommendation: `Verify which ${dateType} date is authoritative and update the conflicting document.`,
      });
    }
  }

  // 3. Detect party/entity inconsistencies
  const entitiesByName = new Map<string, typeof entities>();
  for (const entity of entities) {
    const normalized = entity.entity_name?.toLowerCase().trim();
    if (!normalized) continue;
    const existing = entitiesByName.get(normalized) || [];
    existing.push(entity);
    entitiesByName.set(normalized, existing);
  }

  for (const [name, nameEntities] of entitiesByName) {
    if (nameEntities.length < 2) continue;
    const roles = new Set(nameEntities.map(e => e.role).filter(Boolean));
    if (roles.size > 1) {
      const entries = [...nameEntities];
      conflicts.push({
        type: 'party_inconsistency',
        severity: 'medium',
        description: `Entity "${name}" has conflicting roles: ${[...roles].join(', ')}`,
        source_a: { file_id: entries[0].source_file_id, detail: `Role: ${entries[0].role}` },
        source_b: { file_id: entries[entries.length - 1].source_file_id, detail: `Role: ${entries[entries.length - 1].role}` },
        recommendation: `Verify the correct role for "${name}" across all documents.`,
      });
    }
  }

  // Sort by severity
  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  conflicts.sort((a, b) => (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3));

  return {
    conflicts,
    total_documents_analyzed: fileIds.size,
    analysis_timestamp: now,
  };
}

async function checkClauseConflict(
  clauseA: any,
  clauseB: any,
  clauseType: string,
  apiKey: string,
): Promise<ConflictDetectionResult['conflicts'][0] | null> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are a legal conflict detection system. Compare two ${clauseType} clauses from different documents and determine if they conflict.

Return JSON:
{
  "has_conflict": true/false,
  "severity": "critical" | "high" | "medium" | "low",
  "description": "Description of the conflict",
  "recommendation": "How to resolve the conflict"
}

Only report actual conflicts — differences that could cause legal issues, confusion, or contradictory obligations. Minor wording differences that don't change meaning are NOT conflicts.`,
        },
        {
          role: 'user',
          content: `Clause A (${clauseType}):\n${clauseA.summary || clauseA.clause_text?.substring(0, 500)}\n\nClause B (${clauseType}):\n${clauseB.summary || clauseB.clause_text?.substring(0, 500)}`,
        },
      ],
    }),
  });

  if (!response.ok) return null;

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const result = JSON.parse(data.choices?.[0]?.message?.content || '{}');

  if (!result.has_conflict) return null;

  return {
    type: 'contradictory_clause',
    severity: result.severity || 'medium',
    description: result.description || `Conflicting ${clauseType} clauses found`,
    source_a: { file_id: clauseA.source_file_id, detail: clauseA.summary || clauseType },
    source_b: { file_id: clauseB.source_file_id, detail: clauseB.summary || clauseType },
    recommendation: result.recommendation || 'Review and reconcile the conflicting clauses',
  };
}

// ============================================================================
// OBLIGATION COMPLIANCE ENGINE
// ============================================================================

export async function analyzeObligationCompliance(
  caseId: string,
  tenantId: string,
): Promise<ObligationComplianceResult> {
  const { data: obligations, error } = await supabaseAdmin
    .from('matter_obligations')
    .select('*')
    .eq('case_id', caseId)
    .eq('tenant_id', tenantId)
    .order('due_date', { ascending: true });

  if (error) throw error;

  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const all = obligations || [];
  const pending = all.filter(o => o.status === 'pending');
  const completed = all.filter(o => o.status === 'completed');
  const overdue = all.filter(o => {
    if (!o.due_date || o.status === 'completed') return false;
    return new Date(o.due_date) < now;
  });
  const upcoming7 = all.filter(o => {
    if (!o.due_date || o.status === 'completed') return false;
    const d = new Date(o.due_date);
    return d >= now && d <= in7Days;
  });
  const upcoming30 = all.filter(o => {
    if (!o.due_date || o.status === 'completed') return false;
    const d = new Date(o.due_date);
    return d >= now && d <= in30Days;
  });

  // Group by party
  const byParty: Record<string, { total: number; pending: number; completed: number; overdue: number }> = {};
  for (const o of all) {
    const party = o.responsible_party || 'Unassigned';
    if (!byParty[party]) byParty[party] = { total: 0, pending: 0, completed: 0, overdue: 0 };
    byParty[party].total++;
    if (o.status === 'completed') byParty[party].completed++;
    else if (o.due_date && new Date(o.due_date) < now) byParty[party].overdue++;
    else byParty[party].pending++;
  }

  return {
    summary: {
      total: all.length,
      pending: pending.length,
      completed: completed.length,
      overdue: overdue.length,
      upcoming_7_days: upcoming7.length,
      upcoming_30_days: upcoming30.length,
    },
    overdue_obligations: overdue.map(o => ({
      id: o.id,
      description: o.description,
      due_date: o.due_date,
      days_overdue: Math.floor((now.getTime() - new Date(o.due_date).getTime()) / (1000 * 60 * 60 * 24)),
      responsible_party: o.responsible_party,
      has_penalty: !!o.penalty_clause,
    })),
    upcoming_obligations: upcoming30.map(o => ({
      id: o.id,
      description: o.description,
      due_date: o.due_date,
      days_until_due: Math.floor((new Date(o.due_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
      responsible_party: o.responsible_party,
    })),
    by_party: byParty,
  };
}

// ============================================================================
// RISK MATRIX ENGINE
// ============================================================================

export async function buildRiskMatrix(
  caseId: string,
  tenantId: string,
): Promise<RiskMatrixResult> {
  const { data: risks, error } = await supabaseAdmin
    .from('matter_risks')
    .select('*')
    .eq('case_id', caseId)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  if (error) throw error;

  const all = risks || [];
  const matrix: Record<string, Record<string, number>> = {};
  const severityWeights: Record<string, number> = { critical: 10, high: 7, medium: 4, low: 1 };

  let totalWeightedScore = 0;

  for (const risk of all) {
    const sev = risk.severity || 'medium';
    const cat = risk.category || 'general';

    if (!matrix[sev]) matrix[sev] = {};
    matrix[sev][cat] = (matrix[sev][cat] || 0) + 1;

    totalWeightedScore += severityWeights[sev] || 4;
  }

  // Normalize risk score to 0-100
  const maxPossibleScore = all.length * 10; // All critical
  const riskScore = maxPossibleScore > 0
    ? Math.round((totalWeightedScore / maxPossibleScore) * 100)
    : 0;

  const criticalRisks = all
    .filter(r => r.severity === 'critical' || r.severity === 'high')
    .slice(0, 10)
    .map(r => ({
      id: r.id,
      description: r.risk_description,
      severity: r.severity,
      category: r.category || 'general',
      affected_clause: r.affected_clause,
      mitigation: r.mitigation_suggestion,
    }));

  return {
    matrix,
    total_risks: all.length,
    critical_risks: criticalRisks,
    risk_score: riskScore,
    risk_trend: 'unknown', // Would need historical data to compute trend
  };
}

// ============================================================================
// TIMELINE ANALYSIS ENGINE
// ============================================================================

export async function analyzeTimeline(
  caseId: string,
  tenantId: string,
): Promise<TimelineAnalysisResult> {
  const [datesRes, obligationsRes] = await Promise.all([
    supabaseAdmin
      .from('matter_dates')
      .select('date_value, date_type, description, source_file_id')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId)
      .order('date_value', { ascending: true }),
    supabaseAdmin
      .from('matter_obligations')
      .select('due_date, obligation_type, description, status, source_file_id')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId)
      .not('due_date', 'is', null)
      .order('due_date', { ascending: true }),
  ]);

  const now = new Date();
  const events: TimelineAnalysisResult['events'] = [];

  for (const d of datesRes.data || []) {
    events.push({
      date: d.date_value,
      type: d.date_type,
      description: d.description,
      source: d.source_file_id || 'unknown',
      is_deadline: d.date_type === 'deadline' || d.date_type === 'filing_date',
    });
  }

  for (const o of obligationsRes.data || []) {
    events.push({
      date: o.due_date!,
      type: `obligation_${o.obligation_type}`,
      description: o.description,
      source: o.source_file_id || 'unknown',
      is_deadline: true,
    });
  }

  events.sort((a, b) => a.date.localeCompare(b.date));

  // Detect gaps (periods > 30 days between events)
  const gaps: TimelineAnalysisResult['gaps'] = [];
  for (let i = 0; i < events.length - 1; i++) {
    const current = new Date(events[i].date);
    const next = new Date(events[i + 1].date);
    const gapDays = Math.floor((next.getTime() - current.getTime()) / (1000 * 60 * 60 * 24));

    if (gapDays > 30) {
      gaps.push({
        from_date: events[i].date,
        to_date: events[i + 1].date,
        gap_days: gapDays,
        context: `${gapDays}-day gap between "${events[i].description}" and "${events[i + 1].description}"`,
      });
    }
  }

  // Build critical path (deadlines and overdue items)
  const criticalPath = events
    .filter(e => e.is_deadline)
    .map(e => ({
      date: e.date,
      description: e.description,
      is_overdue: new Date(e.date) < now,
    }));

  // Calculate span
  let spanDays = 0;
  if (events.length >= 2) {
    const first = new Date(events[0].date);
    const last = new Date(events[events.length - 1].date);
    spanDays = Math.floor((last.getTime() - first.getTime()) / (1000 * 60 * 60 * 24));
  }

  return {
    events,
    gaps,
    critical_path: criticalPath,
    span_days: spanDays,
  };
}
