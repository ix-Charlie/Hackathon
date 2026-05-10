/**
 * Legal Extraction Service
 * 
 * Deterministic extraction pipeline that runs after document processing.
 * Extracts structured legal intelligence from document chunks:
 *   - Entities (parties, courts, statutes, defined terms)
 *   - Clauses (classified by type with risk levels)
 *   - Obligations (who owes what to whom)
 *   - Critical dates (effective, termination, deadlines)
 *   - Risks (identified risk indicators)
 *   - Cross-references (links between documents)
 * 
 * Uses gpt-4o-mini with structured JSON schema outputs and Zod validation.
 */

import { config } from '../config/index.js';
import { supabaseAdmin } from '../config/supabase.js';
import { trackTokenUsage } from './tokenUsageService.js';
import { sanitizeObject } from '../middleware/security.js';
import { runCanonicalizationPipeline, ENTITY_TYPES as CANONICAL_ENTITY_TYPES, type EntityType } from './entityCanonicalizer.js';
import { runSmartComparison, type ComparisonResult } from './intelligenceComparisonService.js';
import {
  runSupervisoryPipeline,
  type CandidateEntity,
  type PromotedEntity,
  type SupervisoryResult,
} from './supervisoryValidator.js';

// ============================================================================
// TYPES
// ============================================================================

export interface ExtractionJob {
  file_id: string;
  tenant_id: string;
  case_id: string;
  filename: string;
}

export interface ExtractionResult {
  success: boolean;
  file_id: string;
  entities_count: number;
  clauses_count: number;
  obligations_count: number;
  dates_count: number;
  risks_count: number;
  cross_refs_count: number;
  tokens_used: number;
  processing_time_ms: number;
  error?: string;
  // Supervisory validation stats
  supervisory?: {
    total_candidates: number;
    promoted: number;
    pre_filter_rejected: number;
    supervisor_rejected: number;
    refinement_triggered: boolean;
    refinement_corrections: number;
    quality_score: number;
  };
}

interface ExtractedEntity {
  entity_type: 'party' | 'court' | 'statute' | 'defined_term' | 'judge' | 'jurisdiction' | 'regulatory_body' | 'witness' | 'law_firm' | 'government_agency' | 'law_enforcement' | 'contract' | 'evidence' | 'location' | 'vehicle' | 'publication';
  entity_value: string;
  normalized_value?: string;
  context_snippet?: string;
  confidence: number;
}

interface ExtractedClause {
  clause_type: 'indemnity' | 'limitation_of_liability' | 'termination' | 'governing_law' | 'confidentiality' | 'non_compete' | 'force_majeure' | 'assignment' | 'warranty' | 'dispute_resolution' | 'payment' | 'insurance' | 'intellectual_property' | 'representations' | 'notice' | 'amendment' | 'severability' | 'entire_agreement' | 'waiver' | 'other';
  clause_text: string;
  section_ref?: string;
  summary: string;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  risk_reason?: string;
  confidence: number;
}

interface ExtractedObligation {
  obligor: string;
  obligee: string;
  obligation_text: string;
  obligation_type: 'payment' | 'delivery' | 'performance' | 'notice' | 'reporting' | 'compliance' | 'indemnification' | 'insurance' | 'confidentiality' | 'other';
  due_date?: string;
  recurring: boolean;
  recurrence_rule?: string;
  condition?: string;
  confidence: number;
}

interface ExtractedDate {
  date_type: 'effective' | 'termination' | 'renewal' | 'deadline' | 'notice_period' | 'payment_due' | 'filing' | 'hearing' | 'expiry' | 'commencement' | 'review' | 'milestone';
  date_value: string;
  description: string;
  is_recurring: boolean;
  recurrence_rule?: string;
  source_text?: string;
  confidence: number;
}

interface ExtractedRisk {
  risk_type: string;
  risk_description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  recommendation?: string;
  related_clause_index?: number;
  confidence: number;
}

// ============================================================================
// EXTRACTION MODEL CONFIG
// ============================================================================

const EXTRACTION_MODEL = config.openai.extractionModel;
const EXTRACTION_TEMPERATURE = 0;
const MAX_CHUNK_CHARS_PER_CALL = 12000; // ~3K tokens input per call

// ============================================================================
// DOCUMENT-TYPE CLASSIFICATION
// ============================================================================

/** Supported document types with extraction-relevant semantics */
export type DocumentType =
  | 'contract'
  | 'pleading'
  | 'case_study'
  | 'correspondence'
  | 'regulation'
  | 'autopsy_report'
  | 'deposition'
  | 'court_order'
  | 'memo'
  | 'evidence_exhibit'
  | 'other';

/** Per-document-type extraction instructions that get injected into entity prompts */
const DOCUMENT_TYPE_ENTITY_INSTRUCTIONS: Record<DocumentType, string> = {
  contract: `DOCUMENT TYPE: CONTRACT
- Focus on: contracting parties, defined terms, governing law jurisdictions, referenced statutes, law firms
- Entities like "Party A", "Licensee", "Licensor" are valid defined_term entities
- Section references (e.g., "Section 4.2") should only be extracted if they define a named term
- Do NOT extract generic contract boilerplate words`,

  pleading: `DOCUMENT TYPE: PLEADING / LITIGATION FILING
- Focus on: named parties (plaintiff, defendant), courts, judges, statutes cited, case numbers, jurisdictions
- "The People of the State of California" is a valid party
- Extract case citations (e.g., "Miranda v. Arizona, 384 U.S. 436")
- Do NOT extract procedural boilerplate ("comes now", "respectfully submits")`,

  case_study: `DOCUMENT TYPE: CASE STUDY / CASE FILE
- Focus on: named persons (victims, suspects, witnesses), courts, judges, locations of events, evidence items, statutes, law enforcement agencies
- Do NOT extract body parts, anatomy terms, medical terminology, or cause-of-death descriptions as entities
- "Rockingham estate" is a valid location; "left hand" is NOT an entity
- Crime scene locations are valid location entities
- Weapons or physical evidence items (e.g., "leather glove", "blood samples") may be valid evidence entities ONLY if they are named/specific exhibits`,

  correspondence: `DOCUMENT TYPE: CORRESPONDENCE / LETTER / EMAIL
- Focus on: sender, recipient, referenced persons, organizations, referenced cases or matters
- Do NOT extract greetings, sign-offs, or conversational phrases as entities`,

  regulation: `DOCUMENT TYPE: REGULATION / STATUTE / LEGISLATIVE TEXT
- Focus on: regulatory bodies, defined terms, referenced statutes, jurisdictions, government agencies
- Section numbers and article references are valid defined_term entities only if they introduce a named concept`,

  autopsy_report: `DOCUMENT TYPE: AUTOPSY / MEDICAL-LEGAL REPORT
- CRITICAL: Do NOT extract ANY body parts, organs, anatomical terms, medical procedures, or cause-of-death descriptions as entities
- Focus ONLY on: decedent name, medical examiner name, investigating officers, law enforcement agencies, locations (morgue, hospital), case/report numbers
- "Blunt force trauma to the head" is NOT an entity — it is a medical finding
- Expected entity count: typically 5-15 for an autopsy report`,

  deposition: `DOCUMENT TYPE: DEPOSITION / TESTIMONY TRANSCRIPT
- Focus on: deponent name, attorneys present, referenced persons, courts, case references
- "Q:" and "A:" prefixes indicate question/answer — extract named entities from the content, not the format
- Do NOT extract conversational fragments or emotional descriptions`,

  court_order: `DOCUMENT TYPE: COURT ORDER / JUDGMENT / RULING
- Focus on: court name, judge(s), parties, statutes applied, case citations, jurisdictions
- Orders and directives are obligations, not entities
- "IT IS HEREBY ORDERED" is boilerplate, not an entity`,

  memo: `DOCUMENT TYPE: LEGAL MEMO / BRIEF / OPINION
- Focus on: author, recipient, referenced cases, statutes, parties discussed, jurisdictions
- Legal analysis and reasoning are not entities — extract only proper names and references`,

  evidence_exhibit: `DOCUMENT TYPE: EVIDENCE EXHIBIT / FORENSIC REPORT
- Focus on: exhibit numbers, evidence item names, analysts, agencies, locations
- Do NOT extract descriptions of physical characteristics as entities
- Lab results and measurements are not entities`,

  other: `DOCUMENT TYPE: UNCLASSIFIED
- Apply general legal entity extraction rules
- Focus on named persons, organizations, courts, statutes, jurisdictions, defined terms
- When in doubt, extract with lower confidence and let the supervisor decide`,
};

/**
 * Classify the document type using a cheap, fast LLM call on the first analysis window.
 * This drives downstream prompt specialization.
 */
async function classifyDocumentType(
  firstWindow: string,
  filename: string,
): Promise<{ documentType: DocumentType; tokens: number; promptTokens: number; completionTokens: number }> {
  const { result, tokens, promptTokens, completionTokens } = await callOpenAI<{ document_type: string; reasoning: string }>({
    systemPrompt: `You are a legal document classifier. Given the beginning of a document, classify it into exactly ONE of these types:

- contract: Agreements, leases, licenses, NDAs, MSAs, SOWs, purchase orders
- pleading: Complaints, motions, briefs, petitions, answers filed with a court
- case_study: Case files, investigative reports, crime scene reports, case analyses
- correspondence: Letters, emails, memos between parties (non-analytical)
- regulation: Statutes, regulations, legislative text, administrative rules, codes
- autopsy_report: Autopsy reports, medical examiner reports, toxicology reports
- deposition: Deposition transcripts, witness examination transcripts
- court_order: Court orders, judgments, rulings, decrees, injunctions
- memo: Legal memoranda, opinion letters, research briefs, internal analyses
- evidence_exhibit: Evidence exhibits, forensic lab reports, chain of custody documents
- other: Anything that doesn't fit the above categories

Return JSON: { "document_type": "<type>", "reasoning": "<one sentence why>" }`,
    userPrompt: `Classify this document (filename: "${filename}"):\n\n${firstWindow.substring(0, 3000)}`,
    responseSchema: {
      type: 'object',
      properties: {
        document_type: { type: 'string', enum: ['contract', 'pleading', 'case_study', 'correspondence', 'regulation', 'autopsy_report', 'deposition', 'court_order', 'memo', 'evidence_exhibit', 'other'] },
        reasoning: { type: 'string' },
      },
      required: ['document_type', 'reasoning'],
    },
  });

  const docType = (result?.document_type as DocumentType) || 'other';
  const validTypes: DocumentType[] = ['contract', 'pleading', 'case_study', 'correspondence', 'regulation', 'autopsy_report', 'deposition', 'court_order', 'memo', 'evidence_exhibit', 'other'];
  const validated = validTypes.includes(docType) ? docType : 'other';

  console.log(`📄 Document classified as: ${validated} (${result?.reasoning || 'no reasoning'})`);
  return { documentType: validated, tokens, promptTokens, completionTokens };
}

// ============================================================================
// MAIN EXTRACTION PIPELINE
// ============================================================================

/**
 * Run the full extraction pipeline for a document
 */
export async function extractLegalIntelligence(
  job: ExtractionJob,
  onProgress?: (progress: number, message: string) => void
): Promise<ExtractionResult> {
  const startTime = Date.now();
  const { file_id, tenant_id, case_id, filename } = job;
  let totalTokens = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  console.log(`\n🧠 Starting legal extraction for: ${filename}`);

  try {
    // 1. Create extraction job record
    const { data: extractionJob } = await supabaseAdmin
      .from('extraction_jobs')
      .insert({
        tenant_id,
        case_id,
        file_id,
        status: 'processing',
        model_used: EXTRACTION_MODEL,
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    const jobId = extractionJob?.id;

    // 2. Fetch document chunks
    onProgress?.(5, 'Fetching document chunks...');
    const { data: chunks, error: chunksError } = await supabaseAdmin
      .from('document_chunks')
      .select('content, metadata')
      .eq('file_id', file_id)
      .eq('tenant_id', tenant_id)
      .order('metadata->chunk_index', { ascending: true });

    if (chunksError || !chunks || chunks.length === 0) {
      throw new Error(`No chunks found for file ${file_id}: ${chunksError?.message || 'empty'}`);
    }

    console.log(`📦 Found ${chunks.length} chunks to analyze`);

    // 3. Combine chunks into analysis windows
    const analysisWindows = buildAnalysisWindows(chunks.map(c => c.content));
    console.log(`📐 Created ${analysisWindows.length} analysis windows`);

    // 3b. Classify document type (cheap, fast call on first window)
    onProgress?.(8, 'Classifying document type...');
    const classification = await classifyDocumentType(analysisWindows[0] || '', filename);
    const documentType = classification.documentType;
    totalTokens += classification.tokens;
    totalPromptTokens += classification.promptTokens;
    totalCompletionTokens += classification.completionTokens;

    // Store document type on extraction job
    if (extractionJob?.id) {
      await supabaseAdmin
        .from('extraction_jobs')
        .update({
          document_type: documentType,
          metadata: { document_type: documentType },
        })
        .eq('id', extractionJob.id);
    }

    // 4. Delete existing extractions for this file (reprocessing support)
    onProgress?.(10, 'Clearing previous extractions...');
    await clearExistingExtractions(file_id, tenant_id, case_id);

    // 5. Stage A: Extract entity CANDIDATES (fast model — gpt-4.1-mini)
    onProgress?.(15, 'Stage A: Extracting entity candidates...');
    const entityCandidates = await extractEntities(analysisWindows, filename, documentType);
    totalTokens += entityCandidates.tokens;
    totalPromptTokens += entityCandidates.promptTokens;
    totalCompletionTokens += entityCandidates.completionTokens;
    console.log(`[Stage A] Extracted ${entityCandidates.items.length} entity candidates`);

    // 5b. Stage B: Supervisory validation — promote or reject candidates
    onProgress?.(22, 'Stage B: Supervisory validation...');
    const documentContext = analysisWindows.slice(0, 2).join('\n\n').substring(0, 3000);
    let supervisoryResult: SupervisoryResult;
    try {
      supervisoryResult = await runSupervisoryPipeline(
        entityCandidates.items as CandidateEntity[],
        tenant_id,
        case_id,
        analysisWindows.length,
        documentContext,
      );
      totalTokens += supervisoryResult.tokens_used;
      console.log(`[Stage B] Supervisor: ${supervisoryResult.supervisor_promoted}/${supervisoryResult.total_candidates} promoted, ${supervisoryResult.pre_filter_rejected} pre-filtered, ${supervisoryResult.supervisor_rejected} supervisor-rejected${supervisoryResult.refinement_triggered ? `, refinement: ${supervisoryResult.refinement_corrections} corrections` : ''}`);
    } catch (supervisorErr) {
      // Supervisor failed — fall back to raw entities (degraded mode)
      console.error('[Stage B] Supervisor failed (non-fatal), using raw candidates:', supervisorErr);
      supervisoryResult = {
        promoted: entityCandidates.items.map(e => ({
          ...e,
          promoted: true as const,
          validated_type: e.entity_type as EntityType,
          validated_name: e.entity_value,
          supervisor_confidence: e.confidence * 0.7,
          promotion_reason: 'Supervisor unavailable — degraded mode',
        })),
        rejected: [],
        total_candidates: entityCandidates.items.length,
        pre_filter_rejected: 0,
        supervisor_rejected: 0,
        supervisor_promoted: entityCandidates.items.length,
        refinement_triggered: false,
        refinement_corrections: 0,
        tokens_used: 0,
        processing_time_ms: 0,
      };
    }

    // Convert promoted entities back to ExtractedEntity format for saving
    const promotedEntities: ExtractedEntity[] = supervisoryResult.promoted.map(p => ({
      entity_type: p.validated_type as ExtractedEntity['entity_type'],
      entity_value: p.entity_value,
      normalized_value: p.validated_name,
      context_snippet: p.context_snippet,
      confidence: p.supervisor_confidence,
    }));

    // 6. Extract clauses
    onProgress?.(30, 'Classifying clauses...');
    const clauses = await extractClauses(analysisWindows, filename);
    totalTokens += clauses.tokens;
    totalPromptTokens += clauses.promptTokens;
    totalCompletionTokens += clauses.completionTokens;
    console.log(`📋 Classified ${clauses.items.length} clauses`);

    // 7. Extract obligations
    onProgress?.(50, 'Extracting obligations...');
    const obligations = await extractObligations(analysisWindows, filename);
    totalTokens += obligations.tokens;
    totalPromptTokens += obligations.promptTokens;
    totalCompletionTokens += obligations.completionTokens;
    console.log(`⚖️ Found ${obligations.items.length} obligations`);

    // 8. Extract dates
    onProgress?.(65, 'Extracting dates...');
    const dates = await extractDates(analysisWindows, filename);
    totalTokens += dates.tokens;
    totalPromptTokens += dates.promptTokens;
    totalCompletionTokens += dates.completionTokens;
    console.log(`📅 Found ${dates.items.length} dates`);

    // 9. Assess risks (based on extracted clauses + document text)
    onProgress?.(80, 'Assessing risks...');
    const risks = await assessRisks(clauses.items, analysisWindows, filename);
    totalTokens += risks.tokens;
    totalPromptTokens += risks.promptTokens;
    totalCompletionTokens += risks.completionTokens;
    console.log(`⚠️ Identified ${risks.items.length} risks`);

    // 10. Save PROMOTED entities only (supervisor-validated)
    onProgress?.(85, 'Saving validated extraction results...');
    await saveExtractionResults({
      tenant_id,
      case_id,
      file_id,
      entities: promotedEntities,
      clauses: clauses.items,
      obligations: obligations.items,
      dates: dates.items,
      risks: risks.items,
    });

    // 10b. Run entity canonicalization on promoted entities (deduplicate + link)
    onProgress?.(92, 'Canonicalizing entities...');
    let canonResult;
    try {
      canonResult = await runCanonicalizationPipeline(case_id, tenant_id, file_id);
      totalTokens += canonResult.tokens_used;
      console.log(`[CANON] ${canonResult.canonical_entities_created} canonical entities, ${canonResult.raw_entities_linked} linked, ${canonResult.entities_rejected} noise filtered`);
    } catch (canonErr) {
      console.error('Canonicalization failed (non-fatal):', canonErr);
      canonResult = { canonical_entities_created: 0, raw_entities_linked: 0, entities_rejected: 0 };
    }

    // 10c. Run smart comparison pipeline (Phase 1-3: dedup, merge, relevance)
    onProgress?.(95, 'Running smart comparison...');
    let comparisonResult: ComparisonResult | null = null;
    try {
      comparisonResult = await runSmartComparison(case_id, tenant_id, file_id, filename);
      totalTokens += comparisonResult.tokens_used;
      console.log(`[SMART-CMP] Deduped ${comparisonResult.clauses.duplicates_found} clauses, ${comparisonResult.obligations.duplicates_found} obligations, ${comparisonResult.dates.duplicates_found} dates, ${comparisonResult.risks.duplicates_found} risks | Relevance: ${comparisonResult.relevance.high_relevance}H/${comparisonResult.relevance.medium_relevance}M/${comparisonResult.relevance.low_relevance}L`);
    } catch (cmpErr) {
      console.error('Smart comparison failed (non-fatal):', cmpErr);
    }

    // 11. Update extraction job status
    if (jobId) {
      await supabaseAdmin
        .from('extraction_jobs')
        .update({
          status: 'completed',
          tokens_used: totalTokens,
          results: {
            entity_candidates: supervisoryResult.total_candidates,
            entities_promoted: promotedEntities.length,
            entities_pre_filter_rejected: supervisoryResult.pre_filter_rejected,
            entities_supervisor_rejected: supervisoryResult.supervisor_rejected,
            refinement_triggered: supervisoryResult.refinement_triggered,
            refinement_corrections: supervisoryResult.refinement_corrections,
            entities_count: promotedEntities.length,
            clauses_count: clauses.items.length,
            obligations_count: obligations.items.length,
            dates_count: dates.items.length,
            risks_count: risks.items.length,
            canonical_entities: canonResult?.canonical_entities_created || 0,
            entities_linked: canonResult?.raw_entities_linked || 0,
            entities_rejected: canonResult?.entities_rejected || 0,
            smart_comparison: comparisonResult ? {
              clauses_deduped: comparisonResult.clauses.duplicates_found,
              obligations_merged: comparisonResult.obligations.duplicates_found,
              dates_deduped: comparisonResult.dates.duplicates_found,
              risks_deduped: comparisonResult.risks.duplicates_found,
              relevance_high: comparisonResult.relevance.high_relevance,
              relevance_medium: comparisonResult.relevance.medium_relevance,
              relevance_low: comparisonResult.relevance.low_relevance,
              comparison_tokens: comparisonResult.tokens_used,
              comparison_time_ms: comparisonResult.processing_time_ms,
            } : null,
          },
          completed_at: new Date().toISOString(),
        })
        .eq('id', jobId);
    }

    // 12. Log to audit
    await supabaseAdmin.from('audit_logs').insert({
      tenant_id,
      action: 'extraction',
      resource_type: 'document',
      resource_id: file_id,
      model: EXTRACTION_MODEL,
      tokens_in: totalPromptTokens,
      tokens_out: totalCompletionTokens,
      duration_ms: Date.now() - startTime,
      details: {
        filename,
        case_id,
        entity_candidates: supervisoryResult.total_candidates,
        entities_promoted: promotedEntities.length,
        entities_rejected: supervisoryResult.pre_filter_rejected + supervisoryResult.supervisor_rejected,
        clauses: clauses.items.length,
        obligations: obligations.items.length,
        dates: dates.items.length,
        risks: risks.items.length,
      },
    });

    onProgress?.(100, 'Extraction complete!');

    const result: ExtractionResult = {
      success: true,
      file_id,
      entities_count: promotedEntities.length,
      clauses_count: clauses.items.length,
      obligations_count: obligations.items.length,
      dates_count: dates.items.length,
      risks_count: risks.items.length,
      cross_refs_count: 0,
      tokens_used: totalTokens,
      processing_time_ms: Date.now() - startTime,
      supervisory: {
        total_candidates: supervisoryResult.total_candidates,
        promoted: supervisoryResult.supervisor_promoted,
        pre_filter_rejected: supervisoryResult.pre_filter_rejected,
        supervisor_rejected: supervisoryResult.supervisor_rejected,
        refinement_triggered: supervisoryResult.refinement_triggered,
        refinement_corrections: supervisoryResult.refinement_corrections,
        quality_score: supervisoryResult.promoted.length > 0
          ? Math.round(supervisoryResult.promoted.reduce((s, e) => s + e.supervisor_confidence, 0) / supervisoryResult.promoted.length * 100) / 100
          : 0,
      },
    };

    console.log(`✅ Legal extraction complete in ${result.processing_time_ms}ms (${totalTokens} tokens)`);

    // Track token usage for cost monitoring
    trackTokenUsage({
      tenant_id,
      operation: 'extraction',
      model: EXTRACTION_MODEL,
      prompt_tokens: totalPromptTokens,
      completion_tokens: totalCompletionTokens,
      case_id,
      file_id,
      metadata: {
        filename,
        entity_candidates: supervisoryResult.total_candidates,
        entities_promoted: promotedEntities.length,
        clauses: clauses.items.length,
        obligations: obligations.items.length,
        dates: dates.items.length,
        risks: risks.items.length,
      },
    });

    return result;

  } catch (error) {
    console.error(`❌ Legal extraction failed for ${filename}:`, error);

    // Update job status to failed
    await supabaseAdmin
      .from('extraction_jobs')
      .update({
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        completed_at: new Date().toISOString(),
      })
      .eq('file_id', file_id)
      .eq('status', 'processing');

    return {
      success: false,
      file_id,
      entities_count: 0,
      clauses_count: 0,
      obligations_count: 0,
      dates_count: 0,
      risks_count: 0,
      cross_refs_count: 0,
      tokens_used: totalTokens,
      processing_time_ms: Date.now() - startTime,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================================================
// ANALYSIS WINDOW BUILDER
// ============================================================================

/**
 * Combine chunks into analysis windows that fit within model context limits.
 * Each window is a concatenation of consecutive chunks.
 */
function buildAnalysisWindows(chunkTexts: string[]): string[] {
  const windows: string[] = [];
  let currentWindow = '';

  for (const text of chunkTexts) {
    if (currentWindow.length + text.length > MAX_CHUNK_CHARS_PER_CALL) {
      if (currentWindow) {
        windows.push(currentWindow);
      }
      currentWindow = text;
    } else {
      currentWindow += '\n\n' + text;
    }
  }

  if (currentWindow) {
    windows.push(currentWindow);
  }

  return windows;
}

// ============================================================================
// ENTITY EXTRACTION
// ============================================================================

async function extractEntities(
  windows: string[],
  filename: string,
  documentType: DocumentType = 'other',
): Promise<{ items: ExtractedEntity[]; tokens: number; promptTokens: number; completionTokens: number }> {
  const allEntities: ExtractedEntity[] = [];
  let totalTokens = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  const docTypeInstructions = DOCUMENT_TYPE_ENTITY_INSTRUCTIONS[documentType];

  for (const window of windows) {
    const { result, tokens, promptTokens, completionTokens } = await callOpenAI<{ entities: ExtractedEntity[] }>({
      systemPrompt: `You are a legal document entity extractor (Stage A — candidate extraction).
Extract all NAMED entities from the document text. These are CANDIDATES that will be validated by a supervisor.
For each entity, identify:
- entity_type: one of [party, court, statute, defined_term, judge, jurisdiction, regulatory_body, witness, law_firm, government_agency, law_enforcement, contract, evidence, location, vehicle, publication]
- entity_value: the exact name/reference as it appears in the text
- normalized_value: canonical/standard form (e.g., "Supreme Court of Pakistan" for "Hon'ble SC")
- context_snippet: a brief excerpt (max 100 chars) showing where the entity appears
- confidence: 0.0 to 1.0

${docTypeInstructions}

EXTRACTION RULES:
- Extract NAMED entities only — proper names, specific statutes, named courts, etc.
- Include defined terms (terms in quotes or caps in contracts).
- Do NOT extract body parts, generic nouns, emotional phrases, or sentence fragments.
- Do NOT extract boilerplate legal words like "herein", "whereas", "the parties", "this agreement".
- Do NOT fabricate entities. Only extract what appears in the text.
- When in doubt about whether something is a real entity, include it with lower confidence. The supervisor will decide.
- AIM FOR PRECISION over recall. A clean set of 15-30 high-quality entities is better than 100+ noisy ones.`,
      userPrompt: `Extract all entities from this document section (file: ${filename}):\n\n${window}`,
      responseSchema: {
        type: 'object',
        properties: {
          entities: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                entity_type: { type: 'string', enum: ['party', 'court', 'statute', 'defined_term', 'judge', 'jurisdiction', 'regulatory_body', 'witness', 'law_firm', 'government_agency', 'law_enforcement', 'contract', 'evidence', 'location', 'vehicle', 'publication'] },
                entity_value: { type: 'string' },
                normalized_value: { type: 'string' },
                context_snippet: { type: 'string' },
                confidence: { type: 'number' },
              },
              required: ['entity_type', 'entity_value', 'confidence'],
            },
          },
        },
        required: ['entities'],
      },
    });

    if (result?.entities) {
      allEntities.push(...result.entities);
    }
    totalTokens += tokens;
    totalPromptTokens += promptTokens;
    totalCompletionTokens += completionTokens;
  }

  // Deduplicate by normalized_value + entity_type, keeping highest confidence
  const deduped = deduplicateEntities(allEntities);
  return { items: deduped, tokens: totalTokens, promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens };
}

function deduplicateEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
  const map = new Map<string, ExtractedEntity>();
  for (const entity of entities) {
    const key = `${entity.entity_type}:${(entity.normalized_value || entity.entity_value).toLowerCase()}`;
    const existing = map.get(key);
    if (!existing || entity.confidence > existing.confidence) {
      map.set(key, entity);
    }
  }
  return Array.from(map.values());
}

// ============================================================================
// CLAUSE CLASSIFICATION
// ============================================================================

async function extractClauses(
  windows: string[],
  filename: string
): Promise<{ items: ExtractedClause[]; tokens: number; promptTokens: number; completionTokens: number }> {
  const allClauses: ExtractedClause[] = [];
  let totalTokens = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  for (const window of windows) {
    const { result, tokens, promptTokens, completionTokens } = await callOpenAI<{ clauses: ExtractedClause[] }>({
      systemPrompt: `You are a legal clause classifier. Analyze the document text and identify distinct legal clauses.
For each clause, provide:
- clause_type: one of [indemnity, limitation_of_liability, termination, governing_law, confidentiality, non_compete, force_majeure, assignment, warranty, dispute_resolution, payment, insurance, intellectual_property, representations, notice, amendment, severability, entire_agreement, waiver, other]
- clause_text: the full text of the clause (preserve original wording)
- section_ref: section number/reference if visible (e.g., "Section 4.2", "Article III")
- summary: one-line plain English summary of what the clause does
- risk_level: low/medium/high/critical — based on how favorable/unfavorable the clause is
- risk_reason: why this risk level was assigned (one sentence)
- confidence: 0.0 to 1.0

Focus on substantive clauses. Skip boilerplate headers/footers.
If a clause is one-sided, assigns unlimited liability, or has unusual terms, mark it appropriately.`,
      userPrompt: `Classify all clauses in this document section (file: ${filename}):\n\n${window}`,
      responseSchema: {
        type: 'object',
        properties: {
          clauses: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                clause_type: { type: 'string', enum: ['indemnity', 'limitation_of_liability', 'termination', 'governing_law', 'confidentiality', 'non_compete', 'force_majeure', 'assignment', 'warranty', 'dispute_resolution', 'payment', 'insurance', 'intellectual_property', 'representations', 'notice', 'amendment', 'severability', 'entire_agreement', 'waiver', 'other'] },
                clause_text: { type: 'string' },
                section_ref: { type: 'string' },
                summary: { type: 'string' },
                risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
                risk_reason: { type: 'string' },
                confidence: { type: 'number' },
              },
              required: ['clause_type', 'clause_text', 'summary', 'risk_level', 'confidence'],
            },
          },
        },
        required: ['clauses'],
      },
    });

    if (result?.clauses) {
      allClauses.push(...result.clauses);
    }
    totalTokens += tokens;
    totalPromptTokens += promptTokens;
    totalCompletionTokens += completionTokens;
  }

  return { items: allClauses, tokens: totalTokens, promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens };
}

// ============================================================================
// OBLIGATION EXTRACTION
// ============================================================================

async function extractObligations(
  windows: string[],
  filename: string
): Promise<{ items: ExtractedObligation[]; tokens: number; promptTokens: number; completionTokens: number }> {
  const allObligations: ExtractedObligation[] = [];
  let totalTokens = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  for (const window of windows) {
    const { result, tokens, promptTokens, completionTokens } = await callOpenAI<{ obligations: ExtractedObligation[] }>({
      systemPrompt: `You are a legal obligation extractor. Identify all obligations from the document text.
An obligation is any duty, requirement, or commitment that one party owes to another.
For each obligation:
- obligor: who owes the obligation (party name)
- obligee: who is owed (party name)
- obligation_text: the full text describing the obligation
- obligation_type: one of [payment, delivery, performance, notice, reporting, compliance, indemnification, insurance, confidentiality, other]
- due_date: specific date if mentioned (ISO 8601 format YYYY-MM-DD), null if none
- recurring: true if it's a recurring obligation
- recurrence_rule: description of recurrence pattern if recurring
- condition: any condition that triggers the obligation
- confidence: 0.0 to 1.0

Extract ALL obligations. Include implicit obligations (e.g., "shall maintain insurance" implies ongoing compliance).`,
      userPrompt: `Extract all obligations from this document section (file: ${filename}):\n\n${window}`,
      responseSchema: {
        type: 'object',
        properties: {
          obligations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                obligor: { type: 'string' },
                obligee: { type: 'string' },
                obligation_text: { type: 'string' },
                obligation_type: { type: 'string', enum: ['payment', 'delivery', 'performance', 'notice', 'reporting', 'compliance', 'indemnification', 'insurance', 'confidentiality', 'other'] },
                due_date: { type: 'string' },
                recurring: { type: 'boolean' },
                recurrence_rule: { type: 'string' },
                condition: { type: 'string' },
                confidence: { type: 'number' },
              },
              required: ['obligor', 'obligee', 'obligation_text', 'obligation_type', 'recurring', 'confidence'],
            },
          },
        },
        required: ['obligations'],
      },
    });

    if (result?.obligations) {
      allObligations.push(...result.obligations);
    }
    totalTokens += tokens;
    totalPromptTokens += promptTokens;
    totalCompletionTokens += completionTokens;
  }

  return { items: allObligations, tokens: totalTokens, promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens };
}

// ============================================================================
// DATE EXTRACTION
// ============================================================================

async function extractDates(
  windows: string[],
  filename: string
): Promise<{ items: ExtractedDate[]; tokens: number; promptTokens: number; completionTokens: number }> {
  const allDates: ExtractedDate[] = [];
  let totalTokens = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  for (const window of windows) {
    const { result, tokens, promptTokens, completionTokens } = await callOpenAI<{ dates: ExtractedDate[] }>({
      systemPrompt: `You are a legal date extractor. Identify all significant dates and deadlines from the document text.
For each date:
- date_type: one of [effective, termination, renewal, deadline, notice_period, payment_due, filing, hearing, expiry, commencement, review, milestone]
- date_value: the date in ISO 8601 format (YYYY-MM-DD). If only month/year known, use first of month.
- description: what this date represents in plain English
- is_recurring: true if it's a recurring date
- recurrence_rule: pattern description if recurring
- source_text: the original text mentioning this date (max 200 chars)
- confidence: 0.0 to 1.0

Extract ALL dates. Include relative dates computed from context (e.g., "30 days after signing" — compute from effective date if known).
Only extract dates that are meaningful for legal tracking. Skip casual mentions.`,
      userPrompt: `Extract all significant dates from this document section (file: ${filename}):\n\n${window}`,
      responseSchema: {
        type: 'object',
        properties: {
          dates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                date_type: { type: 'string', enum: ['effective', 'termination', 'renewal', 'deadline', 'notice_period', 'payment_due', 'filing', 'hearing', 'expiry', 'commencement', 'review', 'milestone'] },
                date_value: { type: 'string' },
                description: { type: 'string' },
                is_recurring: { type: 'boolean' },
                recurrence_rule: { type: 'string' },
                source_text: { type: 'string' },
                confidence: { type: 'number' },
              },
              required: ['date_type', 'date_value', 'description', 'is_recurring', 'confidence'],
            },
          },
        },
        required: ['dates'],
      },
    });

    if (result?.dates) {
      allDates.push(...result.dates);
    }
    totalTokens += tokens;
    totalPromptTokens += promptTokens;
    totalCompletionTokens += completionTokens;
  }

  // Deduplicate dates by type + value
  const deduped = deduplicateDates(allDates);
  return { items: deduped, tokens: totalTokens, promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens };
}

function deduplicateDates(dates: ExtractedDate[]): ExtractedDate[] {
  const map = new Map<string, ExtractedDate>();
  for (const d of dates) {
    const key = `${d.date_type}:${d.date_value}`;
    const existing = map.get(key);
    if (!existing || d.confidence > existing.confidence) {
      map.set(key, d);
    }
  }
  return Array.from(map.values());
}

// ============================================================================
// RISK ASSESSMENT
// ============================================================================

const riskResponseSchema = {
  type: 'object',
  properties: {
    risks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          risk_type: { type: 'string' },
          risk_description: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          recommendation: { type: 'string' },
          related_clause_index: { type: 'number' },
          confidence: { type: 'number' },
        },
        required: ['risk_type', 'risk_description', 'severity', 'confidence'],
      },
    },
  },
  required: ['risks'],
};

async function assessRisks(
  clauses: ExtractedClause[],
  analysisWindows: string[],
  filename: string
): Promise<{ items: ExtractedRisk[]; tokens: number; promptTokens: number; completionTokens: number }> {
  // If we have clauses, analyze them for risks
  if (clauses.length > 0) {
    const clauseSummary = clauses.map((c, i) =>
      `[${i}] ${c.clause_type} (${c.section_ref || 'no ref'}): ${c.summary} [Risk: ${c.risk_level}]`
    ).join('\n');

    const { result, tokens, promptTokens, completionTokens } = await callOpenAI<{ risks: ExtractedRisk[] }>({
      systemPrompt: `You are a legal risk assessor. Analyze the extracted clauses and identify specific risks.
Look for:
- Missing standard clauses (indemnity, limitation of liability, termination, etc.)
- One-sided indemnities (only one party indemnifies)
- Unlimited liability exposure
- Auto-renewal traps (no easy termination)
- Undefined or ambiguous terms
- Missing governing law or dispute resolution
- Overly broad non-compete or confidentiality
- Missing insurance requirements
- Weak warranty provisions

For each risk:
- risk_type: short identifier (e.g., "unlimited_liability", "missing_termination_clause", "one_sided_indemnity")
- risk_description: detailed explanation of the risk
- severity: low/medium/high/critical
- recommendation: suggested action to mitigate
- related_clause_index: index of the related clause from the input (null if risk is about a MISSING clause)
- confidence: 0.0 to 1.0

Be thorough. Consider both explicit risks in clauses and risks from MISSING protections.`,
      userPrompt: `Assess risks in these extracted clauses from "${filename}":\n\n${clauseSummary}`,
      responseSchema: riskResponseSchema,
    });

    return { items: result?.risks || [], tokens, promptTokens, completionTokens };
  }

  // No clauses — analyze document text directly for risks (case studies, litigation, etc.)
  const allRisks: ExtractedRisk[] = [];
  let totalTokens = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  // Use first few windows to limit cost
  const windowsToAnalyze = analysisWindows.slice(0, 3);

  for (const window of windowsToAnalyze) {
    const { result, tokens, promptTokens, completionTokens } = await callOpenAI<{ risks: ExtractedRisk[] }>({
      systemPrompt: `You are a legal risk assessor. Analyze the document text and identify legal risks, procedural issues, and potential vulnerabilities.
Look for:
- Procedural violations or irregularities
- Evidence handling issues
- Constitutional or rights violations
- Conflict of interest indicators
- Bias or prejudice indicators
- Jurisdictional issues
- Statute of limitations concerns
- Witness credibility issues
- Chain of custody problems
- Due process concerns
- Missing or incomplete documentation

For each risk:
- risk_type: short identifier (e.g., "evidence_handling", "procedural_violation", "constitutional_issue")
- risk_description: detailed explanation of the risk
- severity: low/medium/high/critical
- recommendation: suggested action to mitigate
- confidence: 0.0 to 1.0

Only identify genuine risks. Do not fabricate issues not supported by the text.`,
      userPrompt: `Identify legal risks in this document section from "${filename}":\n\n${window}`,
      responseSchema: riskResponseSchema,
    });

    if (result?.risks) {
      allRisks.push(...result.risks);
    }
    totalTokens += tokens;
    totalPromptTokens += promptTokens;
    totalCompletionTokens += completionTokens;
  }

  return { items: allRisks, tokens: totalTokens, promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens };
}

// ============================================================================
// OPENAI STRUCTURED OUTPUT CALL (with retry + exponential backoff)
// ============================================================================

interface OpenAICallParams {
  systemPrompt: string;
  userPrompt: string;
  responseSchema: Record<string, unknown>;
  model?: string;
  temperature?: number;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

async function callOpenAI<T>(params: OpenAICallParams): Promise<{ result: T | null; tokens: number; promptTokens: number; completionTokens: number }> {
  const {
    systemPrompt,
    userPrompt,
    responseSchema,
    model = EXTRACTION_MODEL,
    temperature = EXTRACTION_TEMPERATURE,
  } = params;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.openai.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature,
          messages: [
            { role: 'system', content: systemPrompt + '\n\nRespond with valid JSON only.' },
            { role: 'user', content: userPrompt },
          ],
          response_format: {
            type: 'json_object',
          },
        }),
      });

      // Retry on rate limit (429) or server errors (5xx)
      if (response.status === 429 || response.status >= 500) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[OpenAI] ${response.status} on attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying in ${delay}ms...`);
        if (attempt < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`OpenAI API error (${response.status}):`, errorText);
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
      return { result: parsed, tokens: tokensUsed, promptTokens, completionTokens };

    } catch (error) {
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[OpenAI] Network error on attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying in ${delay}ms...`, error);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      console.error('OpenAI call failed after all retries:', error);
      return { result: null, tokens: 0, promptTokens: 0, completionTokens: 0 };
    }
  }

  return { result: null, tokens: 0, promptTokens: 0, completionTokens: 0 };
}

// ============================================================================
// DATABASE OPERATIONS
// ============================================================================

/**
 * Clear all existing extractions for a file in a specific case (for reprocessing).
 * Only deletes intelligence records for the given case_id, allowing the same file
 * to have intelligence in multiple matters.
 * Also cleans up canonical_entities that were derived from this file's entities.
 */
async function clearExistingExtractions(fileId: string, tenantId: string, caseId?: string): Promise<void> {
  // First, get entity IDs for this file+case so we can unlink canonical entities
  if (caseId) {
    const { data: fileEntities } = await supabaseAdmin
      .from('matter_entities')
      .select('canonical_entity_id')
      .eq('file_id', fileId)
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId)
      .not('canonical_entity_id', 'is', null);

    if (fileEntities && fileEntities.length > 0) {
      const canonicalIds = [...new Set(fileEntities.map(e => e.canonical_entity_id).filter(Boolean))];

      // For each canonical entity, check if it has other file references in THIS case
      // If not, delete it; if yes, just decrement mention count
      for (const cId of canonicalIds) {
        const { count } = await supabaseAdmin
          .from('matter_entities')
          .select('id', { count: 'exact', head: true })
          .eq('canonical_entity_id', cId)
          .eq('case_id', caseId)
          .neq('file_id', fileId);

        if (count === 0) {
          // No other files in THIS case reference this canonical entity — delete it
          await supabaseAdmin.from('canonical_entities').delete().eq('id', cId);
        }
      }
    }
  }

  const tables = [
    'matter_entities',
    'matter_clauses',
    'matter_obligations',
    'matter_dates',
    'matter_risks',
    'matter_cross_references',
  ];

  // Delete only for THIS specific file+case combination
  // This allows the same file to have intelligence in multiple matters
  for (const table of tables) {
    const query = supabaseAdmin
      .from(table)
      .delete()
      .eq('file_id', fileId)
      .eq('tenant_id', tenantId);
    
    // If case_id is provided, only delete for that specific case
    if (caseId) {
      query.eq('case_id', caseId);
    }
    
    await query;
  }
}

/**
 * Save all extraction results to database in batches
 */
async function saveExtractionResults(params: {
  tenant_id: string;
  case_id: string;
  file_id: string;
  entities: ExtractedEntity[];
  clauses: ExtractedClause[];
  obligations: ExtractedObligation[];
  dates: ExtractedDate[];
  risks: ExtractedRisk[];
}): Promise<void> {
  const { tenant_id, case_id, file_id, entities, clauses, obligations, dates, risks } = params;
  const BATCH_SIZE = 50;

  // Sanitize all LLM-generated content to prevent stored XSS
  const safeEntities = entities.map(e => sanitizeObject(e));
  const safeClauses = clauses.map(c => sanitizeObject(c));
  const safeObligations = obligations.map(o => sanitizeObject(o));
  const safeDates = dates.map(d => sanitizeObject(d));
  const safeRisks = risks.map(r => sanitizeObject(r));

  // Save entities
  if (safeEntities.length > 0) {
    const entityRecords = safeEntities.map(e => ({
      tenant_id,
      case_id,
      file_id,
      entity_type: e.entity_type,
      entity_value: e.entity_value,
      normalized_value: e.normalized_value || null,
      context_snippet: e.context_snippet || null,
      confidence: e.confidence,
    }));

    for (let i = 0; i < entityRecords.length; i += BATCH_SIZE) {
      const batch = entityRecords.slice(i, i + BATCH_SIZE);
      const { error } = await supabaseAdmin.from('matter_entities').insert(batch);
      if (error) console.error('Error saving entities batch:', error.message);
    }
  }

  // Save clauses and collect IDs for risk linking
  const clauseIds: string[] = [];
  if (safeClauses.length > 0) {
    const clauseRecords = safeClauses.map(c => ({
      tenant_id,
      case_id,
      file_id,
      clause_type: c.clause_type,
      clause_text: c.clause_text,
      section_ref: c.section_ref || null,
      summary: c.summary,
      confidence: c.confidence,
      risk_level: c.risk_level,
      risk_reason: c.risk_reason || null,
    }));

    for (let i = 0; i < clauseRecords.length; i += BATCH_SIZE) {
      const batch = clauseRecords.slice(i, i + BATCH_SIZE);
      const { data, error } = await supabaseAdmin
        .from('matter_clauses')
        .insert(batch)
        .select('id');
      if (error) {
        console.error('Error saving clauses batch:', error.message);
      } else if (data) {
        clauseIds.push(...data.map(d => d.id));
      }
    }
  }

  // Save obligations
  if (safeObligations.length > 0) {
    const oblRecords = safeObligations.map(o => ({
      tenant_id,
      case_id,
      file_id,
      obligor: o.obligor,
      obligee: o.obligee,
      obligation_text: o.obligation_text,
      obligation_type: o.obligation_type,
      due_date: o.due_date || null,
      recurring: o.recurring,
      recurrence_rule: o.recurrence_rule || null,
      condition: o.condition || null,
      status: 'pending' as const,
      confidence: o.confidence,
    }));

    for (let i = 0; i < oblRecords.length; i += BATCH_SIZE) {
      const batch = oblRecords.slice(i, i + BATCH_SIZE);
      const { error } = await supabaseAdmin.from('matter_obligations').insert(batch);
      if (error) console.error('Error saving obligations batch:', error.message);
    }
  }

  // Save dates
  const VALID_DATE_TYPES = new Set(['effective', 'termination', 'renewal', 'deadline', 'notice_period', 'payment_due', 'filing', 'hearing', 'expiry', 'commencement', 'review', 'milestone']);
  if (safeDates.length > 0) {
    const dateRecords = safeDates.map(d => ({
      tenant_id,
      case_id,
      file_id,
      date_type: VALID_DATE_TYPES.has(d.date_type) ? d.date_type : 'milestone',
      date_value: d.date_value,
      description: d.description,
      is_recurring: d.is_recurring,
      recurrence_rule: d.recurrence_rule || null,
      source_text: d.source_text || null,
      confidence: d.confidence,
    }));

    for (let i = 0; i < dateRecords.length; i += BATCH_SIZE) {
      const batch = dateRecords.slice(i, i + BATCH_SIZE);
      const { error } = await supabaseAdmin.from('matter_dates').insert(batch);
      if (error) console.error('Error saving dates batch:', error.message);
    }
  }

  // Save risks (with clause linking)
  if (safeRisks.length > 0) {
    const riskRecords = safeRisks.map(r => ({
      tenant_id,
      case_id,
      file_id,
      clause_id: (r.related_clause_index != null && clauseIds[r.related_clause_index])
        ? clauseIds[r.related_clause_index]
        : null,
      risk_type: r.risk_type,
      risk_description: r.risk_description,
      severity: r.severity,
      recommendation: r.recommendation || null,
      confidence: r.confidence,
    }));

    for (let i = 0; i < riskRecords.length; i += BATCH_SIZE) {
      const batch = riskRecords.slice(i, i + BATCH_SIZE);
      const { error } = await supabaseAdmin.from('matter_risks').insert(batch);
      if (error) console.error('Error saving risks batch:', error.message);
    }
  }
}
