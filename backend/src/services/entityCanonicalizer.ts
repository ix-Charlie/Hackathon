/**
 * Entity Canonicalizer Service
 * 
 * Phase 1 of Entity Intelligence — validates, deduplicates, and canonicalizes
 * extracted entities across all documents in a matter.
 * 
 * Pipeline:
 *   1. validateEntities()    — Uses reasoning model to fix misclassifications,
 *                              filter noise, and normalize values
 *   2. canonicalizeEntities() — Merges aliases, deduplicates across documents,
 *                              creates/updates canonical_entities records
 *   3. linkEntities()        — Links raw matter_entities to their canonical version
 */

import { config } from '../config/index.js';
import { supabaseAdmin } from '../config/supabase.js';
import { trackTokenUsage, estimateCost } from './tokenUsageService.js';

// ============================================================================
// TYPES
// ============================================================================

/** Expanded entity type taxonomy (16 types) */
export const ENTITY_TYPES = [
  'party', 'court', 'statute', 'defined_term', 'judge', 'jurisdiction',
  'regulatory_body', 'witness', 'law_firm', 'government_agency',
  'law_enforcement', 'contract', 'evidence', 'location', 'vehicle', 'publication',
] as const;

export type EntityType = typeof ENTITY_TYPES[number];

interface RawEntity {
  id: string;
  entity_type: string;
  entity_value: string;
  normalized_value?: string;
  confidence: number;
  file_id: string;
  context_snippet?: string;
  metadata?: Record<string, unknown>;
}

interface ValidatedEntity extends RawEntity {
  validated_type: EntityType;
  validated_name: string;
  validation_confidence: number;
  is_noise: boolean;
  validation_notes?: string;
}

interface CanonicalEntity {
  id?: string;
  entity_type: EntityType;
  canonical_name: string;
  aliases: string[];
  confidence: number;
  mention_count: number;
  verification_status: 'unverified' | 'auto_verified' | 'user_verified' | 'rejected';
  metadata?: Record<string, unknown>;
}

interface CanonicalizeResult {
  canonical_entities_created: number;
  canonical_entities_updated: number;
  raw_entities_linked: number;
  entities_rejected: number;
  tokens_used: number;
  processing_time_ms: number;
}

// ============================================================================
// OPENAI HELPER (shared pattern from extractionService)
// ============================================================================

async function callReasoningModel<T>(
  systemPrompt: string,
  userPrompt: string,
  tenantId: string,
  caseId: string,
): Promise<{ result: T | null; tokens: number; promptTokens: number; completionTokens: number }> {
  const model = config.openai.reasoningModel;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt + '\n\nRespond with valid JSON only.' },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`OpenAI reasoning model error (${response.status}):`, errorText);
      return { result: null, tokens: 0, promptTokens: 0, completionTokens: 0 };
    }

    const data = await response.json() as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const content = data.choices?.[0]?.message?.content;
    const promptTokens = data.usage?.prompt_tokens || 0;
    const completionTokens = data.usage?.completion_tokens || 0;
    const tokensUsed = promptTokens + completionTokens;

    if (!content) {
      return { result: null, tokens: tokensUsed, promptTokens, completionTokens };
    }

    const parsed = JSON.parse(content) as T;

    // Track usage
    trackTokenUsage({
      tenant_id: tenantId,
      operation: 'validation',
      model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      case_id: caseId,
    });

    return { result: parsed, tokens: tokensUsed, promptTokens, completionTokens };
  } catch (error) {
    console.error('Reasoning model call failed:', error);
    return { result: null, tokens: 0, promptTokens: 0, completionTokens: 0 };
  }
}

// ============================================================================
// STEP 1: VALIDATE ENTITIES
// ============================================================================

const VALIDATION_SYSTEM_PROMPT = `You are a legal entity validation assistant operating on PROMOTED entities (already supervisor-validated).

Your job is to perform FINAL cleanup before database canonicalization:

1. FIX REMAINING MISCLASSIFICATIONS: If an entity still has the wrong type, correct it.
   - Example: "California" typed as "party" should be "jurisdiction"
   - Example: "Section 4.2" typed as "statute" should be "defined_term"
   
2. FILTER RESIDUAL NOISE: Mark any remaining non-entity extractions as noise.
   - These should be rare since the supervisor already filtered most noise.
   - Examples: descriptive text that slipped through, partial names, abbreviations without context.

3. NORMALIZE VALUES: Provide the best canonical spelling/formatting.
   - "O.J. Simpson" and "Orenthal James Simpson" → normalized as "O.J. Simpson"
   - "Cal. Penal Code § 187" → normalized as "California Penal Code Section 187"
   - Standardize court names: "Hon'ble SC" → "Supreme Court of Pakistan"

4. RECLASSIFY with expanded types. Available entity types:
   party, court, statute, defined_term, judge, jurisdiction, regulatory_body,
   witness, law_firm, government_agency, law_enforcement, contract, evidence,
   location, vehicle, publication

5. STRICT REJECTION RULES (even on promoted entities):
   - Body parts, organs, anatomy references → ALWAYS noise
   - Generic building/room references without proper names → noise
   - Conversational fragments, emotional phrases → noise
   - Single common words (unless they are verified defined terms) → noise

Return a JSON object with key "validated_entities" containing an array of objects:
{
  "validated_entities": [
    {
      "id": "<original entity id>",
      "validated_type": "<corrected entity_type>",
      "validated_name": "<best canonical name>",
      "validation_confidence": <0.0–1.0>,
      "is_noise": <true|false>,
      "validation_notes": "<brief reason for any change>"
    }
  ]
}`;

interface ValidationResponse {
  validated_entities: Array<{
    id: string;
    validated_type: EntityType;
    validated_name: string;
    validation_confidence: number;
    is_noise: boolean;
    validation_notes?: string;
  }>;
}

/**
 * Validate a batch of raw entities using the reasoning model.
 * Processes in batches of 50 to stay within context limits.
 */
export async function validateEntities(
  rawEntities: RawEntity[],
  tenantId: string,
  caseId: string,
): Promise<ValidatedEntity[]> {
  if (rawEntities.length === 0) return [];

  console.log(`[CANONICALIZER] Validating ${rawEntities.length} entities...`);
  
  const BATCH_SIZE = 50;
  const validated: ValidatedEntity[] = [];

  for (let i = 0; i < rawEntities.length; i += BATCH_SIZE) {
    const batch = rawEntities.slice(i, i + BATCH_SIZE);

    const entitiesForPrompt = batch.map(e => ({
      id: e.id,
      entity_type: e.entity_type,
      entity_value: e.entity_value,
      normalized_value: e.normalized_value,
      confidence: e.confidence,
      context_snippet: e.context_snippet?.substring(0, 200),
    }));

    const userPrompt = `Validate these ${batch.length} extracted legal entities:\n\n${JSON.stringify(entitiesForPrompt, null, 2)}`;

    const { result } = await callReasoningModel<ValidationResponse>(
      VALIDATION_SYSTEM_PROMPT,
      userPrompt,
      tenantId,
      caseId,
    );

    if (result?.validated_entities) {
      // Map validation results back to full entities
      for (const v of result.validated_entities) {
        const original = batch.find(e => e.id === v.id);
        if (!original) continue;

        validated.push({
          ...original,
          validated_type: ENTITY_TYPES.includes(v.validated_type as EntityType)
            ? v.validated_type as EntityType
            : original.entity_type as EntityType,
          validated_name: v.validated_name || original.entity_value,
          validation_confidence: v.validation_confidence ?? original.confidence,
          is_noise: v.is_noise ?? false,
          validation_notes: v.validation_notes,
        });
      }

      // Include any entities the model didn't return (keep as-is)
      for (const original of batch) {
        if (!result.validated_entities.find(v => v.id === original.id)) {
          validated.push({
            ...original,
            validated_type: original.entity_type as EntityType,
            validated_name: original.entity_value,
            validation_confidence: original.confidence,
            is_noise: false,
          });
        }
      }
    } else {
      // Model call failed — keep originals as-is
      for (const original of batch) {
        validated.push({
          ...original,
          validated_type: original.entity_type as EntityType,
          validated_name: original.entity_value,
          validation_confidence: original.confidence,
          is_noise: false,
        });
      }
    }

    console.log(`[CANONICALIZER] Validated batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(rawEntities.length / BATCH_SIZE)}`);
  }

  const noiseCount = validated.filter(e => e.is_noise).length;
  const reclassifiedCount = validated.filter(e => e.validated_type !== e.entity_type).length;
  console.log(`[CANONICALIZER] Validation complete: ${noiseCount} noise, ${reclassifiedCount} reclassified`);

  return validated;
}

// ============================================================================
// STEP 2: CANONICALIZE (MERGE & DEDUPLICATE)
// ============================================================================

/**
 * Group validated entities into canonical clusters.
 * Uses string similarity + type matching for local dedup,
 * then calls reasoning model for ambiguous cases.
 */
export async function canonicalizeEntities(
  validatedEntities: ValidatedEntity[],
  tenantId: string,
  caseId: string,
): Promise<CanonicalizeResult> {
  const startTime = Date.now();
  let totalTokens = 0;
  let created = 0;
  let updated = 0;
  let linked = 0;
  let rejected = 0;

  // Filter out noise
  const goodEntities = validatedEntities.filter(e => !e.is_noise);
  rejected = validatedEntities.length - goodEntities.length;

  console.log(`[CANONICALIZER] Canonicalizing ${goodEntities.length} entities (${rejected} noise filtered)...`);

  // ── Local clustering by normalized name + type ──
  const clusters = new Map<string, ValidatedEntity[]>();

  for (const entity of goodEntities) {
    // Use validated_name for clustering key (avoid colon-split bugs on names containing colons)
    const normName = entity.validated_name.toLowerCase().trim();
    const key = `${entity.validated_type}::${normName}`;
    const existing = clusters.get(key);
    if (existing) {
      existing.push(entity);
    } else {
      clusters.set(key, [entity]);
    }
  }

  // ── Phase 1: Safe deterministic merges (exact substring within same type) ──
  const clusterKeys = Array.from(clusters.keys());
  const mergedKeys = new Set<string>();

  for (let i = 0; i < clusterKeys.length; i++) {
    if (mergedKeys.has(clusterKeys[i])) continue;
    
    const sepIdx = clusterKeys[i].indexOf('::');
    const typeA = clusterKeys[i].substring(0, sepIdx);
    const nameA = clusterKeys[i].substring(sepIdx + 2);
    
    for (let j = i + 1; j < clusterKeys.length; j++) {
      if (mergedKeys.has(clusterKeys[j])) continue;
      
      const sepIdxB = clusterKeys[j].indexOf('::');
      const typeB = clusterKeys[j].substring(0, sepIdxB);
      const nameB = clusterKeys[j].substring(sepIdxB + 2);
      
      // Only merge same type
      if (typeA !== typeB) continue;
      
      // Check if one name contains the other AND they share at least 3 chars
      // (prevents merging "A" into "ABC" just because A is a substring)
      const shorter = nameA.length <= nameB.length ? nameA : nameB;
      const longer = nameA.length <= nameB.length ? nameB : nameA;
      
      if (shorter.length >= 3 && longer.includes(shorter)) {
        // Merge shorter-name cluster into longer-name cluster
        const entitiesB = clusters.get(clusterKeys[j]) || [];
        const entitiesA = clusters.get(clusterKeys[i]) || [];
        entitiesA.push(...entitiesB);
        clusters.delete(clusterKeys[j]);
        mergedKeys.add(clusterKeys[j]);
      }
    }
  }

  // ── Phase 2: LLM-assisted coreference for ambiguous pairs ──
  // Only run if we have enough clusters to warrant it (>2) and not too many (<100)
  const remainingKeys = Array.from(clusters.keys()).filter(k => !mergedKeys.has(k));
  if (remainingKeys.length > 2 && remainingKeys.length < 100) {
    try {
      const clusterSummaries = remainingKeys.map(k => {
        const sepIdx = k.indexOf('::');
        const type = k.substring(0, sepIdx);
        const name = k.substring(sepIdx + 2);
        const count = clusters.get(k)?.length || 0;
        return { key: k, type, name, count };
      });

      // Group by type for more efficient LLM comparison
      const typeGroups = new Map<string, typeof clusterSummaries>();
      for (const cs of clusterSummaries) {
        const group = typeGroups.get(cs.type) || [];
        group.push(cs);
        typeGroups.set(cs.type, group);
      }

      for (const [entityType, group] of typeGroups) {
        // Only need LLM merge if >1 entity of same type
        if (group.length < 2) continue;
        // Limit to types with manageable cluster counts
        if (group.length > 30) continue;

        const entityList = group.map((g, idx) => `[${idx}] "${g.name}" (${g.count} mentions)`).join('\n');

        const { result, tokens: mergeTokens } = await callReasoningModel<{
          merge_groups: Array<{ indices: number[]; canonical_name: string; reason: string }>;
        }>(
          `You are an entity coreference resolver for legal documents. Given a list of entity names of type "${entityType}", identify which ones refer to the SAME real-world entity and should be merged.

Rules:
- Only merge entities that clearly refer to the same person, organization, or concept
- "O.J. Simpson" and "Orenthal James Simpson" → merge
- "Judge Ito" and "Lance Ito" → merge
- "Los Angeles Police Department" and "LAPD" → merge
- "California" (jurisdiction) and "State of California" → merge
- Do NOT merge entities that are merely related (e.g., "Goldman family" and "Fred Goldman" are separate)
- When merging, pick the most complete/formal version as canonical_name
- Return empty merge_groups if no merges are needed

Return JSON: { "merge_groups": [{ "indices": [0, 3], "canonical_name": "Best Name", "reason": "brief reason" }] }`,
          `Identify which of these "${entityType}" entities should be merged:\n\n${entityList}`,
          tenantId,
          caseId,
        );

        totalTokens += mergeTokens;

        if (result?.merge_groups) {
          for (const mg of result.merge_groups) {
            if (!mg.indices || mg.indices.length < 2) continue;

            // Merge all into the first index's cluster
            const primaryIdx = mg.indices[0];
            const primaryKey = group[primaryIdx]?.key;
            if (!primaryKey || !clusters.has(primaryKey)) continue;

            const primaryCluster = clusters.get(primaryKey)!;

            for (let mi = 1; mi < mg.indices.length; mi++) {
              const mergeIdx = mg.indices[mi];
              const mergeKey = group[mergeIdx]?.key;
              if (!mergeKey || !clusters.has(mergeKey)) continue;

              const mergeCluster = clusters.get(mergeKey)!;
              primaryCluster.push(...mergeCluster);
              clusters.delete(mergeKey);
            }

            // Update validated_name on all entities in the merged cluster to canonical_name
            if (mg.canonical_name) {
              for (const entity of primaryCluster) {
                if (entity.validated_name.toLowerCase() !== mg.canonical_name.toLowerCase()) {
                  // Keep original as-is but the canonical name will be used for the canonical_entity record
                  entity.validated_name = mg.canonical_name;
                }
              }
            }
          }
        }
      }

      console.log(`[CANONICALIZER] After LLM coreference: ${clusters.size} clusters`);
    } catch (corefErr) {
      console.warn('[CANONICALIZER] LLM coreference failed (non-fatal), using deterministic merges only:', corefErr);
    }
  }

  console.log(`[CANONICALIZER] ${clusters.size} canonical clusters formed from ${goodEntities.length} entities`);

  // ── Upsert canonical entities ──
  for (const [, clusterEntities] of clusters) {
    if (clusterEntities.length === 0) continue;

    // Pick the best representative name (highest confidence)
    const sorted = [...clusterEntities].sort((a, b) => b.validation_confidence - a.validation_confidence);
    const bestEntity = sorted[0];
    const canonicalName = bestEntity.validated_name;
    const entityType = bestEntity.validated_type;

    // Collect all unique aliases
    const aliasSet = new Set<string>();
    for (const e of clusterEntities) {
      aliasSet.add(e.entity_value);
      if (e.validated_name !== canonicalName) {
        aliasSet.add(e.validated_name);
      }
      if (e.normalized_value && e.normalized_value !== canonicalName) {
        aliasSet.add(e.normalized_value);
      }
    }
    aliasSet.delete(canonicalName); // Don't include canonical name in aliases
    const aliases = Array.from(aliasSet);

    // Aggregate confidence
    const avgConfidence = clusterEntities.reduce((s, e) => s + e.validation_confidence, 0) / clusterEntities.length;
    const mentionCount = clusterEntities.length;

    // Auto-verify if high confidence + multiple mentions
    const verificationStatus = (avgConfidence >= 0.85 && mentionCount >= 2)
      ? 'auto_verified'
      : 'unverified';

    // Upsert canonical entity
    const { data: canonical, error: upsertError } = await supabaseAdmin
      .from('canonical_entities')
      .upsert(
        {
          tenant_id: tenantId,
          case_id: caseId,
          entity_type: entityType,
          canonical_name: canonicalName,
          aliases,
          confidence: Math.round(avgConfidence * 100) / 100,
          mention_count: mentionCount,
          verification_status: verificationStatus,
        },
        { onConflict: 'tenant_id,case_id,entity_type,canonical_name' }
      )
      .select('id')
      .single();

    if (upsertError) {
      console.error(`[CANONICALIZER] Failed to upsert canonical entity "${canonicalName}":`, upsertError.message);
      continue;
    }

    if (canonical) {
      created++; // counts both creates and updates via upsert

      // Link all raw entities in this cluster to the canonical entity
      for (const entity of clusterEntities) {
        const { error: linkError } = await supabaseAdmin
          .from('matter_entities')
          .update({
            canonical_entity_id: canonical.id,
            entity_type: entity.validated_type, // Apply corrected type
            normalized_value: entity.validated_name, // Apply validated name
          })
          .eq('id', entity.id);

        if (!linkError) linked++;
      }
    }
  }

  const result: CanonicalizeResult = {
    canonical_entities_created: created,
    canonical_entities_updated: updated,
    raw_entities_linked: linked,
    entities_rejected: rejected,
    tokens_used: totalTokens,
    processing_time_ms: Date.now() - startTime,
  };

  console.log(`[CANONICALIZER] Complete:`, JSON.stringify(result));
  return result;
}

// ============================================================================
// FULL CANONICALIZATION PIPELINE
// ============================================================================

/**
 * Run the full canonicalization pipeline for a matter.
 * Called after extraction completes (or on manual reprocess).
 * 
 * 1. Fetch all raw entities for the matter
 * 2. Validate with reasoning model
 * 3. Canonicalize (cluster, merge, upsert)
 */
export async function runCanonicalizationPipeline(
  caseId: string,
  tenantId: string,
  fileId?: string,
): Promise<CanonicalizeResult> {
  console.log(`\n[CANONICALIZER] Starting canonicalization for matter ${caseId}${fileId ? ` (file: ${fileId})` : ' (all files)'}...`);

  // 1. Fetch raw entities
  let query = supabaseAdmin
    .from('matter_entities')
    .select('id, entity_type, entity_value, normalized_value, confidence, file_id, context_snippet, metadata')
    .eq('case_id', caseId)
    .eq('tenant_id', tenantId);

  if (fileId) {
    query = query.eq('file_id', fileId);
  }

  const { data: rawEntities, error } = await query;

  if (error) {
    console.error('[CANONICALIZER] Failed to fetch entities:', error.message);
    return {
      canonical_entities_created: 0,
      canonical_entities_updated: 0,
      raw_entities_linked: 0,
      entities_rejected: 0,
      tokens_used: 0,
      processing_time_ms: 0,
    };
  }

  if (!rawEntities || rawEntities.length === 0) {
    console.log('[CANONICALIZER] No entities to canonicalize.');
    return {
      canonical_entities_created: 0,
      canonical_entities_updated: 0,
      raw_entities_linked: 0,
      entities_rejected: 0,
      tokens_used: 0,
      processing_time_ms: 0,
    };
  }

  console.log(`[CANONICALIZER] Found ${rawEntities.length} raw entities`);

  // 2. Validate
  const validated = await validateEntities(rawEntities as RawEntity[], tenantId, caseId);

  // 3. Canonicalize
  const result = await canonicalizeEntities(validated, tenantId, caseId);

  return result;
}
