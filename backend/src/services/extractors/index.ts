/**
 * Document Extractor - Main entry point
 * Routes to appropriate extractor based on file type
 */

import { extractPdfText, extractPdfTextWithProgress } from './pdf.js';
import { extractDocxText } from './docx.js';
import { extractXlsxText, extractCsvText } from './xlsx.js';
import { extractPlainText } from './text.js';
import { extractMsgText } from './msg.js';

export interface ExtractionResult {
  text: string;
  metadata?: Record<string, unknown>;
}

/**
 * Supported MIME types and their extractors
 */
const MIME_TYPE_MAP: Record<string, 'pdf' | 'docx' | 'xlsx' | 'csv' | 'msg' | 'text'> = {
  // PDF
  'application/pdf': 'pdf',

  // Word Documents
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'docx', // .doc (limited support)

  // Excel/Spreadsheets
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xlsx',

  // MSG (Outlook email)
  'application/vnd.ms-outlook': 'msg',

  // CSV
  'text/csv': 'csv',
  'application/csv': 'csv',

  // Plain text
  'text/plain': 'text',
  'text/markdown': 'text',
  'text/html': 'text',
  'text/xml': 'text',
  'application/json': 'text',
  'application/xml': 'text',
  'application/javascript': 'text',
  'text/javascript': 'text',
  'text/css': 'text',
};

/**
 * File extension to extractor mapping (fallback)
 */
const EXTENSION_MAP: Record<string, 'pdf' | 'docx' | 'xlsx' | 'csv' | 'msg' | 'text'> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.doc': 'docx',
  '.xlsx': 'xlsx',
  '.xls': 'xlsx',
  '.msg': 'msg',
  '.csv': 'csv',
  '.txt': 'text',
  '.md': 'text',
  '.markdown': 'text',
  '.json': 'text',
  '.xml': 'text',
  '.html': 'text',
  '.htm': 'text',
  '.js': 'text',
  '.ts': 'text',
  '.jsx': 'text',
  '.tsx': 'text',
  '.css': 'text',
  '.scss': 'text',
  '.less': 'text',
  '.py': 'text',
  '.rb': 'text',
  '.java': 'text',
  '.c': 'text',
  '.cpp': 'text',
  '.h': 'text',
  '.go': 'text',
  '.rs': 'text',
  '.sql': 'text',
  '.yaml': 'text',
  '.yml': 'text',
  '.ini': 'text',
  '.conf': 'text',
  '.log': 'text',
};

/**
 * Get the extractor type for a file
 */
function getExtractorType(
  filename: string,
  mimeType?: string
): 'pdf' | 'docx' | 'xlsx' | 'csv' | 'msg' | 'text' | null {
  // Try MIME type first
  if (mimeType && MIME_TYPE_MAP[mimeType]) {
    return MIME_TYPE_MAP[mimeType];
  }

  // Fall back to extension
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (ext && EXTENSION_MAP[ext]) {
    return EXTENSION_MAP[ext];
  }

  // Try to detect from MIME type prefix
  if (mimeType?.startsWith('text/')) {
    return 'text';
  }

  return null;
}

/**
 * Extract text from a document buffer
 * Automatically detects file type and uses appropriate extractor
 */
export async function extractDocument(
  buffer: Buffer,
  filename: string,
  mimeType?: string,
  onProgress?: (progress: number) => void
): Promise<ExtractionResult> {
  console.log(`📄 Extracting document: ${filename} (${mimeType || 'unknown type'})`);

  const extractorType = getExtractorType(filename, mimeType);

  if (!extractorType) {
    throw new Error(
      `Unsupported file type: ${mimeType || 'unknown'}. ` +
      `Supported types: PDF, DOCX, XLSX, CSV, MSG (Outlook email), and plain text files.`
    );
  }

  switch (extractorType) {
    case 'pdf': {
      const result = onProgress
        ? await extractPdfTextWithProgress(buffer, onProgress)
        : await extractPdfText(buffer);
      return {
        text: result.text,
        metadata: {
          pageCount: result.pageCount,
          ...result.info,
        },
      };
    }

    case 'docx': {
      const result = await extractDocxText(buffer);
      if (onProgress) onProgress(100);
      return {
        text: result.text,
        metadata: { messages: result.messages },
      };
    }

    case 'xlsx': {
      const result = await extractXlsxText(buffer);
      if (onProgress) onProgress(100);
      return {
        text: result.text,
        metadata: {
          sheetCount: result.sheetCount,
          sheetNames: result.sheetNames,
        },
      };
    }

    case 'csv': {
      const text = await extractCsvText(buffer);
      if (onProgress) onProgress(100);
      return { text };
    }

    case 'msg': {
      const result = await extractMsgText(buffer);
      if (onProgress) onProgress(100);
      return {
        text: result.text,
        metadata: {
          subject: result.subject,
          from: result.from,
          to: result.to,
          cc: result.cc,
          bcc: result.bcc,
          date: result.date,
          attachmentCount: result.attachments.length,
          attachmentNames: result.attachments.map(a => a.filename),
        },
      };
    }

    case 'text': {
      const result = await extractPlainText(buffer, mimeType);
      if (onProgress) onProgress(100);
      return {
        text: result.text,
        metadata: { encoding: result.encoding },
      };
    }

    default:
      throw new Error(`Unknown extractor type: ${extractorType}`);
  }
}

/**
 * Check if a file type is supported for extraction
 */
export function isSupported(filename: string, mimeType?: string): boolean {
  return getExtractorType(filename, mimeType) !== null;
}

/**
 * Get list of supported file extensions
 */
export function getSupportedExtensions(): string[] {
  return Object.keys(EXTENSION_MAP);
}

/**
 * Get list of supported MIME types
 */
export function getSupportedMimeTypes(): string[] {
  return Object.keys(MIME_TYPE_MAP);
}
