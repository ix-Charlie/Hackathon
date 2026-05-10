/**
 * Case Linker — Cosine-similarity based linking of images to cases
 *
 * Strategy:
 *   1. Generate an embedding for the image's vision summary + OCR text
 *   2. Generate an embedding for the case's name + description
 *   3. Compute cosine similarity
 *   4. Decision thresholds:
 *       ≥ 0.88  → auto-link   (high confidence)
 *       0.70–0.87 → suggested  (needs user confirmation)
 *       < 0.70  → none        (no link)
 *   5. Persist decision to asset_case_links table
 */

import { supabaseAdmin } from '../../config/supabase.js';
import { generateEmbedding } from '../embeddingService.js';

// ── Thresholds ───────────────────────────────────────────────────────

const AUTO_LINK_THRESHOLD = 0.88;
const SUGGEST_THRESHOLD = 0.70;

// ── Types ────────────────────────────────────────────────────────────

export interface CaseLinkDecision {
  link_status: 'auto' | 'suggested' | 'none';
  linked_case_id?: string;
  match_score?: number;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Attempt to link an image asset to its case by semantic similarity.
 *
 * @param fileId        vault_assets.id
 * @param caseId        The case the asset was uploaded to
 * @param tenantId      Tenant scoping
 * @param visionSummary 1-2 sentence summary from Vision API
 * @param ocrText       Extracted OCR text
 * @param classification Image classification label
 * @returns Link decision with score
 */
export async function linkImageToCase(
  fileId: string,
  caseId: string,
  tenantId: string,
  visionSummary: string,
  ocrText: string,
  classification: string,
): Promise<CaseLinkDecision> {
  // ── 1. Fetch case details ──────────────────────────────────────────
  const { data: caseData, error: caseErr } = await supabaseAdmin
    .from('cases')
    .select('name, description')
    .eq('id', caseId)
    .eq('tenant_id', tenantId)
    .single();

  if (caseErr || !caseData) {
    console.warn(`⚠️ Case ${caseId} not found for linking`);
    return { link_status: 'none' };
  }

  // Skip linking for generic "General Documents"
  if (caseData.name === 'General Documents') {
    return { link_status: 'none' };
  }

  // ── 2. Build embedding texts ───────────────────────────────────────
  const imageText = buildImageEmbeddingText(visionSummary, ocrText, classification);
  const caseText = buildCaseEmbeddingText(caseData.name, caseData.description);

  if (imageText.length < 10 || caseText.length < 10) {
    return { link_status: 'none' };
  }

  // ── 3. Generate embeddings ─────────────────────────────────────────
  const [imageEmbedding, caseEmbedding] = await Promise.all([
    generateEmbedding(imageText),
    generateEmbedding(caseText),
  ]);

  // ── 4. Cosine similarity ──────────────────────────────────────────
  const similarity = cosineSimilarity(imageEmbedding, caseEmbedding);
  console.log(`🔗 Case link similarity for ${fileId}: ${similarity.toFixed(4)} (case: ${caseData.name})`);

  // ── 5. Decision ───────────────────────────────────────────────────
  let linkStatus: CaseLinkDecision['link_status'];
  if (similarity >= AUTO_LINK_THRESHOLD) {
    linkStatus = 'auto';
  } else if (similarity >= SUGGEST_THRESHOLD) {
    linkStatus = 'suggested';
  } else {
    linkStatus = 'none';
  }

  // ── 6. Persist to asset_case_links ────────────────────────────────
  if (linkStatus !== 'none') {
    await supabaseAdmin
      .from('asset_case_links')
      .upsert(
        {
          asset_id: fileId,
          case_id: caseId,
          tenant_id: tenantId,
          match_score: similarity,
          link_status: linkStatus,
          classification,
          created_at: new Date().toISOString(),
        },
        { onConflict: 'asset_id,case_id' },
      );

    console.log(`🔗 ${linkStatus === 'auto' ? '✅ Auto-linked' : '💡 Suggested link'} — score ${similarity.toFixed(4)}`);
  }

  return {
    link_status: linkStatus,
    linked_case_id: linkStatus !== 'none' ? caseId : undefined,
    match_score: similarity,
  };
}

/**
 * Confirm a suggested case link (user action)
 */
export async function confirmCaseLink(
  fileId: string,
  caseId: string,
): Promise<void> {
  await supabaseAdmin
    .from('asset_case_links')
    .update({ link_status: 'auto' })
    .eq('asset_id', fileId)
    .eq('case_id', caseId);

  await supabaseAdmin
    .from('vault_assets')
    .update({ linked_case_id: caseId, link_status: 'auto' })
    .eq('id', fileId);

  console.log(`🔗 ✅ Link confirmed: ${fileId} → ${caseId}`);
}

/**
 * Reject a suggested case link (user action)
 */
export async function rejectCaseLink(
  fileId: string,
  caseId: string,
): Promise<void> {
  await supabaseAdmin
    .from('asset_case_links')
    .delete()
    .eq('asset_id', fileId)
    .eq('case_id', caseId);

  await supabaseAdmin
    .from('vault_assets')
    .update({ linked_case_id: null, match_score: null, link_status: 'none' })
    .eq('id', fileId);

  console.log(`🔗 ❌ Link rejected: ${fileId} → ${caseId}`);
}

// ── Helpers ──────────────────────────────────────────────────────────

function buildImageEmbeddingText(
  visionSummary: string,
  ocrText: string,
  classification: string,
): string {
  const parts: string[] = [];

  if (visionSummary) parts.push(`Image: ${visionSummary}`);
  if (classification && classification !== 'other') parts.push(`Type: ${classification}`);
  if (ocrText) parts.push(`Text: ${ocrText.slice(0, 500)}`);

  return parts.join('\n');
}

function buildCaseEmbeddingText(name: string, description?: string | null): string {
  const parts = [`Case: ${name}`];
  if (description) parts.push(`Description: ${description.slice(0, 500)}`);
  return parts.join('\n');
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
