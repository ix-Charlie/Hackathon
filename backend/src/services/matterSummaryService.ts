/**
 * Matter Summary Service
 * Generates and manages persistent matter-level summaries that combine
 * all extracted intelligence into a cohesive overview.
 * 
 * Summaries are:
 * - Auto-generated after extraction completes
 * - Marked stale when new documents are processed (via DB trigger)
 * - Regenerable on demand
 * - Versioned for history
 */

import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/index.js';
import { trackTokenUsage } from './tokenUsageService.js';

export interface MatterSummaryData {
  case_id: string;
  tenant_id: string;
  summary_text: string;
  key_findings: string[];
  risk_overview: {
    total_risks: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    top_risks: string[];
  };
  version: number;
  is_stale: boolean;
}

/**
 * Generate a comprehensive matter summary from all extracted intelligence
 */
export async function generateMatterSummary(
  caseId: string,
  tenantId: string,
): Promise<MatterSummaryData> {
  // Fetch all intelligence for this matter in parallel
  const [
    entitiesRes,
    clausesRes,
    obligationsRes,
    datesRes,
    risksRes,
    caseRes,
    filesRes,
  ] = await Promise.all([
    supabaseAdmin.from('matter_entities').select('entity_value, entity_type, normalized_value, confidence').eq('case_id', caseId).eq('tenant_id', tenantId).order('confidence', { ascending: false }).limit(50),
    supabaseAdmin.from('matter_clauses').select('clause_type, summary, risk_level').eq('case_id', caseId).eq('tenant_id', tenantId).limit(30),
    supabaseAdmin.from('matter_obligations').select('obligation_text, obligation_type, obligor, due_date, status').eq('case_id', caseId).eq('tenant_id', tenantId).limit(30),
    supabaseAdmin.from('matter_dates').select('date_value, date_type, description').eq('case_id', caseId).eq('tenant_id', tenantId).order('date_value', { ascending: true }).limit(20),
    supabaseAdmin.from('matter_risks').select('risk_description, severity, risk_type, recommendation').eq('case_id', caseId).eq('tenant_id', tenantId),
    supabaseAdmin.from('cases').select('name, description').eq('id', caseId).eq('tenant_id', tenantId).single(),
    supabaseAdmin.from('vault_assets').select('id, filename, filetype, status').eq('case_id', caseId).eq('tenant_id', tenantId),
  ]);

  const entities = entitiesRes.data || [];
  const clauses = clausesRes.data || [];
  const obligations = obligationsRes.data || [];
  const dates = datesRes.data || [];
  const risks = risksRes.data || [];
  const caseName = caseRes.data?.name || 'Unknown Matter';
  const files = filesRes.data || [];

  // Build risk overview
  const riskCounts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const r of risks) {
    if (r.severity && riskCounts[r.severity] !== undefined) {
      riskCounts[r.severity]++;
    }
  }

  const topRisks = risks
    .filter(r => r.severity === 'critical' || r.severity === 'high')
    .slice(0, 5)
    .map(r => r.risk_description);

  // Build context for LLM summary generation
  const contextParts: string[] = [];

  contextParts.push(`Matter: ${caseName}`);
  contextParts.push(`Documents: ${files.length} files (${files.filter(f => f.status === 'ready').length} processed)`);

  if (entities.length > 0) {
    const uniqueEntities = new Map<string, string>();
    entities.forEach(e => uniqueEntities.set(e.entity_value, `${e.entity_type}${e.normalized_value ? '/' + e.normalized_value : ''}`));
    contextParts.push(`\nKey Entities (${uniqueEntities.size}):`);
    for (const [name, type] of [...uniqueEntities.entries()].slice(0, 15)) {
      contextParts.push(`- ${name} (${type})`);
    }
  }

  if (clauses.length > 0) {
    contextParts.push(`\nKey Clauses (${clauses.length}):`);
    for (const c of clauses.slice(0, 10)) {
      contextParts.push(`- ${c.clause_type} [Risk: ${c.risk_level || 'unknown'}]: ${c.summary || 'No summary'}`);
    }
  }

  if (obligations.length > 0) {
    const now = new Date().toISOString();
    const overdue = obligations.filter(o => o.due_date && o.due_date < now && o.status !== 'completed');
    contextParts.push(`\nObligations (${obligations.length}, ${overdue.length} overdue):`);
    for (const o of obligations.slice(0, 10)) {
      contextParts.push(`- [${o.status}] ${o.obligation_text}${o.due_date ? ' (Due: ' + o.due_date.split('T')[0] + ')' : ''}${o.obligor ? ' → ' + o.obligor : ''}`);
    }
  }

  if (dates.length > 0) {
    contextParts.push(`\nKey Dates (${dates.length}):`);
    for (const d of dates.slice(0, 10)) {
      contextParts.push(`- ${d.date_value?.split('T')[0]}: ${d.date_type} — ${d.description}`);
    }
  }

  if (risks.length > 0) {
    contextParts.push(`\nRisks (${risks.length} total — Critical: ${riskCounts.critical}, High: ${riskCounts.high}, Medium: ${riskCounts.medium}, Low: ${riskCounts.low}):`);
    for (const r of risks.filter(r => r.severity === 'critical' || r.severity === 'high').slice(0, 8)) {
      contextParts.push(`- [${r.severity}] ${r.risk_description}${r.recommendation ? ' → Mitigation: ' + r.recommendation : ''}`);
    }
  }

  const context = contextParts.join('\n');

  // Generate summary via LLM
  let summaryText = '';
  let keyFindings: string[] = [];

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You are a legal intelligence summarizer. Given extracted data from a legal matter, generate a comprehensive summary.

Return JSON:
{
  "summary": "A 2-4 paragraph professional summary of the matter covering: parties involved, key terms, obligations, critical dates, and risk posture.",
  "key_findings": ["Finding 1", "Finding 2", ...] // 5-10 key findings, ranked by importance
}

Be precise, factual, and cite specific data points. Do not speculate beyond what the data shows.`,
          },
          {
            role: 'user',
            content: context,
          },
        ],
      }),
    });

    if (response.ok) {
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const result = JSON.parse(data.choices?.[0]?.message?.content || '{}');
      summaryText = result.summary || 'Summary generation incomplete.';
      keyFindings = Array.isArray(result.key_findings) ? result.key_findings : [];

      // Track token usage
      if (data.usage) {
        trackTokenUsage({
          tenant_id: tenantId,
          operation: 'summary',
          model: 'gpt-4o-mini',
          prompt_tokens: data.usage.prompt_tokens || 0,
          completion_tokens: data.usage.completion_tokens || 0,
          case_id: caseId,
        });
      }
    } else {
      console.error('Summary LLM error:', await response.text());
      summaryText = buildFallbackSummary(caseName, entities, clauses, obligations, risks);
      keyFindings = buildFallbackFindings(entities, obligations, risks);
    }
  } catch (err) {
    console.error('Summary generation failed:', err);
    summaryText = buildFallbackSummary(caseName, entities, clauses, obligations, risks);
    keyFindings = buildFallbackFindings(entities, obligations, risks);
  }

  // Get current version number
  const { data: existingSummary } = await supabaseAdmin
    .from('matter_summaries')
    .select('content')
    .eq('case_id', caseId)
    .eq('tenant_id', tenantId)
    .eq('summary_type', 'comprehensive')
    .single();

  const nextVersion = ((existingSummary?.content as any)?.version || 0) + 1;

  const riskOverview = {
    total_risks: risks.length,
    critical: riskCounts.critical,
    high: riskCounts.high,
    medium: riskCounts.medium,
    low: riskCounts.low,
    top_risks: topRisks,
  };

  // Pack everything into JSONB content column (matches DB schema)
  const contentPayload = {
    summary_text: summaryText,
    key_findings: keyFindings,
    risk_summary: topRisks.length > 0 ? `${risks.length} risks identified (${riskCounts.critical} critical, ${riskCounts.high} high). Top concerns: ${topRisks.slice(0, 3).join('; ')}` : undefined,
    risk_overview: riskOverview,
    version: nextVersion,
  };

  // Upsert into database (unique constraint on tenant_id, case_id, summary_type)
  const { error: upsertError } = await supabaseAdmin
    .from('matter_summaries')
    .upsert({
      case_id: caseId,
      tenant_id: tenantId,
      summary_type: 'executive_brief',
      content: contentPayload,
      stale: false,
      generated_at: new Date().toISOString(),
    }, {
      onConflict: 'tenant_id,case_id,summary_type',
    });

  if (upsertError) {
    console.error('Failed to save matter summary:', upsertError);
    throw upsertError;
  }

  console.log(`📊 Matter summary v${nextVersion} generated for case ${caseId}`);

  return {
    case_id: caseId,
    tenant_id: tenantId,
    summary_text: summaryText,
    key_findings: keyFindings,
    risk_overview: riskOverview,
    version: nextVersion,
    is_stale: false,
  };
}

/**
 * Regenerate summary if stale
 */
export async function refreshStaleSummary(
  caseId: string,
  tenantId: string,
): Promise<MatterSummaryData | null> {
  const { data: existing } = await supabaseAdmin
    .from('matter_summaries')
    .select('stale, content')
    .eq('case_id', caseId)
    .eq('tenant_id', tenantId)
    .eq('summary_type', 'executive_brief')
    .single();

  if (!existing?.stale) {
    return null; // Not stale, no need to regenerate
  }

  return generateMatterSummary(caseId, tenantId);
}

// ============================================================================
// FALLBACK GENERATORS (when LLM is unavailable)
// ============================================================================

function buildFallbackSummary(
  caseName: string,
  entities: any[],
  clauses: any[],
  obligations: any[],
  risks: any[],
): string {
  const parts: string[] = [];
  parts.push(`**Matter: ${caseName}**\n`);

  if (entities.length > 0) {
    const parties = entities.filter(e => e.entity_type === 'party' || e.entity_type === 'person' || e.entity_type === 'organization');
    if (parties.length > 0) {
      parts.push(`This matter involves ${parties.length} identified ${parties.length === 1 ? 'party' : 'parties'}: ${parties.slice(0, 5).map(p => p.entity_value).join(', ')}.`);
    }
  }

  if (clauses.length > 0) {
    parts.push(`${clauses.length} key clauses have been identified across the documents.`);
  }

  if (obligations.length > 0) {
    const pending = obligations.filter(o => o.status === 'pending');
    parts.push(`There are ${obligations.length} obligations tracked (${pending.length} pending).`);
  }

  if (risks.length > 0) {
    const critical = risks.filter(r => r.severity === 'critical' || r.severity === 'high');
    parts.push(`${risks.length} risks identified, ${critical.length} at critical/high severity.`);
  }

  return parts.join(' ');
}

function buildFallbackFindings(
  entities: any[],
  obligations: any[],
  risks: any[],
): string[] {
  const findings: string[] = [];

  if (risks.filter(r => r.severity === 'critical').length > 0) {
    findings.push(`${risks.filter(r => r.severity === 'critical').length} critical risk(s) require immediate attention`);
  }

  const now = new Date().toISOString();
  const overdue = obligations.filter(o => o.due_date && o.due_date < now && o.status !== 'completed');
  if (overdue.length > 0) {
    findings.push(`${overdue.length} obligation(s) are overdue`);
  }

  if (entities.length > 0) {
    findings.push(`${entities.length} entities identified across documents`);
  }

  return findings;
}
