/**
 * OCR Service - Optical Character Recognition
 * Primary: OpenAI Vision (gpt-4o-mini) for high-accuracy text extraction
 * Fallback: Tesseract.js for offline/error scenarios
 */

import Tesseract from 'tesseract.js';
import OpenAI from 'openai';
import { config } from '../config/index.js';

export interface OcrResult {
  text: string;
  confidence: number;
  words: Array<{
    text: string;
    confidence: number;
    bbox: { x0: number; y0: number; x1: number; y1: number };
  }>;
}

// ── OpenAI Vision (Primary OCR) ──────────────────────────────────────

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return openaiClient;
}

const VISION_MODEL = 'gpt-4o-mini'; // Cheapest vision model — ~$0.0003 per image

/**
 * Perform OCR using OpenAI Vision API
 */
async function performVisionOcr(imageBuffer: Buffer): Promise<OcrResult> {
  const base64Image = imageBuffer.toString('base64');
  const mimeType = detectMimeType(imageBuffer);

  const response = await getOpenAI().chat.completions.create({
    model: VISION_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'You are an OCR engine. Extract ALL text from the provided image exactly as it appears. ' +
          'Preserve the original layout, line breaks, and formatting as closely as possible. ' +
          'If the image contains no readable text, respond with exactly: [NO_TEXT]',
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${base64Image}`,
              detail: 'high', // High detail for better OCR accuracy
            },
          },
        ],
      },
    ],
    max_tokens: 4096,
    temperature: 0,
  });

  const extractedText = response.choices[0]?.message?.content?.trim() || '';

  // [NO_TEXT] means the model found no readable text
  const text = extractedText === '[NO_TEXT]' ? '' : extractedText;

  return {
    text,
    // Vision models are highly accurate; use 0.95 for non-empty, 0 for empty
    confidence: text.length > 0 ? 0.95 : 0,
    words: [], // Vision API doesn't return word-level bounding boxes
  };
}

/**
 * Detect MIME type from buffer magic bytes
 */
function detectMimeType(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif';
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'image/webp';
  return 'image/png'; // Safe default
}

// ── Tesseract.js (Fallback OCR) ──────────────────────────────────────

let workerPool: Tesseract.Worker[] = [];
let currentWorkerIndex = 0;
const POOL_SIZE = 2;

async function getWorker(): Promise<Tesseract.Worker> {
  if (workerPool.length < POOL_SIZE) {
    console.log('🔤 Initializing Tesseract fallback worker...');
    const worker = await Tesseract.createWorker('eng', 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          if (m.progress && m.progress % 0.25 < 0.01) {
            console.log(`   OCR progress: ${Math.round(m.progress * 100)}%`);
          }
        }
      },
    });
    workerPool.push(worker);
    return worker;
  }
  const worker = workerPool[currentWorkerIndex];
  currentWorkerIndex = (currentWorkerIndex + 1) % workerPool.length;
  return worker;
}

async function performTesseractOcr(imageBuffer: Buffer): Promise<OcrResult> {
  const worker = await getWorker();
  const { data } = await worker.recognize(imageBuffer);

  return {
    text: data.text.trim(),
    confidence: data.confidence / 100,
    words:
      (data as any).words?.map((w: any) => ({
        text: w.text,
        confidence: w.confidence / 100,
        bbox: w.bbox,
      })) || [],
  };
}

// ── Public API (unchanged interface) ─────────────────────────────────

/**
 * Perform OCR on an image buffer
 * Uses OpenAI Vision as primary engine, falls back to Tesseract.js on failure
 */
export async function performOcr(imageBuffer: Buffer): Promise<OcrResult> {
  console.log(`🔤 Performing OCR on ${imageBuffer.length} bytes...`);

  // Primary: OpenAI Vision
  try {
    const result = await performVisionOcr(imageBuffer);
    console.log(
      `✅ Vision OCR complete: ${result.text.length} chars, ${(result.confidence * 100).toFixed(1)}% confidence`
    );
    return result;
  } catch (visionError) {
    console.warn('⚠️ OpenAI Vision OCR failed, falling back to Tesseract:', visionError);
  }

  // Fallback: Tesseract.js
  try {
    const result = await performTesseractOcr(imageBuffer);
    console.log(
      `✅ Tesseract OCR fallback: ${result.text.length} chars, ${(result.confidence * 100).toFixed(1)}% confidence`
    );
    return result;
  } catch (error) {
    console.error('❌ OCR error (both engines failed):', error);
    throw new Error(`OCR failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Check if an image likely contains text (heuristic)
 * Returns true if the image might benefit from OCR
 */
export function mightContainText(width: number, height: number): boolean {
  // Very small images are unlikely to contain readable text
  if (width < 100 || height < 50) return false;

  // Very large aspect ratios might be decorative
  const aspectRatio = width / height;
  if (aspectRatio > 10 || aspectRatio < 0.1) return false;

  return true;
}

/**
 * Cleanup OCR workers on shutdown
 */
export async function terminateOcrWorkers(): Promise<void> {
  console.log('🔤 Terminating OCR workers...');
  for (const worker of workerPool) {
    await worker.terminate();
  }
  workerPool = [];
}

/**
 * Perform OCR on multiple images in parallel
 */
export async function performOcrBatch(imageBuffers: Buffer[]): Promise<OcrResult[]> {
  console.log(`🔤 Performing batch OCR on ${imageBuffers.length} images...`);

  const results: OcrResult[] = [];

  // Process in batches of 3 (respect OpenAI rate limits)
  const batchSize = 3;
  for (let i = 0; i < imageBuffers.length; i += batchSize) {
    const batch = imageBuffers.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((buf) => performOcr(buf)));
    results.push(...batchResults);
  }

  return results;
}
