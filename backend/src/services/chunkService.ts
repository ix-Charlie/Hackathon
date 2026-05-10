/**
 * Text Chunking Service
 * Legal-grade document chunking with structure awareness
 * Splits documents into overlapping chunks with rich metadata
 */

import { config } from '../config/index.js';
import { TextChunk, ChunkMetadata } from '../types/index.js';

interface ChunkOptions {
  chunkSize?: number;
  overlap?: number;
  filename: string;
  // Enhanced metadata for legal documents
  documentType?: string;
  extractedMetadata?: ExtractedDocumentMetadata;
}

// Rich metadata extracted from document content
export interface ExtractedDocumentMetadata {
  document_type?: string;      // 'judgment', 'contract', 'petition', 'fir', 'cv', 'brief'
  court?: string;              // 'Supreme Court', 'High Court', etc.
  jurisdiction?: string;       // 'Pakistan', 'Punjab', etc.
  year?: number;               // Document year
  case_number?: string;        // 'PLD 2021 SC 123', etc.
  parties?: string[];          // Parties involved
  judge?: string;              // Presiding judge
  sections_referenced?: string[]; // Legal sections: '302 PPC', 'Article 184(3)'
  dates_mentioned?: string[];  // Important dates found
  names_mentioned?: string[];  // Person names found
  emails_mentioned?: string[]; // Email addresses found
  phones_mentioned?: string[]; // Phone numbers found
}

// Patterns for legal document structure detection
const LEGAL_SECTION_PATTERNS = [
  /^(?:SECTION|Section)\s+\d+/m,
  /^(?:ARTICLE|Article)\s+\d+/m,
  /^(?:CLAUSE|Clause)\s+\d+/m,
  /^(?:PART|Part)\s+[IVX\d]+/m,
  /^(?:\d+\.)\s+[A-Z]/m,  // Numbered sections
  /^(?:[IVX]+\.)\s+[A-Z]/m, // Roman numeral sections
  /^(?:ORDER|JUDGMENT|DECREE|FINDINGS|HOLDING|CONCLUSION)/im,
  /^(?:WHEREAS|NOW THEREFORE|IN WITNESS)/im,
  /^(?:PRAYER|RELIEF SOUGHT|GROUNDS)/im,
];

// Patterns to extract key metadata from text
const METADATA_PATTERNS = {
  case_number: [
    /\b(PLD\s+\d{4}\s+\w+\s+\d+)\b/gi,
    /\b(\d{4}\s+SCMR\s+\d+)\b/gi,
    /\b(CRL?\.\s*Appeal\s*No\.?\s*\d+[\/\-]\d+)\b/gi,
    /\b(Writ\s*Petition\s*No\.?\s*\d+[\/\-]\d+)\b/gi,
    /\b(FIR\s*No\.?\s*\d+[\/\-]\d+)\b/gi,
    /\b(Case\s*No\.?\s*\d+[\/\-]\d+)\b/gi,
  ],
  court: [
    /\b(Supreme\s+Court\s+of\s+\w+)\b/gi,
    /\b(High\s+Court\s+of\s+\w+)\b/gi,
    /\b(District\s+Court)\b/gi,
    /\b(Sessions\s+Court)\b/gi,
    /\b(Civil\s+Court)\b/gi,
    /\b(Family\s+Court)\b/gi,
    /\b(National\s+Accountability\s+Bureau|NAB)\b/gi,
  ],
  section_references: [
    /\b(Section\s+\d+[A-Z]?\s*(?:of\s+)?(?:PPC|Cr\.?P\.?C|CPC|IPC)?)\b/gi,
    /\b(\d+\s*PPC)\b/gi,
    /\b(Article\s+\d+\s*\(\d+\))\b/gi,
    /\b(Order\s+[IVXL]+\s*Rule\s*\d+)\b/gi,
  ],
  year: [
    /\b(19\d{2}|20\d{2})\b/g,
  ],
  email: [
    /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/gi,
  ],
  phone: [
    /\b(\+?\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9})\b/g,
  ],
  names: [
    // Common name patterns - Mr./Mrs./Ms./Dr. followed by name
    /\b((?:Mr\.|Mrs\.|Ms\.|Dr\.|Justice|Hon['']ble)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/g,
  ],
};

/**
 * Split text into overlapping chunks with smart boundaries
 * Tries to break at sentence or paragraph boundaries when possible
 */
export function chunkText(text: string, options: ChunkOptions): TextChunk[] {
  const {
    chunkSize = config.processing.chunkSize,
    overlap = config.processing.chunkOverlap,
    filename,
  } = options;

  const chunks: TextChunk[] = [];

  if (!text || text.length === 0) {
    return [];
  }

  // Clean the text
  const cleanedText = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // For small texts, return as single chunk
  if (cleanedText.length <= chunkSize) {
    return [{
      content: cleanedText,
      metadata: {
        filename,
        chunk_index: 0,
        total_chunks: 1,
        start_char: 0,
        end_char: cleanedText.length,
      },
    }];
  }

  // Split by paragraphs first, then by sentences
  const paragraphs = cleanedText.split(/\n\n+/);
  
  let currentChunk = '';
  let startChar = 0;
  let chunkIndex = 0;
  let charPosition = 0;

  for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
    const paragraph = paragraphs[pIdx];
    
    // If adding this paragraph exceeds chunk size
    if (currentChunk.length + paragraph.length > chunkSize && currentChunk.length > 0) {
      // Save current chunk
      chunks.push(createChunk(currentChunk, filename, chunkIndex, startChar));
      chunkIndex++;

      // Calculate overlap - take last N characters
      const overlapText = getOverlapText(currentChunk, overlap);
      startChar = charPosition - overlapText.length;
      currentChunk = overlapText;
    }

    // If paragraph itself is too long, split by sentences
    if (paragraph.length > chunkSize) {
      const sentences = splitIntoSentences(paragraph);
      
      for (const sentence of sentences) {
        if (currentChunk.length + sentence.length > chunkSize && currentChunk.length > 0) {
          chunks.push(createChunk(currentChunk, filename, chunkIndex, startChar));
          chunkIndex++;

          const overlapText = getOverlapText(currentChunk, overlap);
          startChar = charPosition - overlapText.length;
          currentChunk = overlapText + (currentChunk.endsWith(' ') ? '' : ' ');
        }

        currentChunk += (currentChunk && !currentChunk.endsWith(' ') ? ' ' : '') + sentence;
        charPosition += sentence.length + 1;
      }
    } else {
      // Add paragraph to current chunk
      if (currentChunk) {
        currentChunk += '\n\n';
        charPosition += 2;
      }
      currentChunk += paragraph;
      charPosition += paragraph.length;
    }
  }

  // Add final chunk
  if (currentChunk.trim()) {
    chunks.push(createChunk(currentChunk.trim(), filename, chunkIndex, startChar));
  }

  // Update total_chunks count
  const totalChunks = chunks.length;
  chunks.forEach(chunk => {
    chunk.metadata.total_chunks = totalChunks;
  });

  console.log(`📦 Created ${chunks.length} chunks from ${cleanedText.length} characters`);
  return chunks;
}

/**
 * Split text into sentences
 */
function splitIntoSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by space or end
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.filter(s => s.trim().length > 0);
}

/**
 * Get overlap text from the end of a chunk
 * Tries to break at word boundaries
 */
function getOverlapText(text: string, overlapSize: number): string {
  if (text.length <= overlapSize) {
    return text;
  }

  // Get last N characters
  let overlap = text.slice(-overlapSize);
  
  // Try to start at a word boundary
  const firstSpace = overlap.indexOf(' ');
  if (firstSpace > 0 && firstSpace < overlapSize / 2) {
    overlap = overlap.slice(firstSpace + 1);
  }

  return overlap;
}

/**
 * Create a text chunk with metadata
 */
function createChunk(
  content: string,
  filename: string,
  chunkIndex: number,
  startChar: number
): TextChunk {
  return {
    content: content.trim(),
    metadata: {
      filename,
      chunk_index: chunkIndex,
      total_chunks: 0, // Will be updated after all chunks are created
      start_char: startChar,
      end_char: startChar + content.length,
    },
  };
}

/**
 * Estimate token count for a text
 * Rough approximation: ~4 characters per token for English text
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Calculate optimal chunk size based on token limits
 * OpenAI embeddings have 8191 token limit
 */
export function getOptimalChunkSize(maxTokens: number = 2000): number {
  // Leave some buffer
  return Math.floor((maxTokens - 100) * 4);
}

/**
 * Extract rich metadata from document text
 * This enables precise filtering and better retrieval
 */
export function extractDocumentMetadata(text: string, filename: string): ExtractedDocumentMetadata {
  const metadata: ExtractedDocumentMetadata = {};
  
  // Detect document type from filename and content
  metadata.document_type = detectDocumentType(filename, text);
  
  // Extract case numbers
  const caseNumbers: string[] = [];
  for (const pattern of METADATA_PATTERNS.case_number) {
    const matches = text.match(pattern);
    if (matches) caseNumbers.push(...matches);
  }
  if (caseNumbers.length > 0) {
    metadata.case_number = [...new Set(caseNumbers)][0]; // Take first unique
  }
  
  // Extract court
  for (const pattern of METADATA_PATTERNS.court) {
    const match = text.match(pattern);
    if (match) {
      metadata.court = match[1];
      break;
    }
  }
  
  // Extract section references
  const sections: string[] = [];
  for (const pattern of METADATA_PATTERNS.section_references) {
    const matches = text.match(pattern);
    if (matches) sections.push(...matches);
  }
  if (sections.length > 0) {
    metadata.sections_referenced = [...new Set(sections)].slice(0, 20);
  }
  
  // Extract year (most recent plausible year)
  const years: number[] = [];
  for (const pattern of METADATA_PATTERNS.year) {
    const matches = text.match(pattern);
    if (matches) {
      years.push(...matches.map(y => parseInt(y)));
    }
  }
  if (years.length > 0) {
    // Filter to reasonable years and take most common or most recent
    const validYears = years.filter(y => y >= 1900 && y <= new Date().getFullYear() + 1);
    if (validYears.length > 0) {
      metadata.year = Math.max(...validYears);
    }
  }
  
  // Extract emails
  const emails: string[] = [];
  for (const pattern of METADATA_PATTERNS.email) {
    const matches = text.match(pattern);
    if (matches) emails.push(...matches);
  }
  if (emails.length > 0) {
    metadata.emails_mentioned = [...new Set(emails.map(e => e.toLowerCase()))];
  }
  
  // Extract phone numbers
  const phones: string[] = [];
  for (const pattern of METADATA_PATTERNS.phone) {
    const matches = text.match(pattern);
    if (matches) phones.push(...matches.filter(p => p.replace(/\D/g, '').length >= 7));
  }
  if (phones.length > 0) {
    metadata.phones_mentioned = [...new Set(phones)].slice(0, 10);
  }
  
  // Extract names
  const names: string[] = [];
  for (const pattern of METADATA_PATTERNS.names) {
    const matches = text.match(pattern);
    if (matches) names.push(...matches);
  }
  if (names.length > 0) {
    metadata.names_mentioned = [...new Set(names)].slice(0, 20);
  }
  
  // Detect jurisdiction from content
  if (text.match(/\b(Pakistan|Pakistani)\b/i)) {
    metadata.jurisdiction = 'Pakistan';
  } else if (text.match(/\b(Punjab|Lahore)\b/i)) {
    metadata.jurisdiction = 'Punjab, Pakistan';
  } else if (text.match(/\b(Sindh|Karachi)\b/i)) {
    metadata.jurisdiction = 'Sindh, Pakistan';
  }
  
  console.log(`📋 Extracted metadata:`, {
    document_type: metadata.document_type,
    case_number: metadata.case_number,
    court: metadata.court,
    year: metadata.year,
    emails: metadata.emails_mentioned?.length || 0,
    names: metadata.names_mentioned?.length || 0,
  });
  
  return metadata;
}

/**
 * Detect document type from filename and content
 */
function detectDocumentType(filename: string, text: string): string {
  const lowerFilename = filename.toLowerCase();
  const lowerText = text.toLowerCase().substring(0, 5000); // Check first 5000 chars
  
  // Check filename first
  if (lowerFilename.includes('cv') || lowerFilename.includes('resume')) return 'cv';
  if (lowerFilename.includes('contract')) return 'contract';
  if (lowerFilename.includes('agreement')) return 'contract';
  if (lowerFilename.includes('judgment') || lowerFilename.includes('judgement')) return 'judgment';
  if (lowerFilename.includes('petition')) return 'petition';
  if (lowerFilename.includes('fir')) return 'fir';
  if (lowerFilename.includes('brief')) return 'brief';
  if (lowerFilename.includes('affidavit')) return 'affidavit';
  if (lowerFilename.includes('notice')) return 'notice';
  
  // Check content patterns
  if (lowerText.includes('curriculum vitae') || lowerText.includes('work experience') || 
      lowerText.includes('education') && lowerText.includes('skills')) return 'cv';
  if (lowerText.includes('judgment') || lowerText.includes('order of the court') ||
      lowerText.includes('it is hereby ordered')) return 'judgment';
  if (lowerText.includes('first information report') || lowerText.includes('f.i.r')) return 'fir';
  if (lowerText.includes('petition under') || lowerText.includes('writ petition')) return 'petition';
  if (lowerText.includes('whereas') && lowerText.includes('now therefore')) return 'contract';
  if (lowerText.includes('affidavit') && lowerText.includes('solemnly affirm')) return 'affidavit';
  
  return 'document'; // Generic
}

/**
 * Enhanced chunking with metadata extraction
 * Extracts metadata once and attaches to all chunks
 */
export function chunkTextWithMetadata(text: string, options: ChunkOptions): TextChunk[] {
  // Extract document-level metadata
  const docMetadata = extractDocumentMetadata(text, options.filename);
  
  // Get chunks using standard chunking
  const chunks = chunkText(text, options);
  
  // Enhance each chunk's metadata with document-level metadata
  for (const chunk of chunks) {
    chunk.metadata = {
      ...chunk.metadata,
      document_type: docMetadata.document_type,
      court: docMetadata.court,
      jurisdiction: docMetadata.jurisdiction,
      year: docMetadata.year,
      case_number: docMetadata.case_number,
      sections_referenced: docMetadata.sections_referenced,
      names_mentioned: docMetadata.names_mentioned,
      emails_mentioned: docMetadata.emails_mentioned,
      phones_mentioned: docMetadata.phones_mentioned,
    };
    
    // Also extract chunk-specific mentions (for granular search)
    const chunkEmails = extractPatternMatches(chunk.content, METADATA_PATTERNS.email);
    const chunkNames = extractPatternMatches(chunk.content, METADATA_PATTERNS.names);
    if (chunkEmails.length > 0) {
      chunk.metadata.chunk_emails = chunkEmails;
    }
    if (chunkNames.length > 0) {
      chunk.metadata.chunk_names = chunkNames;
    }
  }
  
  return chunks;
}

/**
 * Helper to extract pattern matches from text
 */
function extractPatternMatches(text: string, patterns: RegExp[]): string[] {
  const matches: string[] = [];
  for (const pattern of patterns) {
    const found = text.match(pattern);
    if (found) matches.push(...found);
  }
  return [...new Set(matches)];
}
