/**
 * DOCX Text Extractor
 * Uses mammoth for reliable Word document extraction
 */

import mammoth from 'mammoth';

export interface DocxExtractionResult {
  text: string;
  messages?: string[];
}

/**
 * Extract text from a DOCX buffer
 */
export async function extractDocxText(buffer: Buffer): Promise<DocxExtractionResult> {
  console.log(`📄 Extracting DOCX text from ${buffer.length} bytes...`);

  try {
    const result = await mammoth.extractRawText({ buffer });

    const text = result.value || '';
    const messages = result.messages?.map(m => m.message) || [];

    if (messages.length > 0) {
      console.log('📝 DOCX extraction messages:', messages);
    }

    console.log(`✅ DOCX extracted: ${text.length} characters`);

    return {
      text: cleanDocxText(text),
      messages,
    };
  } catch (error) {
    console.error('❌ DOCX extraction error:', error);
    throw new Error(`DOCX extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Clean extracted DOCX text
 */
function cleanDocxText(text: string): string {
  return text
    // Normalize line endings
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Remove excessive whitespace
    .replace(/[ \t]+/g, ' ')
    // Remove excessive line breaks
    .replace(/\n{3,}/g, '\n\n')
    // Trim each line
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    // Final trim
    .trim();
}
