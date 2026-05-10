/**
 * Image Processor — Phase B Core
 *
 * Pipeline for image vault assets:
 *   1. Download from Supabase Storage
 *   2. Normalize with Sharp (resize, format, thumbnail)
 *   3. OCR via ocrService (Vision primary, Tesseract fallback)
 *   4. AI classification (legal photo, exhibit, scan, identity doc, …)
 *   5. Entity extraction from OCR text
 *   6. Optional case linking via cosine similarity
 *   7. Persist results to vault_assets row — NO chunks, NO embeddings
 */

import sharp from 'sharp';
import OpenAI from 'openai';
import { supabaseAdmin } from '../../config/supabase.js';
import { config } from '../../config/index.js';
import { performOcr } from '../ocrService.js';
import { linkImageToCase, CaseLinkDecision } from './caseLinker.js';
import { ProcessImageJob, ImageProcessingResult } from '../../types/index.js';

// ── Constants ────────────────────────────────────────────────────────

/** Max edge length before we normalize (3000 px keeps Vision API happy) */
const MAX_IMAGE_EDGE = 3000;

/** Thumbnail dimensions */
const THUMB_WIDTH = 400;
const THUMB_HEIGHT = 400;

/** Allowed output format after normalization */
const NORMALIZED_FORMAT = 'webp' as const;

// ── OpenAI client ────────────────────────────────────────────────────

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return openaiClient;
}

// ── Public entry point ───────────────────────────────────────────────

/**
 * Full image processing pipeline. Called by the image worker.
 */
export async function processImageAsset(
  job: ProcessImageJob,
  onProgress: (pct: number, msg: string) => Promise<void>,
): Promise<ImageProcessingResult> {
  const start = Date.now();

  try {
    // ── 1. Mark processing ───────────────────────────────────────────
    await onProgress(5, 'Downloading image…');
    await updateAssetStatus(job.file_id, 'processing', 'downloading');

    const rawBuffer = await downloadFile(job.storage_path);
    console.log(`📥 Downloaded ${job.filename} — ${rawBuffer.length} bytes`);

    // ── 2. Normalize + thumbnail ─────────────────────────────────────
    await onProgress(15, 'Normalizing image…');
    await updateAssetStatus(job.file_id, 'processing', 'normalizing');

    const { normalized, thumbnail, metadata } = await normalizeImage(rawBuffer);

    // Upload normalized + thumbnail to storage
    const basePath = job.storage_path.replace(/\.[^.]+$/, '');
    const normalizedPath = `${basePath}_normalized.webp`;
    const thumbnailPath = `${basePath}_thumb.webp`;

    await Promise.all([
      uploadToStorage(normalizedPath, normalized, 'image/webp'),
      uploadToStorage(thumbnailPath, thumbnail, 'image/webp'),
    ]);

    // ── 3. OCR ───────────────────────────────────────────────────────
    await onProgress(35, 'Running OCR…');
    await updateAssetStatus(job.file_id, 'processing', 'ocr');

    const ocrResult = await performOcr(normalized);
    const ocrText = ocrResult.text;

    // ── 4. AI classification ─────────────────────────────────────────
    await onProgress(55, 'Classifying image…');
    await updateAssetStatus(job.file_id, 'processing', 'classifying');

    const classification = await classifyImage(normalized, ocrText);

    // ── 5. Entity extraction ─────────────────────────────────────────
    await onProgress(65, 'Extracting entities…');
    const entities = extractEntities(ocrText);

    // ── 6. Vision summary ────────────────────────────────────────────
    await onProgress(75, 'Generating summary…');
    const visionSummary = await generateVisionSummary(normalized, ocrText);

    // ── 7. Case linking (optional) ───────────────────────────────────
    await onProgress(85, 'Linking to case…');
    await updateAssetStatus(job.file_id, 'processing', 'linking');

    let linkDecision: CaseLinkDecision = { link_status: 'none' };
    if (job.case_id) {
      try {
        linkDecision = await linkImageToCase(
          job.file_id,
          job.case_id,
          job.tenant_id,
          visionSummary,
          ocrText,
          classification.label,
        );
      } catch (err) {
        console.warn('⚠️ Case linking failed (non-fatal):', err);
      }
    }

    // ── 8. Persist results ───────────────────────────────────────────
    await onProgress(95, 'Saving results…');

    await supabaseAdmin
      .from('vault_assets')
      .update({
        status: 'ready',
        processing_stage: null,
        ocr_text: ocrText || null,
        vision_summary: visionSummary || null,
        classification: classification.label,
        confidence_score: classification.confidence,
        thumbnail_url: thumbnailPath,
        normalized_url: normalizedPath,
        entities: entities.length > 0 ? entities : null,
        linked_case_id: linkDecision.linked_case_id ?? null,
        match_score: linkDecision.match_score ?? null,
        link_status: linkDecision.link_status,
      })
      .eq('id', job.file_id);

    await onProgress(100, 'Done');

    const elapsed = Date.now() - start;
    return {
      success: true,
      file_id: job.file_id,
      ocr_text_length: ocrText.length,
      classification: classification.label,
      confidence_score: classification.confidence,
      linked_case_id: linkDecision.linked_case_id,
      match_score: linkDecision.match_score,
      link_status: linkDecision.link_status,
      processing_time_ms: elapsed,
    };
  } catch (error) {
    const elapsed = Date.now() - start;
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`❌ Image processing failed for ${job.filename}:`, message);

    await updateAssetStatus(job.file_id, 'failed', `error: ${message.slice(0, 200)}`);

    return {
      success: false,
      file_id: job.file_id,
      ocr_text_length: 0,
      classification: 'unknown',
      confidence_score: 0,
      link_status: 'none',
      processing_time_ms: elapsed,
      error: message,
    };
  }
}

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Download a file from Supabase Storage → Buffer
 */
async function downloadFile(storagePath: string): Promise<Buffer> {
  const { data, error } = await supabaseAdmin.storage
    .from('documents')
    .download(storagePath);

  if (error || !data) {
    throw new Error(`Storage download failed: ${JSON.stringify(error) || 'no data'}`);
  }

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Upload a buffer to Supabase Storage (upsert)
 */
async function uploadToStorage(path: string, buffer: Buffer, contentType: string): Promise<void> {
  const { error } = await supabaseAdmin.storage
    .from('documents')
    .upload(path, buffer, { contentType, upsert: true });

  if (error) {
    console.warn(`⚠️ Upload to ${path} failed:`, error.message);
  }
}

/**
 * Normalize image with Sharp: resize to max edge, convert to WebP,
 * and generate a thumbnail.
 */
async function normalizeImage(raw: Buffer): Promise<{
  normalized: Buffer;
  thumbnail: Buffer;
  metadata: sharp.Metadata;
}> {
  const metadata = await sharp(raw).metadata();

  // Resize if either dimension exceeds MAX_IMAGE_EDGE
  const needsResize =
    (metadata.width && metadata.width > MAX_IMAGE_EDGE) ||
    (metadata.height && metadata.height > MAX_IMAGE_EDGE);

  const normalized = await sharp(raw)
    .rotate() // auto-orient based on EXIF
    .resize(needsResize ? { width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: 'inside' } : undefined)
    .webp({ quality: 85 })
    .toBuffer();

  const thumbnail = await sharp(raw)
    .rotate()
    .resize({ width: THUMB_WIDTH, height: THUMB_HEIGHT, fit: 'cover' })
    .webp({ quality: 70 })
    .toBuffer();

  return { normalized, thumbnail, metadata };
}

/**
 * AI classification of the image via OpenAI Vision.
 * Returns a label + confidence score.
 */
async function classifyImage(
  imageBuffer: Buffer,
  ocrText: string,
): Promise<{ label: string; confidence: number }> {
  try {
    const base64 = imageBuffer.toString('base64');

    const response = await getOpenAI().chat.completions.create({
      model: config.openai.extractionModel,
      messages: [
        {
          role: 'system',
          content: `You are a legal document classifier. Classify the provided image into exactly ONE of these categories:
- exhibit_photo: Photograph used as evidence (crime scene, property damage, etc.)
- scanned_document: Scanned paper document (contracts, letters, judgments)
- identity_document: ID cards, passports, driving licenses
- legal_notice: Official legal notices, summons, court orders
- receipt_invoice: Financial documents, receipts, invoices
- map_diagram: Maps, floor plans, technical diagrams
- medical_record: Medical reports, prescriptions, lab results
- signature_page: Pages primarily containing signatures
- handwritten_note: Handwritten notes or letters
- other: Does not fit any category above

Respond in JSON: { "label": "<category>", "confidence": <0.0-1.0> }
Only output the JSON, nothing else.`,
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/webp;base64,${base64}`,
                detail: 'low',
              },
            },
            ...(ocrText.length > 0
              ? [{ type: 'text' as const, text: `OCR text found in image:\n${ocrText.slice(0, 500)}` }]
              : []),
          ],
        },
      ],
      max_tokens: 100,
      temperature: 0,
      response_format: { type: 'json_object' },
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? '{}';
    const parsed = JSON.parse(raw);

    return {
      label: parsed.label || 'other',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    };
  } catch (err) {
    console.warn('⚠️ Classification failed, defaulting to other:', err);
    return { label: 'other', confidence: 0 };
  }
}

/**
 * One-line vision summary of the image for case-linking embeddings.
 */
async function generateVisionSummary(imageBuffer: Buffer, ocrText: string): Promise<string> {
  try {
    const base64 = imageBuffer.toString('base64');

    const response = await getOpenAI().chat.completions.create({
      model: config.openai.extractionModel,
      messages: [
        {
          role: 'system',
          content:
            'Describe this legal/evidence image in 1-2 sentences for indexing purposes. ' +
            'Focus on what is depicted, any visible text, and its likely evidentiary value.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/webp;base64,${base64}`,
                detail: 'low',
              },
            },
            ...(ocrText.length > 0
              ? [{ type: 'text' as const, text: `OCR text: ${ocrText.slice(0, 300)}` }]
              : []),
          ],
        },
      ],
      max_tokens: 200,
      temperature: 0,
    });

    return response.choices[0]?.message?.content?.trim() ?? '';
  } catch (err) {
    console.warn('⚠️ Vision summary failed:', err);
    // Fallback: use OCR text as summary
    return ocrText.length > 0 ? ocrText.slice(0, 200) : 'Image — no description available';
  }
}

/**
 * Simple regex-based entity extraction from OCR text.
 * Returns an array of { type, value } objects.
 */
function extractEntities(text: string): Array<{ type: string; value: string }> {
  if (!text || text.length < 5) return [];

  const entities: Array<{ type: string; value: string }> = [];
  const seen = new Set<string>();

  const add = (type: string, value: string) => {
    const key = `${type}:${value}`;
    if (!seen.has(key)) {
      seen.add(key);
      entities.push({ type, value });
    }
  };

  // Dates (DD/MM/YYYY, DD-MM-YYYY, Month DD YYYY, etc.)
  const datePatterns = [
    /\b(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})\b/g,
    /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/gi,
  ];
  for (const pat of datePatterns) {
    for (const m of text.matchAll(pat)) {
      add('date', m[1]);
    }
  }

  // Case numbers (PLD 2021 SC 123, Civil Appeal No. 456, etc.)
  const casePatterns = [
    /\b(PLD\s+\d{4}\s+\w+\s+\d+)\b/gi,
    /\b((?:Civil|Criminal|Writ|Appeal|Petition)\s+(?:No|Number|#)\.?\s*[\d\-\/]+)/gi,
    /\b(FIR\s+No\.?\s*[\d\-\/]+)/gi,
  ];
  for (const pat of casePatterns) {
    for (const m of text.matchAll(pat)) {
      add('case_number', m[1].trim());
    }
  }

  // Money amounts
  const moneyPattern = /(?:Rs\.?|PKR|USD|\$|£|€)\s*[\d,]+(?:\.\d{1,2})?/gi;
  for (const m of text.matchAll(moneyPattern)) {
    add('money', m[0].trim());
  }

  // CNIC / NIC numbers (Pakistan)
  const cnicPattern = /\b(\d{5}-\d{7}-\d{1})\b/g;
  for (const m of text.matchAll(cnicPattern)) {
    add('cnic', m[1]);
  }

  // Email addresses
  const emailPattern = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g;
  for (const m of text.matchAll(emailPattern)) {
    add('email', m[1]);
  }

  // Phone numbers
  const phonePattern = /(?:\+?\d{1,3}[\s\-]?)?\(?\d{2,4}\)?[\s\-]?\d{3,4}[\s\-]?\d{3,4}/g;
  for (const m of text.matchAll(phonePattern)) {
    const cleaned = m[0].replace(/\s+/g, '');
    if (cleaned.length >= 7 && cleaned.length <= 15) {
      add('phone', m[0].trim());
    }
  }

  // Legal sections (Section 302 PPC, Article 184(3), etc.)
  const sectionPattern = /\b(?:Section|Article|Rule|Order)\s+\d+[\w()]*(?:\s+(?:PPC|CrPC|CPC|Constitution|QSO))?/gi;
  for (const m of text.matchAll(sectionPattern)) {
    add('legal_section', m[0].trim());
  }

  return entities;
}

/**
 * Update asset status in vault_assets table
 */
async function updateAssetStatus(
  fileId: string,
  status: 'processing' | 'ready' | 'failed',
  processingStage?: string | null,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('vault_assets')
    .update({
      status,
      processing_stage: processingStage ?? null,
    })
    .eq('id', fileId);

  if (error) {
    console.error(`Failed to update asset status for ${fileId}:`, error);
  }
}
