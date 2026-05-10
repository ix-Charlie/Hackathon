/**
 * Asset Type Detector
 * Routes vault uploads to the correct processing pipeline based on MIME type
 * and optional magic number validation.
 */

import { VaultAssetType } from '../types/index.js';

// ============================================================================
// MAGIC NUMBER SIGNATURES
// ============================================================================

const MAGIC_NUMBERS: { bytes: number[]; type: VaultAssetType; label: string }[] = [
  // JPEG: FF D8 FF
  { bytes: [0xFF, 0xD8, 0xFF], type: 'image', label: 'JPEG' },
  // PNG: 89 50 4E 47
  { bytes: [0x89, 0x50, 0x4E, 0x47], type: 'image', label: 'PNG' },
  // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF....WEBP)
  { bytes: [0x52, 0x49, 0x46, 0x46], type: 'image', label: 'RIFF/WebP' },
  // GIF: 47 49 46 38
  { bytes: [0x47, 0x49, 0x46, 0x38], type: 'image', label: 'GIF' },
  // TIFF (little-endian): 49 49 2A 00
  { bytes: [0x49, 0x49, 0x2A, 0x00], type: 'image', label: 'TIFF-LE' },
  // TIFF (big-endian): 4D 4D 00 2A
  { bytes: [0x4D, 0x4D, 0x00, 0x2A], type: 'image', label: 'TIFF-BE' },
  // BMP: 42 4D
  { bytes: [0x42, 0x4D], type: 'image', label: 'BMP' },
];

// ============================================================================
// IMAGE MIME TYPES
// ============================================================================

const IMAGE_MIME_PREFIXES = ['image/'];

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/tiff',
  'image/bmp',
  'image/svg+xml',
  'image/heic',
  'image/heif',
  'image/avif',
]);

const SPREADSHEET_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);

const SPREADSHEET_EXTENSIONS = new Set([
  '.csv', '.xlsx', '.xls', '.tsv',
]);

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.tiff', '.tif',
  '.bmp', '.svg', '.heic', '.heif', '.avif',
]);

// ============================================================================
// DETECTION FUNCTIONS
// ============================================================================

/**
 * Detect the asset type from MIME type, filename, and optional buffer inspection.
 * Uses a layered approach:
 *   1. MIME type prefix check (most reliable when browser provides it)
 *   2. File extension fallback
 *   3. Magic number validation (if buffer provided)
 */
export function detectAssetType(
  filename: string,
  mimeType: string,
  buffer?: Buffer
): VaultAssetType {
  // 1. MIME type check (primary)
  if (isImageMimeType(mimeType)) {
    // If buffer available, validate with magic numbers
    if (buffer && buffer.length >= 4) {
      const magicMatch = matchMagicNumber(buffer);
      if (magicMatch && magicMatch.type !== 'image') {
        console.warn(
          `⚠️ MIME type ${mimeType} says image but magic number says ${magicMatch.label} (${magicMatch.type}). Trusting magic number.`
        );
        return magicMatch.type;
      }
    }
    return 'image';
  }

  if (isSpreadsheetMimeType(mimeType)) {
    return 'spreadsheet';
  }

  // 2. Extension fallback (for application/octet-stream or empty MIME)
  const ext = getExtension(filename);
  if (ext) {
    if (IMAGE_EXTENSIONS.has(ext)) {
      // Validate with magic numbers if possible
      if (buffer && buffer.length >= 4) {
        const magicMatch = matchMagicNumber(buffer);
        if (magicMatch && magicMatch.type === 'image') return 'image';
        // Extension says image but magic number disagrees — be cautious
        if (magicMatch && magicMatch.type !== 'image') {
          console.warn(
            `⚠️ Extension ${ext} says image but magic number says ${magicMatch.label}. Treating as unknown.`
          );
          return 'unknown';
        }
      }
      return 'image';
    }
    if (SPREADSHEET_EXTENSIONS.has(ext)) return 'spreadsheet';
  }

  // 3. Fallback: if MIME has a known document pattern, it's a document
  if (mimeType && mimeType !== 'application/octet-stream') {
    return 'document';
  }

  return 'unknown';
}

/**
 * Check if a MIME type represents an image
 */
export function isImageMimeType(mimeType: string): boolean {
  if (!mimeType) return false;
  const normalized = mimeType.toLowerCase().trim();
  if (IMAGE_MIME_TYPES.has(normalized)) return true;
  return IMAGE_MIME_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

/**
 * Check if a MIME type represents a spreadsheet
 */
export function isSpreadsheetMimeType(mimeType: string): boolean {
  if (!mimeType) return false;
  return SPREADSHEET_MIME_TYPES.has(mimeType.toLowerCase().trim());
}

/**
 * Match buffer against known magic number signatures
 */
function matchMagicNumber(buffer: Buffer): { type: VaultAssetType; label: string } | null {
  for (const sig of MAGIC_NUMBERS) {
    if (buffer.length < sig.bytes.length) continue;
    let match = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[i] !== sig.bytes[i]) {
        match = false;
        break;
      }
    }
    if (match) return { type: sig.type, label: sig.label };
  }
  return null;
}

/**
 * Extract lowercase file extension including the dot
 */
function getExtension(filename: string): string | null {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot < 0 || lastDot === filename.length - 1) return null;
  return filename.substring(lastDot).toLowerCase();
}
