/**
 * Supervisory Validation Service
 * 
 * Enterprise-grade two-stage extraction validation pipeline.
 * 
 * Architecture:
 *   Stage A (GPT-4.1-mini) → produces "candidates" (extractionService)
 *   Stage B (GPT-4.1)      → THIS service validates, promotes, rejects
 * 
 * Pipeline:
 *   1. filterCandidates()       — Rule-based pre-filter (auto-reject body parts, noise)
 *   2. validateAndPromote()     — Reasoning model validates, applies promotion rules
 *   3. assessExtractionQuality()— Quality gate: detect over-extraction, pollution
 *   4. runRefinementPass()      — Correction pass for low-quality batches
 * 
 * Promotion Rules:
 *   - Entity MUST be legally significant (named party, court, statute, etc.)
 *   - Entity SHOULD participate in a relationship (obligor/obligee, party to clause)
 *   - Multi-referenced entities get higher promotion confidence
 *   - Generic nouns, body parts, emotional phrases → auto-reject
 * 
 * Entity Filtering (auto-reject):
 *   - Body parts & organs (head, arm, leg, heart, brain, etc.)
 *   - Generic building references (the building, a room, this office)
 *   - Emotional/conversational phrases (feeling, believed, seemed to)
 *   - Single common words unless they are defined terms in context
 */

import { config } from '../config/index.js';
import { supabaseAdmin } from '../config/supabase.js';
import { trackTokenUsage } from './tokenUsageService.js';
import { ENTITY_TYPES, type EntityType } from './entityCanonicalizer.js';

// ============================================================================
// TYPES
// ============================================================================

export interface CandidateEntity {
  entity_type: string;
  entity_value: string;
  normalized_value?: string;
  context_snippet?: string;
  confidence: number;
}

export interface PromotedEntity extends CandidateEntity {
  promoted: true;
  promotion_reason: string;
  validated_type: EntityType;
  validated_name: string;
  supervisor_confidence: number;
}

export interface RejectedEntity extends CandidateEntity {
  promoted: false;
  rejection_reason: string;
  rejection_category: 'noise' | 'body_part' | 'generic_noun' | 'conversational' | 'low_legal_significance' | 'duplicate' | 'misclassified_noise';
}

export type ValidatedCandidate = PromotedEntity | RejectedEntity;

export interface SupervisoryResult {
  promoted: PromotedEntity[];
  rejected: RejectedEntity[];
  total_candidates: number;
  pre_filter_rejected: number;
  supervisor_rejected: number;
  supervisor_promoted: number;
  refinement_triggered: boolean;
  refinement_corrections: number;
  tokens_used: number;
  processing_time_ms: number;
}

export interface QualityAssessment {
  quality_score: number;       // 0.0 - 1.0
  over_extraction: boolean;    // Too many entities relative to doc size
  pollution_detected: boolean; // Non-legal noise in promoted set
  taxonomy_violations: number; // Wrong type assignments
  low_confidence_ratio: number;// Fraction below 0.6 confidence
  needs_refinement: boolean;
  assessment_notes: string;
}

// ============================================================================
// AUTO-REJECT PATTERNS (Rule-Based Pre-Filter)
// ============================================================================

/** Body parts and organs — NEVER valid legal entities */
const BODY_PARTS = new Set([
  'head', 'face', 'eye', 'eyes', 'ear', 'ears', 'nose', 'mouth', 'lip', 'lips',
  'teeth', 'tooth', 'tongue', 'chin', 'jaw', 'neck', 'throat', 'shoulder', 'shoulders',
  'arm', 'arms', 'elbow', 'elbows', 'wrist', 'wrists', 'hand', 'hands', 'finger',
  'fingers', 'thumb', 'thumbs', 'nail', 'nails', 'chest', 'breast', 'breasts',
  'stomach', 'abdomen', 'back', 'spine', 'rib', 'ribs', 'hip', 'hips', 'waist',
  'leg', 'legs', 'thigh', 'thighs', 'knee', 'knees', 'shin', 'shins', 'ankle',
  'ankles', 'foot', 'feet', 'toe', 'toes', 'heel', 'heels',
  'heart', 'lung', 'lungs', 'liver', 'kidney', 'kidneys', 'brain', 'blood',
  'bone', 'bones', 'muscle', 'muscles', 'skin', 'hair', 'skull',
  'pelvis', 'groin', 'buttock', 'buttocks',
  // ── Extended anatomy terms (compound terms the simple Set missed) ──
  'torso', 'scalp', 'forehead', 'temple', 'temples', 'cheek', 'cheeks',
  'eyebrow', 'eyebrows', 'eyelid', 'eyelids', 'nostril', 'nostrils',
  'collarbone', 'clavicle', 'sternum', 'ribcage', 'diaphragm',
  'intestine', 'intestines', 'colon', 'rectum', 'bladder', 'uterus',
  'ovary', 'ovaries', 'trachea', 'esophagus', 'larynx', 'pharynx',
  'pancreas', 'spleen', 'gallbladder', 'appendix', 'aorta', 'artery',
  'arteries', 'vein', 'veins', 'tendon', 'tendons', 'ligament', 'ligaments',
  'cartilage', 'tissue', 'tissues', 'organ', 'organs', 'vertebra', 'vertebrae',
  'femur', 'tibia', 'fibula', 'humerus', 'radius', 'ulna', 'patella',
  'cranium', 'mandible', 'maxilla', 'coccyx', 'sacrum', 'scapula',
  'wound', 'wounds', 'laceration', 'lacerations', 'contusion', 'contusions',
  'bruise', 'bruises', 'abrasion', 'abrasions', 'fracture', 'fractures',
]);

/**
 * Compound anatomical / medical patterns that catch multi-word anatomy references.
 * These regex patterns match things like "left hand", "blunt force trauma", "cause of death", etc.
 */
const ANATOMY_COMPOUND_PATTERNS = [
  // Body part with side/position qualifier
  /^(left|right|upper|lower|anterior|posterior|lateral|medial|dorsal|ventral|proximal|distal)\s+(hand|arm|leg|foot|eye|ear|shoulder|knee|hip|wrist|ankle|thigh|elbow|lung|kidney|breast|temple|cheek)/i,
  // Multi-word anatomy phrases
  /^(blunt force|sharp force|gunshot|stab)\s+(trauma|injury|wound|injuries|wounds)/i,
  /^(cause|manner|mechanism)\s+(of\s+)?(death|injury)/i,
  /^(blood\s+(spatter|stain|pool|sample|droplet|smear|evidence|type|group|alcohol|loss))/i,
  /^(body\s+(temperature|cavity|weight|surface|fluid|fluids|mass|decomposition))/i,
  /^(time\s+of\s+death|rigor\s+mortis|livor\s+mortis|algor\s+mortis|lividity|decomposition)/i,
  /^(entrance\s+wound|exit\s+wound|defensive\s+wound|incised\s+wound|puncture\s+wound)/i,
  /^(brain\s+(damage|injury|hemorrhage|swelling|tissue|matter|stem))/i,
  /^(spinal\s+(cord|column|injury|damage|fluid))/i,
  /^(bone\s+(fragment|fracture|marrow|density|structure))/i,
  /^(internal\s+(organ|organs|bleeding|hemorrhage|injury|injuries|damage))/i,
  /^(external\s+(injury|injuries|wound|wounds|examination|exam))/i,
  /^(soft\s+tissue|connective\s+tissue|muscle\s+tissue|nerve\s+damage|nerve\s+tissue)/i,
  /^(chest\s+(cavity|wall|wound|x-ray|pain))/i,
  /^(head\s+(injury|wound|trauma|laceration))/i,
  /^(neck\s+(injury|wound|compression|strangulation|ligature))/i,
  /^(toxicology|autopsy|post-?mortem|ante-?mortem|peri-?mortem)/i,
  /^(asphyxia|asphyxiation|suffocation|strangulation|exsanguination|hemorrhage)/i,
];

/** Medical suffixes — any entity ending in these is likely medical, not legal */
const MEDICAL_SUFFIX_PATTERNS = [
  /-(itis|osis|emia|emia|ectomy|otomy|oscopy|plasty|pathy|algia|oma|uria|rrhea|rrhage|penia|cyte|blast)$/i,
  /\b(syndrome|disorder|disease|condition|pathology|etiology|prognosis|diagnosis)$/i,
  /\b(mg|ml|cc|mmhg|bpm|ng\/ml|mcg|iu)\b/i, // Medical units
];

/** Generic building/location references that are not named entities */
const GENERIC_BUILDING_REFS = new Set([
  'the building', 'a building', 'this building', 'the office', 'a room',
  'the room', 'this room', 'the house', 'a house', 'the property',
  'the premises', 'the facility', 'a facility', 'the site', 'the location',
  'the place', 'the area', 'the floor', 'the door', 'the window',
  'the wall', 'the roof', 'the garage', 'the parking lot', 'the hallway',
  'the corridor', 'the staircase', 'the elevator', 'the entrance',
  // ── Extended generic refs ──
  'the kitchen', 'the bathroom', 'the bedroom', 'the living room',
  'the basement', 'the attic', 'the backyard', 'the front yard',
  'the driveway', 'the porch', 'the patio', 'the deck',
  'upstairs', 'downstairs', 'the stairway', 'the foyer', 'the lobby',
  'the closet', 'the pantry', 'the laundry room', 'the utility room',
  'the courtyard', 'the parking garage', 'the loading dock',
  'the crime scene', 'the scene', 'the incident location',
]);

/** Emotional/conversational phrases — not entities */
const CONVERSATIONAL_NOISE_PATTERNS = [
  /^(he|she|they|it|we|i|you)\s+(said|stated|believed|felt|thought|claimed|alleged|testified|mentioned)/i,
  /^(the|this|that|a|an)\s+(situation|matter|issue|problem|case|thing|point|fact|circumstance|event)/i,
  /^(feeling|emotion|belief|opinion|thought|impression|perception|understanding|knowledge|awareness)/i,
  /^(seemed to|appeared to|was believed|was thought|was felt|was considered)/i,
  /^(in the matter of|with respect to|as regards|in relation to|pertaining to)$/i,
  /^(yes|no|maybe|perhaps|possibly|probably|certainly|definitely|absolutely)$/i,
  /^(the parties|the agreement|this agreement|the contract|this contract|the document)$/i,
  /^(section|article|paragraph|clause|provision|term|condition|appendix|schedule|exhibit)$/i,
  /^(herein|hereinafter|hereinbefore|thereof|therein|thereto|hereby|whereas|witnesseth)$/i,
  /^(said|such|same|foregoing|aforesaid|aforementioned|above-mentioned)$/i,
];

/** Common single words that are never standalone entities (unless defined terms) */
const COMMON_NOISE_WORDS = new Set([
  'agreement', 'contract', 'document', 'section', 'article', 'paragraph',
  'clause', 'provision', 'term', 'condition', 'party', 'parties',
  'date', 'time', 'period', 'year', 'month', 'day', 'week',
  'amount', 'sum', 'total', 'number', 'percentage', 'rate',
  'right', 'obligation', 'duty', 'liability', 'responsibility',
  'notice', 'consent', 'approval', 'payment', 'delivery',
  'person', 'individual', 'entity', 'company', 'organization',
  'court', 'judge', 'witness', 'attorney', 'lawyer', 'counsel',
  'plaintiff', 'defendant', 'appellant', 'respondent', 'petitioner',
  'evidence', 'testimony', 'statement', 'declaration', 'affidavit',
  'law', 'statute', 'regulation', 'rule', 'order', 'judgment',
]);

// ============================================================================
// STAGE B: RULE-BASED PRE-FILTER
// ============================================================================

/**
 * Fast rule-based filter that rejects obvious noise BEFORE calling the LLM.
 * Returns candidates split into passthrough (needs LLM review) and rejected.
 */
export function filterCandidates(
  candidates: CandidateEntity[]
): { passthrough: CandidateEntity[]; rejected: RejectedEntity[] } {
  const passthrough: CandidateEntity[] = [];
  const rejected: RejectedEntity[] = [];

  for (const candidate of candidates) {
    const value = candidate.entity_value.trim();
    const valueLower = value.toLowerCase();
    const normalizedLower = (candidate.normalized_value || value).toLowerCase().trim();

    // 1. Reject empty or very short values (< 2 chars)
    if (value.length < 2) {
      rejected.push({
        ...candidate,
        promoted: false,
        rejection_reason: `Too short: "${value}" (${value.length} chars)`,
        rejection_category: 'noise',
      });
      continue;
    }

    // 2. Reject body parts and organs (single-word match)
    if (BODY_PARTS.has(valueLower) || BODY_PARTS.has(normalizedLower)) {
      rejected.push({
        ...candidate,
        promoted: false,
        rejection_reason: `Body part/organ: "${value}"`,
        rejection_category: 'body_part',
      });
      continue;
    }

    // 2b. Reject compound anatomical / medical phrases
    let isAnatomyCompound = false;
    for (const pattern of ANATOMY_COMPOUND_PATTERNS) {
      if (pattern.test(valueLower) || pattern.test(normalizedLower)) {
        isAnatomyCompound = true;
        break;
      }
    }
    if (isAnatomyCompound) {
      rejected.push({
        ...candidate,
        promoted: false,
        rejection_reason: `Anatomical/medical compound term: "${value}"`,
        rejection_category: 'body_part',
      });
      continue;
    }

    // 2c. Reject medical suffix patterns
    let hasMedicalSuffix = false;
    for (const pattern of MEDICAL_SUFFIX_PATTERNS) {
      if (pattern.test(valueLower) || pattern.test(normalizedLower)) {
        hasMedicalSuffix = true;
        break;
      }
    }
    if (hasMedicalSuffix) {
      rejected.push({
        ...candidate,
        promoted: false,
        rejection_reason: `Medical terminology: "${value}"`,
        rejection_category: 'body_part',
      });
      continue;
    }

    // 3. Reject generic building references
    if (GENERIC_BUILDING_REFS.has(valueLower) || GENERIC_BUILDING_REFS.has(normalizedLower)) {
      rejected.push({
        ...candidate,
        promoted: false,
        rejection_reason: `Generic building reference: "${value}"`,
        rejection_category: 'generic_noun',
      });
      continue;
    }

    // 4. Reject conversational/emotional patterns
    let isConversational = false;
    for (const pattern of CONVERSATIONAL_NOISE_PATTERNS) {
      if (pattern.test(valueLower)) {
        isConversational = true;
        break;
      }
    }
    if (isConversational) {
      rejected.push({
        ...candidate,
        promoted: false,
        rejection_reason: `Conversational/boilerplate: "${value}"`,
        rejection_category: 'conversational',
      });
      continue;
    }

    // 5. Reject single common words (unless they look like defined terms)
    const isDefinedTerm = candidate.entity_type === 'defined_term';
    const hasCapitalization = /^[A-Z]/.test(value) && value !== value.toLowerCase();
    const isQuoted = /^["'].*["']$/.test(value);
    const isSingleCommonWord = !valueLower.includes(' ') && COMMON_NOISE_WORDS.has(valueLower);

    if (isSingleCommonWord && !isDefinedTerm && !isQuoted) {
      rejected.push({
        ...candidate,
        promoted: false,
        rejection_reason: `Common single word without defined term context: "${value}"`,
        rejection_category: 'generic_noun',
      });
      continue;
    }

    // 6. Reject very low confidence candidates (< 0.3)
    if (candidate.confidence < 0.3) {
      rejected.push({
        ...candidate,
        promoted: false,
        rejection_reason: `Below minimum confidence threshold: ${candidate.confidence}`,
        rejection_category: 'low_legal_significance',
      });
      continue;
    }

    // Passed pre-filter — needs LLM review
    passthrough.push(candidate);
  }

  return { passthrough, rejected };
}

// ============================================================================
// STAGE B: SUPERVISORY LLM VALIDATION
// ============================================================================

const SUPERVISOR_SYSTEM_PROMPT = `You are a SUPERVISORY LEGAL INTELLIGENCE VALIDATOR operating as the quality gate for a legal document extraction pipeline.

## YOUR ROLE
You receive "candidate entities" extracted by a fast model (Stage A). Your job is to VALIDATE each one and decide: PROMOTE (save to database) or REJECT (discard).

## PROMOTION RULES (ALL must be met for promotion)
1. **Legally Significant**: The entity must be a real, named person, organization, court, statute, jurisdiction, or other legally meaningful reference. NOT generic nouns.
2. **Proper Classification**: The entity_type must be correct from the 16-type taxonomy.
3. **Clean Value**: The entity_value must be a proper name or reference, not a description or sentence fragment.
4. **Minimum Confidence**: You must assign a supervisor_confidence >= 0.5 for promotion.

## REJECTION RULES (ANY triggers rejection)
1. **Body Parts/Anatomy**: head, arm, leg, heart, brain, blood, etc. — ALWAYS reject
2. **Generic Nouns**: "the building", "a room", "the property" — reject unless it's a NAMED property
3. **Boilerplate Legal Text**: "herein", "whereas", "the parties", "this agreement" — reject
4. **Conversational Fragments**: "he said", "believed to be", "seemed to" — reject
5. **Single Common Words**: "agreement", "court", "witness" etc. unless they're a proper named entity
6. **Emotional/Subjective**: feelings, opinions, impressions — reject
7. **Duplicate/Redundant**: If two candidates clearly refer to the same entity, keep the better one
8. **Misclassified Noise**: Something classified as an entity but is actually just descriptive text

## TYPE CORRECTION
If the entity is valid but misclassified, PROMOTE it with the correct type. Available types:
party, court, statute, defined_term, judge, jurisdiction, regulatory_body, witness, law_firm, government_agency, law_enforcement, contract, evidence, location, vehicle, publication

## OUTPUT FORMAT
Return JSON:
{
  "validated": [
    {
      "index": 0,
      "promoted": true,
      "validated_type": "party",
      "validated_name": "Goldman Sachs Group, Inc.",
      "supervisor_confidence": 0.95,
      "promotion_reason": "Named corporate party in the agreement"
    },
    {
      "index": 1,
      "promoted": false,
      "rejection_reason": "Generic building reference, not a named location",
      "rejection_category": "generic_noun"
    }
  ],
  "quality_notes": "Brief assessment of overall extraction quality"
}

## CRITICAL RULES
- Be STRICT. When in doubt, REJECT. A clean database is worth more than a complete one.
- Never promote body parts, generic nouns, or sentence fragments.
- A named building ("Empire State Building") is valid; "the building" is not.
- "Judge Smith" is valid; "the judge" is not.
- "California Penal Code Section 187" is valid; "Section" alone is not.
- "ABC Corporation" is valid; "the company" is not.`;

interface SupervisorResponse {
  validated: Array<{
    index: number;
    promoted: boolean;
    validated_type?: EntityType;
    validated_name?: string;
    supervisor_confidence?: number;
    promotion_reason?: string;
    rejection_reason?: string;
    rejection_category?: string;
  }>;
  quality_notes?: string;
}

/**
 * Send candidate entities to the reasoning model for supervisory validation.
 * Processes in batches of 40 to stay within context limits.
 */
export async function validateAndPromote(
  candidates: CandidateEntity[],
  tenantId: string,
  caseId: string,
  documentContext?: string,
): Promise<{ promoted: PromotedEntity[]; rejected: RejectedEntity[]; tokens: number }> {
  if (candidates.length === 0) {
    return { promoted: [], rejected: [], tokens: 0 };
  }

  const BATCH_SIZE = 40;
  const allPromoted: PromotedEntity[] = [];
  const allRejected: RejectedEntity[] = [];
  let totalTokens = 0;

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);

    const candidatesForPrompt = batch.map((c, idx) => ({
      index: idx,
      entity_type: c.entity_type,
      entity_value: c.entity_value,
      normalized_value: c.normalized_value,
      confidence: c.confidence,
      context_snippet: c.context_snippet?.substring(0, 200),
    }));

    let userPrompt = `Validate these ${batch.length} candidate entities extracted from a legal document.\n\n`;
    userPrompt += JSON.stringify(candidatesForPrompt, null, 2);

    if (documentContext) {
      userPrompt += `\n\nDocument context (for reference):\n${documentContext.substring(0, 2000)}`;
    }

    const { result, tokens } = await callSupervisorModel<SupervisorResponse>(
      SUPERVISOR_SYSTEM_PROMPT,
      userPrompt,
      tenantId,
      caseId,
    );

    totalTokens += tokens;

    if (result?.validated) {
      for (const v of result.validated) {
        if (v.index < 0 || v.index >= batch.length) continue;
        const original = batch[v.index];

        if (v.promoted) {
          allPromoted.push({
            ...original,
            promoted: true,
            validated_type: (ENTITY_TYPES.includes(v.validated_type as EntityType)
              ? v.validated_type as EntityType
              : original.entity_type as EntityType),
            validated_name: v.validated_name || original.entity_value,
            supervisor_confidence: v.supervisor_confidence ?? original.confidence,
            promotion_reason: v.promotion_reason || 'Validated by supervisor',
          });
        } else {
          allRejected.push({
            ...original,
            promoted: false,
            rejection_reason: v.rejection_reason || 'Rejected by supervisor',
            rejection_category: (v.rejection_category as RejectedEntity['rejection_category']) || 'low_legal_significance',
          });
        }
      }

      // Any candidates the model didn't address — keep as promoted (fail-open for completeness)
      for (let idx = 0; idx < batch.length; idx++) {
        const addressed = result.validated.some(v => v.index === idx);
        if (!addressed) {
          const original = batch[idx];
          allPromoted.push({
            ...original,
            promoted: true,
            validated_type: original.entity_type as EntityType,
            validated_name: original.entity_value,
            supervisor_confidence: original.confidence * 0.8, // Penalize unaddressed
            promotion_reason: 'Not addressed by supervisor — promoted with reduced confidence',
          });
        }
      }
    } else {
      // LLM call failed — fall back to promoting all (degraded mode)
      console.warn('[SUPERVISOR] LLM validation failed for batch, promoting all candidates (degraded mode)');
      for (const original of batch) {
        allPromoted.push({
          ...original,
          promoted: true,
          validated_type: original.entity_type as EntityType,
          validated_name: original.entity_value,
          supervisor_confidence: original.confidence * 0.7,
          promotion_reason: 'Supervisor unavailable — promoted in degraded mode',
        });
      }
    }

    console.log(`[SUPERVISOR] Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(candidates.length / BATCH_SIZE)}: ${allPromoted.length} promoted, ${allRejected.length} rejected`);
  }

  return { promoted: allPromoted, rejected: allRejected, tokens: totalTokens };
}

// ============================================================================
// QUALITY ASSESSMENT & REFINEMENT LOOP
// ============================================================================

/**
 * Assess the quality of entity extraction results.
 * Returns a quality score and whether refinement is needed.
 */
export function assessExtractionQuality(
  promoted: PromotedEntity[],
  rejected: RejectedEntity[],
  totalCandidates: number,
  documentChunkCount: number,
): QualityAssessment {
  const total = promoted.length + rejected.length;
  
  // Over-extraction: more than 8 entities per chunk is suspicious
  const entitiesPerChunk = totalCandidates / Math.max(documentChunkCount, 1);
  const overExtraction = entitiesPerChunk > 8;

  // Pollution: check how many promoted entities have low supervisor confidence
  const lowConfidencePromoted = promoted.filter(e => e.supervisor_confidence < 0.6);
  const lowConfidenceRatio = promoted.length > 0 ? lowConfidencePromoted.length / promoted.length : 0;

  // Taxonomy violations: types that don't match validated types
  const taxonomyViolations = promoted.filter(e => 
    !ENTITY_TYPES.includes(e.validated_type)
  ).length;

  // Rejection ratio: if we reject > 60% of candidates, the extraction model may be polluted
  const rejectionRatio = total > 0 ? rejected.length / total : 0;
  const pollutionDetected = rejectionRatio > 0.6;

  // Quality score (0-1)
  let qualityScore = 1.0;
  if (overExtraction) qualityScore -= 0.2;
  if (pollutionDetected) qualityScore -= 0.3;
  if (lowConfidenceRatio > 0.3) qualityScore -= 0.2;
  if (taxonomyViolations > 0) qualityScore -= 0.1 * Math.min(taxonomyViolations, 5);
  qualityScore = Math.max(0, Math.min(1, qualityScore));

  const needsRefinement = qualityScore < 0.5 || pollutionDetected || overExtraction;

  const notes: string[] = [];
  if (overExtraction) notes.push(`Over-extraction: ${entitiesPerChunk.toFixed(1)} entities/chunk`);
  if (pollutionDetected) notes.push(`High rejection rate: ${(rejectionRatio * 100).toFixed(0)}%`);
  if (lowConfidenceRatio > 0.3) notes.push(`${(lowConfidenceRatio * 100).toFixed(0)}% low confidence`);
  if (taxonomyViolations > 0) notes.push(`${taxonomyViolations} taxonomy violations`);

  return {
    quality_score: Math.round(qualityScore * 100) / 100,
    over_extraction: overExtraction,
    pollution_detected: pollutionDetected,
    taxonomy_violations: taxonomyViolations,
    low_confidence_ratio: Math.round(lowConfidenceRatio * 100) / 100,
    needs_refinement: needsRefinement,
    assessment_notes: notes.length > 0 ? notes.join('; ') : 'Quality acceptable',
  };
}

/**
 * Run a refinement pass on promoted entities.
 * Re-validates entities that the quality assessment flagged as problematic.
 * Focuses on low-confidence and potentially misclassified entities.
 */
export async function runRefinementPass(
  promoted: PromotedEntity[],
  quality: QualityAssessment,
  tenantId: string,
  caseId: string,
): Promise<{ refined: PromotedEntity[]; additionalRejected: RejectedEntity[]; tokens: number }> {
  // Only refine entities with issues
  const needsReview = promoted.filter(e => 
    e.supervisor_confidence < 0.6 || 
    !ENTITY_TYPES.includes(e.validated_type)
  );

  const clean = promoted.filter(e => 
    e.supervisor_confidence >= 0.6 && 
    ENTITY_TYPES.includes(e.validated_type)
  );

  if (needsReview.length === 0) {
    return { refined: promoted, additionalRejected: [], tokens: 0 };
  }

  console.log(`[SUPERVISOR] Refinement pass: reviewing ${needsReview.length} entities`);

  // Re-validate the problematic entities with stricter criteria
  const candidatesForReview: CandidateEntity[] = needsReview.map(e => ({
    entity_type: e.validated_type,
    entity_value: e.validated_name,
    normalized_value: e.normalized_value,
    context_snippet: e.context_snippet,
    confidence: e.supervisor_confidence,
  }));

  const refinementPrompt = `REFINEMENT PASS — These entities were flagged for quality issues (${quality.assessment_notes}).
Apply STRICTER standards. When in doubt, REJECT.`;

  const { result, tokens } = await callSupervisorModel<SupervisorResponse>(
    SUPERVISOR_SYSTEM_PROMPT + '\n\n' + refinementPrompt,
    `Re-validate these ${candidatesForReview.length} entities:\n\n${JSON.stringify(candidatesForReview.map((c, i) => ({ index: i, ...c })), null, 2)}`,
    tenantId,
    caseId,
  );

  const refined: PromotedEntity[] = [...clean];
  const additionalRejected: RejectedEntity[] = [];

  if (result?.validated) {
    for (const v of result.validated) {
      if (v.index < 0 || v.index >= needsReview.length) continue;
      const original = needsReview[v.index];

      if (v.promoted) {
        refined.push({
          ...original,
          validated_type: (ENTITY_TYPES.includes(v.validated_type as EntityType)
            ? v.validated_type as EntityType
            : original.validated_type),
          validated_name: v.validated_name || original.validated_name,
          supervisor_confidence: v.supervisor_confidence ?? original.supervisor_confidence,
          promotion_reason: `Refinement confirmed: ${v.promotion_reason || original.promotion_reason}`,
        });
      } else {
        additionalRejected.push({
          entity_type: original.entity_type,
          entity_value: original.entity_value,
          normalized_value: original.normalized_value,
          context_snippet: original.context_snippet,
          confidence: original.confidence,
          promoted: false,
          rejection_reason: `Refinement rejected: ${v.rejection_reason || 'Failed stricter review'}`,
          rejection_category: (v.rejection_category as RejectedEntity['rejection_category']) || 'low_legal_significance',
        });
      }
    }

    // Handle unaddressed entities — reject in refinement (fail-closed)
    for (let idx = 0; idx < needsReview.length; idx++) {
      const addressed = result.validated.some(v => v.index === idx);
      if (!addressed) {
        const original = needsReview[idx];
        additionalRejected.push({
          entity_type: original.entity_type,
          entity_value: original.entity_value,
          normalized_value: original.normalized_value,
          context_snippet: original.context_snippet,
          confidence: original.confidence,
          promoted: false,
          rejection_reason: 'Not addressed in refinement pass — rejected (fail-closed)',
          rejection_category: 'low_legal_significance',
        });
      }
    }
  } else {
    // Refinement LLM failed — keep originals (fail-open since they already passed initial validation)
    refined.push(...needsReview);
  }

  console.log(`[SUPERVISOR] Refinement complete: ${refined.length} kept, ${additionalRejected.length} additional rejections`);
  return { refined, additionalRejected, tokens };
}

// ============================================================================
// FULL SUPERVISORY PIPELINE
// ============================================================================

/**
 * Run the complete supervisory validation pipeline on candidate entities.
 * 
 * Flow:
 *   1. Rule-based pre-filter (fast, no LLM)
 *   2. LLM supervisory validation (GPT-4.1)
 *   3. Quality assessment
 *   4. Refinement pass (if needed)
 * 
 * Returns only PROMOTED entities ready for database storage.
 */
export async function runSupervisoryPipeline(
  candidates: CandidateEntity[],
  tenantId: string,
  caseId: string,
  documentChunkCount: number,
  documentContext?: string,
): Promise<SupervisoryResult> {
  const startTime = Date.now();
  let totalTokens = 0;

  console.log(`\n[SUPERVISOR] ========================================`);
  console.log(`[SUPERVISOR] Pipeline start: ${candidates.length} candidates`);

  // Step 1: Rule-based pre-filter
  const { passthrough, rejected: preFilterRejected } = filterCandidates(candidates);
  console.log(`[SUPERVISOR] Pre-filter: ${passthrough.length} pass, ${preFilterRejected.length} rejected`);

  // Step 2: LLM supervisory validation
  const { promoted, rejected: supervisorRejected, tokens: validationTokens } = await validateAndPromote(
    passthrough,
    tenantId,
    caseId,
    documentContext,
  );
  totalTokens += validationTokens;
  console.log(`[SUPERVISOR] Validation: ${promoted.length} promoted, ${supervisorRejected.length} rejected`);

  // Step 3: Quality assessment
  const quality = assessExtractionQuality(
    promoted,
    [...preFilterRejected, ...supervisorRejected],
    candidates.length,
    documentChunkCount,
  );
  console.log(`[SUPERVISOR] Quality: ${quality.quality_score} — ${quality.assessment_notes}`);

  // Step 4: Refinement loop (if quality is poor)
  let finalPromoted = promoted;
  let refinementTriggered = false;
  let refinementCorrections = 0;

  if (quality.needs_refinement && promoted.length > 0) {
    refinementTriggered = true;
    console.log(`[SUPERVISOR] Quality below threshold (${quality.quality_score}), triggering refinement pass...`);

    const { refined, additionalRejected, tokens: refinementTokens } = await runRefinementPass(
      promoted,
      quality,
      tenantId,
      caseId,
    );

    totalTokens += refinementTokens;
    refinementCorrections = additionalRejected.length;
    finalPromoted = refined;

    console.log(`[SUPERVISOR] Refinement: ${refinementCorrections} additional rejections`);
  }

  const allRejected = [...preFilterRejected, ...supervisorRejected];
  
  const result: SupervisoryResult = {
    promoted: finalPromoted,
    rejected: allRejected,
    total_candidates: candidates.length,
    pre_filter_rejected: preFilterRejected.length,
    supervisor_rejected: supervisorRejected.length,
    supervisor_promoted: finalPromoted.length,
    refinement_triggered: refinementTriggered,
    refinement_corrections: refinementCorrections,
    tokens_used: totalTokens,
    processing_time_ms: Date.now() - startTime,
  };

  console.log(`[SUPERVISOR] Pipeline complete: ${finalPromoted.length}/${candidates.length} promoted (${((finalPromoted.length / Math.max(candidates.length, 1)) * 100).toFixed(0)}%) in ${result.processing_time_ms}ms`);
  console.log(`[SUPERVISOR] ========================================\n`);

  return result;
}

// ============================================================================
// OPENAI HELPER (Supervisor Model = Reasoning Model)
// ============================================================================

async function callSupervisorModel<T>(
  systemPrompt: string,
  userPrompt: string,
  tenantId: string,
  caseId: string,
): Promise<{ result: T | null; tokens: number }> {
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
      console.error(`[SUPERVISOR] Model error (${response.status}):`, errorText);
      return { result: null, tokens: 0 };
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
      return { result: null, tokens: tokensUsed };
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

    return { result: parsed, tokens: tokensUsed };
  } catch (error) {
    console.error('[SUPERVISOR] Model call failed:', error);
    return { result: null, tokens: 0 };
  }
}
