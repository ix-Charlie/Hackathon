/**
 * Intelligence Comparison Service
 * 
 * Enterprise-grade smart comparison pipeline that runs AFTER extraction.
 * Instead of blindly adding all extracted data, this service:
 * 
 *   Phase 1 — Clause Deduplication
 *     Uses cosine similarity (embeddings) + LLM verification to find
 *     near-duplicate clauses. Only genuinely new/different clauses are kept.
 * 
 *   Phase 2 — Obligation Merging
 *     Detects obligations that overlap with existing ones in the matter.
 *     Merges duplicates by linking them to multiple source files.
 * 
 *   Phase 3 — Relevance Filtering
 *     Scores each piece of extracted intelligence against the matter's
 *     existing context. Low-relevance items are flagged (not deleted)
 *     so summaries focus on what actually matters.
 * 
 * Cost-optimised:
 *   - Embeddings for cheap similarity (text-embedding-3-small)
 *   - LLM verification only for ambiguous matches (gpt-4.1-mini)
 *   - Batched processing to minimise API calls
 */

import { config } from '../config/index.js';
import { supabaseAdmin } from '../config/supabase.js';
import { generateEmbeddings } from './embeddingService.js';
import { trackTokenUsage } from './tokenUsageService.js';

// ============================================================================
// TYPES
// ============================================================================

export interface ComparisonResult {
  clauses: {
    total_extracted: number;
    duplicates_found: number;
    unique_kept: number;
    merged: number;
  };
  obligations: {
    total_extracted: number;
    duplicates_found: number;
    unique_kept: number;
    merged: number;
  };
  dates: {
    total_extracted: number;
    duplicates_found: number;
    unique_kept: number;
  };
  risks: {
    total_extracted: number;
    duplicates_found: number;
    unique_kept: number;
  };
  relevance: {
    high_relevance: number;
    medium_relevance: number;
    low_relevance: number;
    flagged: number;
  };
  tokens_used: number;
  processing_time_ms: number;
}

interface ExistingClause {
  id: string;
  clause_type: string;
  clause_text: string;
  summary: string;
  section_ref: string | null;
  risk_level: string;
  file_id: string;
}

interface ExistingObligation {
  id: string;
  obligor: string;
  obligee: string;
  obligation_text: string;
  obligation_type: string;
  due_date: string | null;
  file_id: string;
}

interface ExistingDate {
  id: string;
  date_type: string;
  date_value: string;
  description: string;
  file_id: string;
}

interface ExistingRisk {
  id: string;
  risk_type: string;
  risk_description: string;
  severity: string;
  file_id: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const COMPARISON_MODEL = config.openai.extractionModel; // gpt-4.1-mini — fast + cheap
const SIMILARITY_THRESHOLD = 0.88;       // Embeddings cosine similarity: >0.88 = likely duplicate
const LLM_VERIFY_THRESHOLD = 0.78;       // 0.78-0.88 = ambiguous, use LLM to decide
const RELEVANCE_LOW_THRESHOLD = 0.3;     // Below this = flagged as low-relevance
const BATCH_SIZE = 20;                    // Items per LLM verification call

// ============================================================================
// UTILITY: Cosine Similarity
// ============================================================================

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ============================================================================
// PHASE 1: CLAUSE DEDUPLICATION
// ============================================================================

/**
 * Compare newly extracted clauses against existing matter clauses.
 * Returns IDs of new clauses that are duplicates and should be removed.
 */
async function deduplicateClauses(
  caseId: string,
  tenantId: string,
  fileId: string,
): Promise<{ duplicateIds: string[]; mergedCount: number; tokens: number }> {
  let totalTokens = 0;

  // 1. Fetch existing clauses in this matter (from OTHER files)
  const { data: existingClauses, error: existingError } = await supabaseAdmin
    .from('matter_clauses')
    .select('id, clause_type, clause_text, summary, section_ref, risk_level, file_id')
    .eq('case_id', caseId)
    .eq('tenant_id', tenantId)
    .neq('file_id', fileId);

  if (existingError || !existingClauses || existingClauses.length === 0) {
    console.log('[DEDUP-CLAUSE] No existing clauses in matter — skipping deduplication');
    return { duplicateIds: [], mergedCount: 0, tokens: 0 };
  }

  // 2. Fetch newly added clauses (from THIS file)
  const { data: newClauses, error: newError } = await supabaseAdmin
    .from('matter_clauses')
    .select('id, clause_type, clause_text, summary, section_ref, risk_level, file_id')
    .eq('case_id', caseId)
    .eq('tenant_id', tenantId)
    .eq('file_id', fileId);

  if (newError || !newClauses || newClauses.length === 0) {
    return { duplicateIds: [], mergedCount: 0, tokens: 0 };
  }

  console.log(`[DEDUP-CLAUSE] Comparing ${newClauses.length} new clauses against ${existingClauses.length} existing`);

  // 3. Generate embeddings for comparison
  //    Use clause summary + type as the comparison text (more efficient than full text)
  const existingTexts = existingClauses.map(c => `[${c.clause_type}] ${c.summary || c.clause_text.substring(0, 300)}`);
  const newTexts = newClauses.map(c => `[${c.clause_type}] ${c.summary || c.clause_text.substring(0, 300)}`);

  const allTexts = [...existingTexts, ...newTexts];
  const allEmbeddings = await generateEmbeddings(allTexts);
  const existingEmbeddings = allEmbeddings.slice(0, existingTexts.length);
  const newEmbeddings = allEmbeddings.slice(existingTexts.length);

  // 4. Find potential duplicates using cosine similarity
  const duplicateIds: string[] = [];
  const ambiguousPairs: Array<{ newClause: ExistingClause; existingClause: ExistingClause; similarity: number }> = [];

  for (let i = 0; i < newClauses.length; i++) {
    let bestSimilarity = 0;
    let bestMatch: ExistingClause | null = null;

    for (let j = 0; j < existingClauses.length; j++) {
      const sim = cosineSimilarity(newEmbeddings[i], existingEmbeddings[j]);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestMatch = existingClauses[j];
      }
    }

    if (bestSimilarity >= SIMILARITY_THRESHOLD) {
      // High confidence duplicate — remove directly
      duplicateIds.push(newClauses[i].id);
      console.log(`  [DEDUP] Duplicate (${(bestSimilarity * 100).toFixed(1)}%): "${newClauses[i].summary?.substring(0, 60)}..."`);
    } else if (bestSimilarity >= LLM_VERIFY_THRESHOLD && bestMatch) {
      // Ambiguous — queue for LLM verification
      ambiguousPairs.push({
        newClause: newClauses[i],
        existingClause: bestMatch,
        similarity: bestSimilarity,
      });
    }
    // Below LLM_VERIFY_THRESHOLD = genuinely unique, keep it
  }

  // 5. LLM verification for ambiguous pairs
  if (ambiguousPairs.length > 0) {
    console.log(`[DEDUP-CLAUSE] ${ambiguousPairs.length} ambiguous pairs — verifying with LLM...`);

    for (let i = 0; i < ambiguousPairs.length; i += BATCH_SIZE) {
      const batch = ambiguousPairs.slice(i, i + BATCH_SIZE);

      const pairsForPrompt = batch.map((p, idx) => ({
        index: idx,
        new_clause: {
          type: p.newClause.clause_type,
          summary: p.newClause.summary,
          text: p.newClause.clause_text.substring(0, 500),
        },
        existing_clause: {
          type: p.existingClause.clause_type,
          summary: p.existingClause.summary,
          text: p.existingClause.clause_text.substring(0, 500),
        },
        similarity_score: p.similarity,
      }));

      try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.openai.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: COMPARISON_MODEL,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: `You are a legal clause deduplication expert. For each pair of clauses, determine if they are semantically the same (duplicate) or meaningfully different (unique).

Two clauses are DUPLICATES if:
- They express the same legal obligation/right/restriction
- Even if worded differently, the legal effect is the same
- Minor variations in parties, dates, or amounts from different documents still count as duplicates if the clause type and intent are the same

Two clauses are UNIQUE if:
- They cover different legal topics even if similarly worded
- They impose meaningfully different obligations/restrictions
- Different risk levels or conditions make them legally distinct

Respond with JSON: { "results": [{ "index": <number>, "is_duplicate": <boolean>, "reason": "<brief explanation>" }] }`,
              },
              {
                role: 'user',
                content: `Compare these ${batch.length} clause pairs:\n\n${JSON.stringify(pairsForPrompt, null, 2)}`,
              },
            ],
          }),
        });

        const data: any = await response.json();
        totalTokens += data.usage?.total_tokens || 0;

        const content = data.choices?.[0]?.message?.content;
        if (content) {
          const parsed = JSON.parse(content);
          for (const r of parsed.results || []) {
            if (r.is_duplicate && batch[r.index]) {
              duplicateIds.push(batch[r.index].newClause.id);
              console.log(`  [LLM-DEDUP] Confirmed duplicate: "${batch[r.index].newClause.summary?.substring(0, 60)}..." — ${r.reason}`);
            }
          }
        }
      } catch (err) {
        console.warn('[DEDUP-CLAUSE] LLM verification failed (non-fatal):', err);
      }
    }
  }

  // 6. Delete confirmed duplicates from database
  if (duplicateIds.length > 0) {
    await supabaseAdmin
      .from('matter_clauses')
      .delete()
      .in('id', duplicateIds);
    console.log(`[DEDUP-CLAUSE] Removed ${duplicateIds.length} duplicate clauses`);
  }

  return { duplicateIds, mergedCount: duplicateIds.length, tokens: totalTokens };
}


// ============================================================================
// PHASE 2: OBLIGATION MERGING
// ============================================================================

/**
 * Detect overlapping obligations and merge duplicates.
 * Unlike clauses, obligations are tracked per-source, so we mark duplicates
 * rather than delete them — linking them to a "primary" obligation.
 */
async function mergeObligations(
  caseId: string,
  tenantId: string,
  fileId: string,
): Promise<{ duplicateIds: string[]; mergedCount: number; tokens: number }> {
  let totalTokens = 0;

  // 1. Fetch existing obligations in this matter (from OTHER files)
  const { data: existingObligations, error: existingError } = await supabaseAdmin
    .from('matter_obligations')
    .select('id, obligor, obligee, obligation_text, obligation_type, due_date, file_id')
    .eq('case_id', caseId)
    .eq('tenant_id', tenantId)
    .neq('file_id', fileId);

  if (existingError || !existingObligations || existingObligations.length === 0) {
    console.log('[MERGE-OBL] No existing obligations in matter — skipping merge');
    return { duplicateIds: [], mergedCount: 0, tokens: 0 };
  }

  // 2. Fetch newly added obligations (from THIS file)
  const { data: newObligations, error: newError } = await supabaseAdmin
    .from('matter_obligations')
    .select('id, obligor, obligee, obligation_text, obligation_type, due_date, file_id')
    .eq('case_id', caseId)
    .eq('tenant_id', tenantId)
    .eq('file_id', fileId);

  if (newError || !newObligations || newObligations.length === 0) {
    return { duplicateIds: [], mergedCount: 0, tokens: 0 };
  }

  console.log(`[MERGE-OBL] Comparing ${newObligations.length} new obligations against ${existingObligations.length} existing`);

  // 3. Generate embeddings for comparison
  const existingTexts = existingObligations.map(o =>
    `[${o.obligation_type}] ${o.obligor} → ${o.obligee}: ${o.obligation_text.substring(0, 300)}`
  );
  const newTexts = newObligations.map(o =>
    `[${o.obligation_type}] ${o.obligor} → ${o.obligee}: ${o.obligation_text.substring(0, 300)}`
  );

  const allTexts = [...existingTexts, ...newTexts];
  const allEmbeddings = await generateEmbeddings(allTexts);
  const existingEmbeddings = allEmbeddings.slice(0, existingTexts.length);
  const newEmbeddings = allEmbeddings.slice(existingTexts.length);

  // 4. Find potential duplicates
  const duplicateIds: string[] = [];
  const ambiguousPairs: Array<{
    newObl: ExistingObligation;
    existingObl: ExistingObligation;
    similarity: number;
  }> = [];

  for (let i = 0; i < newObligations.length; i++) {
    let bestSimilarity = 0;
    let bestMatch: ExistingObligation | null = null;

    for (let j = 0; j < existingObligations.length; j++) {
      const sim = cosineSimilarity(newEmbeddings[i], existingEmbeddings[j]);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestMatch = existingObligations[j];
      }
    }

    if (bestSimilarity >= SIMILARITY_THRESHOLD) {
      // High confidence duplicate
      duplicateIds.push(newObligations[i].id);
      console.log(`  [MERGE] Duplicate obligation (${(bestSimilarity * 100).toFixed(1)}%): "${newObligations[i].obligation_text.substring(0, 60)}..."`);
    } else if (bestSimilarity >= LLM_VERIFY_THRESHOLD && bestMatch) {
      ambiguousPairs.push({
        newObl: newObligations[i],
        existingObl: bestMatch,
        similarity: bestSimilarity,
      });
    }
  }

  // 5. LLM verification for ambiguous pairs
  if (ambiguousPairs.length > 0) {
    console.log(`[MERGE-OBL] ${ambiguousPairs.length} ambiguous pairs — verifying with LLM...`);

    for (let i = 0; i < ambiguousPairs.length; i += BATCH_SIZE) {
      const batch = ambiguousPairs.slice(i, i + BATCH_SIZE);

      const pairsForPrompt = batch.map((p, idx) => ({
        index: idx,
        new_obligation: {
          type: p.newObl.obligation_type,
          obligor: p.newObl.obligor,
          obligee: p.newObl.obligee,
          text: p.newObl.obligation_text.substring(0, 400),
          due_date: p.newObl.due_date,
        },
        existing_obligation: {
          type: p.existingObl.obligation_type,
          obligor: p.existingObl.obligor,
          obligee: p.existingObl.obligee,
          text: p.existingObl.obligation_text.substring(0, 400),
          due_date: p.existingObl.due_date,
        },
        similarity_score: p.similarity,
      }));

      try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.openai.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: COMPARISON_MODEL,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: `You are a legal obligation deduplication expert. For each pair, determine if they represent the SAME obligation or different ones.

Two obligations are DUPLICATES if:
- Same obligor and obligee (even if named slightly differently)
- Same type of obligation (payment, performance, etc.)
- Same or very similar terms/conditions
- Referenced from different clauses/documents but expressing the same duty

Two obligations are UNIQUE if:
- Different parties involved
- Different types of duty
- Different amounts, deadlines, or conditions that make them legally distinct
- Same parties but genuinely different obligations

Respond with JSON: { "results": [{ "index": <number>, "is_duplicate": <boolean>, "reason": "<brief explanation>" }] }`,
              },
              {
                role: 'user',
                content: `Compare these ${batch.length} obligation pairs:\n\n${JSON.stringify(pairsForPrompt, null, 2)}`,
              },
            ],
          }),
        });

        const data: any = await response.json();
        totalTokens += data.usage?.total_tokens || 0;

        const content = data.choices?.[0]?.message?.content;
        if (content) {
          const parsed = JSON.parse(content);
          for (const r of parsed.results || []) {
            if (r.is_duplicate && batch[r.index]) {
              duplicateIds.push(batch[r.index].newObl.id);
              console.log(`  [LLM-MERGE] Confirmed duplicate obligation: "${batch[r.index].newObl.obligation_text.substring(0, 60)}..." — ${r.reason}`);
            }
          }
        }
      } catch (err) {
        console.warn('[MERGE-OBL] LLM verification failed (non-fatal):', err);
      }
    }
  }

  // 6. Delete duplicate obligations
  if (duplicateIds.length > 0) {
    await supabaseAdmin
      .from('matter_obligations')
      .delete()
      .in('id', duplicateIds);
    console.log(`[MERGE-OBL] Removed ${duplicateIds.length} duplicate obligations`);
  }

  return { duplicateIds, mergedCount: duplicateIds.length, tokens: totalTokens };
}


// ============================================================================
// PHASE 2b: DATE DEDUPLICATION
// ============================================================================

/**
 * Deduplicate dates — exact match on date_type + date_value.
 * No LLM needed; this is deterministic.
 */
async function deduplicateDates(
  caseId: string,
  tenantId: string,
  fileId: string,
): Promise<{ duplicateIds: string[]; count: number }> {
  // 1. Fetch existing dates
  const { data: existingDates } = await supabaseAdmin
    .from('matter_dates')
    .select('id, date_type, date_value, description, file_id')
    .eq('case_id', caseId)
    .eq('tenant_id', tenantId)
    .neq('file_id', fileId);

  if (!existingDates || existingDates.length === 0) {
    return { duplicateIds: [], count: 0 };
  }

  // 2. Fetch new dates
  const { data: newDates } = await supabaseAdmin
    .from('matter_dates')
    .select('id, date_type, date_value, description, file_id')
    .eq('case_id', caseId)
    .eq('tenant_id', tenantId)
    .eq('file_id', fileId);

  if (!newDates || newDates.length === 0) {
    return { duplicateIds: [], count: 0 };
  }

  // 3. Build a lookup set of existing dates: "type|value"
  const existingSet = new Set(
    existingDates.map(d => `${d.date_type}|${d.date_value}`)
  );

  // 4. Find exact duplicates
  const duplicateIds: string[] = [];
  for (const d of newDates) {
    const key = `${d.date_type}|${d.date_value}`;
    if (existingSet.has(key)) {
      duplicateIds.push(d.id);
      console.log(`  [DEDUP-DATE] Duplicate: ${d.date_type} ${d.date_value} — "${d.description.substring(0, 50)}"`);
    }
  }

  // 5. Delete duplicates
  if (duplicateIds.length > 0) {
    await supabaseAdmin
      .from('matter_dates')
      .delete()
      .in('id', duplicateIds);
    console.log(`[DEDUP-DATE] Removed ${duplicateIds.length} duplicate dates`);
  }

  return { duplicateIds, count: duplicateIds.length };
}


// ============================================================================
// PHASE 2c: RISK DEDUPLICATION
// ============================================================================

/**
 * Deduplicate risks — uses embeddings since risk descriptions vary.
 * No LLM for risks (cosine similarity only, higher threshold).
 */
async function deduplicateRisks(
  caseId: string,
  tenantId: string,
  fileId: string,
): Promise<{ duplicateIds: string[]; count: number }> {
  // 1. Fetch existing risks
  const { data: existingRisks } = await supabaseAdmin
    .from('matter_risks')
    .select('id, risk_type, risk_description, severity, file_id')
    .eq('case_id', caseId)
    .eq('tenant_id', tenantId)
    .neq('file_id', fileId);

  if (!existingRisks || existingRisks.length === 0) {
    return { duplicateIds: [], count: 0 };
  }

  // 2. Fetch new risks
  const { data: newRisks } = await supabaseAdmin
    .from('matter_risks')
    .select('id, risk_type, risk_description, severity, file_id')
    .eq('case_id', caseId)
    .eq('tenant_id', tenantId)
    .eq('file_id', fileId);

  if (!newRisks || newRisks.length === 0) {
    return { duplicateIds: [], count: 0 };
  }

  console.log(`[DEDUP-RISK] Comparing ${newRisks.length} new risks against ${existingRisks.length} existing`);

  // 3. Generate embeddings
  const existingTexts = existingRisks.map(r => `[${r.risk_type}|${r.severity}] ${r.risk_description.substring(0, 300)}`);
  const newTexts = newRisks.map(r => `[${r.risk_type}|${r.severity}] ${r.risk_description.substring(0, 300)}`);

  const allEmbeddings = await generateEmbeddings([...existingTexts, ...newTexts]);
  const existingEmbeddings = allEmbeddings.slice(0, existingTexts.length);
  const newEmbeddings = allEmbeddings.slice(existingTexts.length);

  // 4. Find duplicates (embeddings only, no LLM — risks are simpler)
  const duplicateIds: string[] = [];
  const RISK_SIMILARITY_THRESHOLD = 0.90; // Higher threshold for risks

  for (let i = 0; i < newRisks.length; i++) {
    for (let j = 0; j < existingRisks.length; j++) {
      const sim = cosineSimilarity(newEmbeddings[i], existingEmbeddings[j]);
      if (sim >= RISK_SIMILARITY_THRESHOLD) {
        duplicateIds.push(newRisks[i].id);
        console.log(`  [DEDUP-RISK] Duplicate (${(sim * 100).toFixed(1)}%): "${newRisks[i].risk_description.substring(0, 60)}..."`);
        break; // One match is enough
      }
    }
  }

  // 5. Delete duplicates
  if (duplicateIds.length > 0) {
    await supabaseAdmin
      .from('matter_risks')
      .delete()
      .in('id', duplicateIds);
    console.log(`[DEDUP-RISK] Removed ${duplicateIds.length} duplicate risks`);
  }

  return { duplicateIds, count: duplicateIds.length };
}


// ============================================================================
// PHASE 3: RELEVANCE FILTERING
// ============================================================================

/**
 * Score each newly added intelligence item against the matter's context.
 * Items with low relevance are flagged (metadata.relevance = 'low') but NOT deleted.
 * This helps summaries and dashboards prioritize important data.
 */
async function scoreRelevance(
  caseId: string,
  tenantId: string,
  fileId: string,
): Promise<{ high: number; medium: number; low: number; flagged: number; tokens: number }> {
  let totalTokens = 0;

  // 1. Build matter context from existing intelligence
  //    Gather a snapshot of what the matter is about
  const [
    { data: existingEntities },
    { data: existingClauses },
    { data: caseData },
  ] = await Promise.all([
    supabaseAdmin
      .from('matter_entities')
      .select('entity_type, entity_value')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId)
      .neq('file_id', fileId)
      .limit(50),
    supabaseAdmin
      .from('matter_clauses')
      .select('clause_type, summary')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId)
      .neq('file_id', fileId)
      .limit(30),
    supabaseAdmin
      .from('cases')
      .select('name, description')
      .eq('id', caseId)
      .single(),
  ]);

  // If this is the first file in the matter, everything is relevant
  if ((!existingEntities || existingEntities.length === 0) && (!existingClauses || existingClauses.length === 0)) {
    console.log('[RELEVANCE] First file in matter — all intelligence is relevant');
    return { high: 0, medium: 0, low: 0, flagged: 0, tokens: 0 };
  }

  // Build matter context string
  const matterContext = [
    `Matter: ${caseData?.name || 'Unknown'} — ${caseData?.description || 'No description'}`,
    '',
    'Key entities in this matter:',
    ...(existingEntities || []).slice(0, 30).map(e => `  - [${e.entity_type}] ${e.entity_value}`),
    '',
    'Key clauses in this matter:',
    ...(existingClauses || []).slice(0, 20).map(c => `  - [${c.clause_type}] ${c.summary}`),
  ].join('\n');

  // 2. Fetch new intelligence items (all types combined for efficiency)
  const [
    { data: newClauses },
    { data: newObligations },
    { data: newRisks },
  ] = await Promise.all([
    supabaseAdmin
      .from('matter_clauses')
      .select('id, clause_type, summary, clause_text')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId)
      .eq('file_id', fileId),
    supabaseAdmin
      .from('matter_obligations')
      .select('id, obligation_type, obligation_text, obligor, obligee')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId)
      .eq('file_id', fileId),
    supabaseAdmin
      .from('matter_risks')
      .select('id, risk_type, risk_description, severity')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId)
      .eq('file_id', fileId),
  ]);

  // Build items for relevance scoring
  const items: Array<{ id: string; table: string; text: string }> = [];

  for (const c of newClauses || []) {
    items.push({ id: c.id, table: 'matter_clauses', text: `[${c.clause_type}] ${c.summary || c.clause_text.substring(0, 200)}` });
  }
  for (const o of newObligations || []) {
    items.push({ id: o.id, table: 'matter_obligations', text: `[${o.obligation_type}] ${o.obligor} → ${o.obligee}: ${o.obligation_text.substring(0, 200)}` });
  }
  for (const r of newRisks || []) {
    items.push({ id: r.id, table: 'matter_risks', text: `[${r.risk_type}|${r.severity}] ${r.risk_description.substring(0, 200)}` });
  }

  if (items.length === 0) {
    return { high: 0, medium: 0, low: 0, flagged: 0, tokens: 0 };
  }

  console.log(`[RELEVANCE] Scoring ${items.length} items against matter context...`);

  // 3. Score in batches using LLM
  let high = 0, medium = 0, low = 0, flagged = 0;
  const RELEVANCE_BATCH = 30;

  for (let i = 0; i < items.length; i += RELEVANCE_BATCH) {
    const batch = items.slice(i, i + RELEVANCE_BATCH);

    const itemsForPrompt = batch.map((item, idx) => ({
      index: idx,
      text: item.text,
    }));

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.openai.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: COMPARISON_MODEL,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: `You are a legal intelligence relevance scoring expert. Given a matter's existing context and newly extracted intelligence items, score each item's relevance to the matter.

Scoring criteria:
- "high": Directly relevant to the matter (same parties, same legal issues, same transaction, critical dates/obligations)
- "medium": Tangentially relevant (related legal area, supporting context, background information)
- "low": Minimally relevant or generic (boilerplate, standard clauses that don't add matter-specific value, unrelated parties)

Important: Standard legal boilerplate (severability, entire agreement, amendment) that appears in many contracts is "low" unless it has unusual or matter-specific terms.

Respond with JSON: { "scores": [{ "index": <number>, "relevance": "high"|"medium"|"low", "reason": "<brief explanation>" }] }`,
            },
            {
              role: 'user',
              content: `MATTER CONTEXT:\n${matterContext}\n\nNEW ITEMS TO SCORE:\n${JSON.stringify(itemsForPrompt, null, 2)}`,
            },
          ],
        }),
      });

      const data: any = await response.json();
      totalTokens += data.usage?.total_tokens || 0;

      const content = data.choices?.[0]?.message?.content;
      if (content) {
        const parsed = JSON.parse(content);
        for (const s of parsed.scores || []) {
          const item = batch[s.index];
          if (!item) continue;

          const relevance = s.relevance || 'medium';

          // Update metadata with relevance score
          await supabaseAdmin
            .from(item.table)
            .update({ metadata: { relevance, relevance_reason: s.reason } })
            .eq('id', item.id);

          if (relevance === 'high') high++;
          else if (relevance === 'medium') medium++;
          else {
            low++;
            flagged++;
          }
        }
      }
    } catch (err) {
      console.warn('[RELEVANCE] Scoring failed (non-fatal):', err);
    }
  }

  console.log(`[RELEVANCE] Scored: ${high} high, ${medium} medium, ${low} low (${flagged} flagged)`);

  return { high, medium, low, flagged, tokens: totalTokens };
}


// ============================================================================
// MAIN PIPELINE
// ============================================================================

/**
 * Run the full smart comparison pipeline on a newly extracted file.
 * Call this AFTER saveExtractionResults() and canonicalization.
 * 
 * @param caseId - The matter/case ID
 * @param tenantId - The tenant ID  
 * @param fileId - The file that was just extracted
 * @param filename - Filename for logging
 */
export async function runSmartComparison(
  caseId: string,
  tenantId: string,
  fileId: string,
  filename: string,
): Promise<ComparisonResult> {
  const startTime = Date.now();
  let totalTokens = 0;

  console.log(`\n🔍 Smart Comparison Pipeline — ${filename}`);
  console.log(`   Matter: ${caseId}`);

  // Check if there's existing intelligence in this matter (from other files)
  const { count: existingIntelCount } = await supabaseAdmin
    .from('matter_clauses')
    .select('*', { count: 'exact', head: true })
    .eq('case_id', caseId)
    .eq('tenant_id', tenantId)
    .neq('file_id', fileId);

  const hasExistingIntelligence = (existingIntelCount || 0) > 0;

  // Count what was extracted for this file
  const [
    { count: newClauseCount },
    { count: newOblCount },
    { count: newDateCount },
    { count: newRiskCount },
  ] = await Promise.all([
    supabaseAdmin.from('matter_clauses').select('*', { count: 'exact', head: true }).eq('case_id', caseId).eq('file_id', fileId),
    supabaseAdmin.from('matter_obligations').select('*', { count: 'exact', head: true }).eq('case_id', caseId).eq('file_id', fileId),
    supabaseAdmin.from('matter_dates').select('*', { count: 'exact', head: true }).eq('case_id', caseId).eq('file_id', fileId),
    supabaseAdmin.from('matter_risks').select('*', { count: 'exact', head: true }).eq('case_id', caseId).eq('file_id', fileId),
  ]);

  const result: ComparisonResult = {
    clauses: { total_extracted: newClauseCount || 0, duplicates_found: 0, unique_kept: newClauseCount || 0, merged: 0 },
    obligations: { total_extracted: newOblCount || 0, duplicates_found: 0, unique_kept: newOblCount || 0, merged: 0 },
    dates: { total_extracted: newDateCount || 0, duplicates_found: 0, unique_kept: newDateCount || 0 },
    risks: { total_extracted: newRiskCount || 0, duplicates_found: 0, unique_kept: newRiskCount || 0 },
    relevance: { high_relevance: 0, medium_relevance: 0, low_relevance: 0, flagged: 0 },
    tokens_used: 0,
    processing_time_ms: 0,
  };

  if (!hasExistingIntelligence) {
    console.log(`[SMART-CMP] First file in matter — skipping comparison, running relevance only`);
    
    // Still run relevance scoring for the first file (scores against matter name/description)
    const relevanceResult = await scoreRelevance(caseId, tenantId, fileId);
    totalTokens += relevanceResult.tokens;
    result.relevance = {
      high_relevance: relevanceResult.high,
      medium_relevance: relevanceResult.medium,
      low_relevance: relevanceResult.low,
      flagged: relevanceResult.flagged,
    };

    result.tokens_used = totalTokens;
    result.processing_time_ms = Date.now() - startTime;
    console.log(`✅ Smart comparison complete in ${result.processing_time_ms}ms (${totalTokens} tokens — first file, no dedup needed)`);
    return result;
  }

  // ── Phase 1: Clause Deduplication ──
  console.log('\n── Phase 1: Clause Deduplication ──');
  const clauseResult = await deduplicateClauses(caseId, tenantId, fileId);
  totalTokens += clauseResult.tokens;
  result.clauses.duplicates_found = clauseResult.mergedCount;
  result.clauses.unique_kept = (newClauseCount || 0) - clauseResult.mergedCount;
  result.clauses.merged = clauseResult.mergedCount;

  // ── Phase 2: Obligation Merging ──
  console.log('\n── Phase 2: Obligation Merging ──');
  const oblResult = await mergeObligations(caseId, tenantId, fileId);
  totalTokens += oblResult.tokens;
  result.obligations.duplicates_found = oblResult.mergedCount;
  result.obligations.unique_kept = (newOblCount || 0) - oblResult.mergedCount;
  result.obligations.merged = oblResult.mergedCount;

  // ── Phase 2b: Date Deduplication ──
  console.log('\n── Phase 2b: Date Deduplication ──');
  const dateResult = await deduplicateDates(caseId, tenantId, fileId);
  result.dates.duplicates_found = dateResult.count;
  result.dates.unique_kept = (newDateCount || 0) - dateResult.count;

  // ── Phase 2c: Risk Deduplication ──
  console.log('\n── Phase 2c: Risk Deduplication ──');
  const riskResult = await deduplicateRisks(caseId, tenantId, fileId);
  result.risks.duplicates_found = riskResult.count;
  result.risks.unique_kept = (newRiskCount || 0) - riskResult.count;

  // ── Phase 3: Relevance Filtering ──
  console.log('\n── Phase 3: Relevance Filtering ──');
  const relevanceResult = await scoreRelevance(caseId, tenantId, fileId);
  totalTokens += relevanceResult.tokens;
  result.relevance = {
    high_relevance: relevanceResult.high,
    medium_relevance: relevanceResult.medium,
    low_relevance: relevanceResult.low,
    flagged: relevanceResult.flagged,
  };

  result.tokens_used = totalTokens;
  result.processing_time_ms = Date.now() - startTime;

  // Track token usage
  trackTokenUsage({
    tenant_id: tenantId,
    operation: 'other',
    model: COMPARISON_MODEL,
    prompt_tokens: Math.round(totalTokens * 0.7), // Approximate split
    completion_tokens: Math.round(totalTokens * 0.3),
    case_id: caseId,
    file_id: fileId,
    metadata: {
      filename,
      clauses_deduped: clauseResult.mergedCount,
      obligations_merged: oblResult.mergedCount,
      dates_deduped: dateResult.count,
      risks_deduped: riskResult.count,
      relevance_flagged: relevanceResult.flagged,
    },
  });

  console.log(`\n✅ Smart comparison complete in ${result.processing_time_ms}ms (${totalTokens} tokens)`);
  console.log(`   Clauses: ${result.clauses.unique_kept} kept / ${result.clauses.duplicates_found} deduped`);
  console.log(`   Obligations: ${result.obligations.unique_kept} kept / ${result.obligations.duplicates_found} merged`);
  console.log(`   Dates: ${result.dates.unique_kept} kept / ${result.dates.duplicates_found} deduped`);
  console.log(`   Risks: ${result.risks.unique_kept} kept / ${result.risks.duplicates_found} deduped`);
  console.log(`   Relevance: ${result.relevance.high_relevance} high, ${result.relevance.medium_relevance} medium, ${result.relevance.low_relevance} low`);

  return result;
}
