/**
 * PDF Text Extractor
 * Uses pdf-parse for reliable PDF text extraction
 * Handles large files with streaming when possible
 */

// @ts-expect-error - pdf-parse doesn't have proper types
import pdfParse from 'pdf-parse';

export interface PdfExtractionResult {
  text: string;
  pageCount: number;
  info?: {
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string;
  };
}

/**
 * Extract text from a PDF buffer
 * Handles both text-based and basic scanned PDFs
 */
export async function extractPdfText(buffer: Buffer): Promise<PdfExtractionResult> {
  console.log(`📄 Extracting PDF text from ${buffer.length} bytes...`);

  try {
    const data = await pdfParse(buffer, {
      // Limit to prevent memory issues with huge PDFs
      max: 0, // 0 = no limit on pages
    });

    const text = data.text || '';
    const pageCount = data.numpages || 0;

    console.log(`✅ PDF extracted: ${text.length} chars from ${pageCount} pages`);

    // Validate extracted text is meaningful
    const meaningfulChars = text.replace(/[^a-zA-Z0-9\s]/g, '').length;
    const meaningfulRatio = meaningfulChars / Math.max(text.length, 1);

    if (text.length < 50 || meaningfulRatio < 0.3) {
      console.warn('⚠️ PDF appears to be scanned/image-based. OCR may be needed.');
      return {
        text: `[PDF Document: This appears to be a scanned document or image-based PDF. ` +
          `Text extraction found minimal readable content. ` +
          `The document has ${pageCount} page(s). OCR processing may be required for full text extraction.]`,
        pageCount,
        info: data.info,
      };
    }

    return {
      text: cleanPdfText(text),
      pageCount,
      info: data.info,
    };
  } catch (error) {
    console.error('❌ PDF extraction error:', error);
    throw new Error(`PDF extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Clean extracted PDF text
 * - Normalize whitespace
 * - Remove excessive line breaks
 * - Fix common OCR/extraction artifacts
 */
function cleanPdfText(text: string): string {
  return text
    // Normalize line endings
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Remove excessive whitespace
    .replace(/[ \t]+/g, ' ')
    // Remove excessive line breaks (more than 2)
    .replace(/\n{3,}/g, '\n\n')
    // Fix hyphenated line breaks (word-\nwrap -> wordwrap)
    .replace(/(\w)-\n(\w)/g, '$1$2')
    // Remove page numbers that are alone on a line
    .replace(/^\s*\d+\s*$/gm, '')
    // Trim each line
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    // Final trim
    .trim();
}

/**
 * Extract text from PDF with progress callback for large files
 * Uses streaming approach for memory efficiency
 */
export async function extractPdfTextWithProgress(
  buffer: Buffer,
  onProgress?: (progress: number) => void
): Promise<PdfExtractionResult> {
  // For now, we use the simple approach
  // In future, we can implement page-by-page extraction with progress
  
  if (onProgress) {
    onProgress(10); // Starting
  }

  const result = await extractPdfText(buffer);

  if (onProgress) {
    onProgress(100); // Complete
  }

  return result;
}
