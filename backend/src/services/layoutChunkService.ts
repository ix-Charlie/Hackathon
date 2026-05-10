/**
 * Layout-Aware Chunking Service
 * Chunks documents by structural boundaries (sections, tables, headings) instead of
 * arbitrary character counts. Each chunk carries rich metadata for section-specific RAG retrieval.
 */

import { StructuralElement, StructuralElementType } from './extractors/pdfLayout.js';
import { config } from '../config/index.js';

// ── Types ──

export interface LayoutChunk {
  content: string;
  metadata: LayoutChunkMetadata;
}

export interface LayoutChunkMetadata {
  filename: string;
  chunk_index: number;
  total_chunks: number;
  start_char: number;
  end_char: number;
  /** Page number where this chunk primarily lives */
  page_number: number;
  /** The section heading this chunk belongs to (e.g., "THE CHILD(REN)") */
  section_name: string | null;
  /** Heading level: 1 = top, 2 = sub */
  heading_level?: number;
  /** For table rows within a chunk */
  row_index?: number;
  /** Element type: text, table_row, heading, list_item, checkbox */
  element_type: string;
  /** All page numbers covered by this chunk */
  pages_covered: number[];
  // Standard legal metadata (populated by caller)
  document_type?: string;
  court?: string;
  jurisdiction?: string;
  year?: number;
  case_number?: string;
  sections_referenced?: string[];
  names_mentioned?: string[];
  emails_mentioned?: string[];
  phones_mentioned?: string[];
  chunk_emails?: string[];
  chunk_names?: string[];
}

// ── Constants ──

const DEFAULT_CHUNK_SIZE = 2000;
const DEFAULT_OVERLAP = 300;

// ── Main Function ──

/**
 * Convert structural elements from layout extraction into section-aware chunks.
 * Chunks never cross section boundaries. Tables and repeated fields are kept together.
 */
export function chunkByLayout(
  elements: StructuralElement[],
  filename: string,
  options?: { chunkSize?: number; overlap?: number }
): LayoutChunk[] {
  const chunkSize = options?.chunkSize || config.processing.chunkSize || DEFAULT_CHUNK_SIZE;
  const overlap = options?.overlap || Math.min(config.processing.chunkOverlap || DEFAULT_OVERLAP, 300);

  if (elements.length === 0) return [];

  // Step 1: Group elements by section
  const sectionGroups = groupBySection(elements);

  // Step 2: For each section, create chunks that respect structural boundaries
  const allChunks: LayoutChunk[] = [];
  let globalCharOffset = 0;

  for (const group of sectionGroups) {
    const sectionChunks = chunkSection(group, chunkSize, overlap, filename, globalCharOffset);
    allChunks.push(...sectionChunks);
    // Advance char offset
    for (const el of group.elements) {
      globalCharOffset += el.text.length + 1; // +1 for newline
    }
  }

  // Step 3: Assign global chunk indices
  for (let i = 0; i < allChunks.length; i++) {
    allChunks[i].metadata.chunk_index = i;
    allChunks[i].metadata.total_chunks = allChunks.length;
  }

  console.log(`📦 Layout chunking: ${allChunks.length} chunks from ${elements.length} elements across ${sectionGroups.length} sections`);
  return allChunks;
}

// ── Grouping ──

interface SectionGroup {
  sectionName: string | null;
  headingLevel: number | undefined;
  elements: StructuralElement[];
}

function groupBySection(elements: StructuralElement[]): SectionGroup[] {
  const groups: SectionGroup[] = [];
  let current: SectionGroup | null = null;

  for (const el of elements) {
    // Start a new group on heading/subheading
    if (el.type === 'heading' || el.type === 'subheading') {
      if (current && current.elements.length > 0) {
        groups.push(current);
      }
      current = {
        sectionName: el.sectionName,
        headingLevel: el.headingLevel,
        elements: [el],
      };
    } else {
      if (!current) {
        current = { sectionName: el.sectionName, headingLevel: undefined, elements: [] };
      }
      current.elements.push(el);
    }
  }

  if (current && current.elements.length > 0) {
    groups.push(current);
  }

  return groups;
}

// ── Section Chunking ──

function chunkSection(
  group: SectionGroup,
  chunkSize: number,
  overlap: number,
  filename: string,
  charOffset: number
): LayoutChunk[] {
  const chunks: LayoutChunk[] = [];
  const elements = group.elements;

  // Separate tables from text elements for special handling
  const tableBlocks = extractTableBlocks(elements);
  const nonTableElements = elements.filter(el => el.type !== 'table_row');

  // Process table blocks as dedicated chunks
  for (const block of tableBlocks) {
    const tableText = block.rows.map(r => r.text).join('\n');
    if (tableText.trim().length === 0) continue;

    const pages = [...new Set(block.rows.map(r => r.pageNumber))];

    // If table is small enough, single chunk
    if (tableText.length <= chunkSize) {
      chunks.push({
        content: buildChunkContent(group.sectionName, 'table', tableText),
        metadata: {
          filename,
          chunk_index: 0, // will be reassigned
          total_chunks: 0,
          start_char: charOffset,
          end_char: charOffset + tableText.length,
          page_number: pages[0] || 1,
          section_name: group.sectionName,
          heading_level: group.headingLevel,
          row_index: block.startRowIndex,
          element_type: 'table',
          pages_covered: pages,
        },
      });
    } else {
      // Split large table into row-groups
      let rowGroup = '';
      let rowGroupStart = charOffset;
      let rowGroupPages: number[] = [];
      let firstRowIdx = block.startRowIndex;

      for (let i = 0; i < block.rows.length; i++) {
        const row = block.rows[i];
        if (rowGroup.length + row.text.length > chunkSize && rowGroup.length > 0) {
          chunks.push({
            content: buildChunkContent(group.sectionName, 'table', rowGroup),
            metadata: {
              filename,
              chunk_index: 0,
              total_chunks: 0,
              start_char: rowGroupStart,
              end_char: rowGroupStart + rowGroup.length,
              page_number: rowGroupPages[0] || 1,
              section_name: group.sectionName,
              heading_level: group.headingLevel,
              row_index: firstRowIdx,
              element_type: 'table',
              pages_covered: [...new Set(rowGroupPages)],
            },
          });
          // Overlap: keep last row
          rowGroup = row.text;
          rowGroupStart = charOffset;
          rowGroupPages = [row.pageNumber];
          firstRowIdx = block.startRowIndex + i;
        } else {
          if (rowGroup) rowGroup += '\n';
          rowGroup += row.text;
          rowGroupPages.push(row.pageNumber);
        }
        charOffset += row.text.length + 1;
      }

      if (rowGroup.trim()) {
        chunks.push({
          content: buildChunkContent(group.sectionName, 'table', rowGroup),
          metadata: {
            filename,
            chunk_index: 0,
            total_chunks: 0,
            start_char: rowGroupStart,
            end_char: rowGroupStart + rowGroup.length,
            page_number: rowGroupPages[0] || 1,
            section_name: group.sectionName,
            heading_level: group.headingLevel,
            row_index: firstRowIdx,
            element_type: 'table',
            pages_covered: [...new Set(rowGroupPages)],
          },
        });
      }
    }
  }

  // Process non-table elements with overlap-based chunking
  if (nonTableElements.length > 0) {
    let currentText = '';
    let currentPages: number[] = [];
    let currentStartChar = charOffset;
    let currentElementTypes = new Set<string>();

    for (let i = 0; i < nonTableElements.length; i++) {
      const el = nonTableElements[i];
      const elText = el.text;

      if (currentText.length + elText.length > chunkSize && currentText.length > 0) {
        // Flush current chunk
        const primaryType = getPrimaryType(currentElementTypes);
        chunks.push({
          content: buildChunkContent(group.sectionName, primaryType, currentText),
          metadata: {
            filename,
            chunk_index: 0,
            total_chunks: 0,
            start_char: currentStartChar,
            end_char: currentStartChar + currentText.length,
            page_number: currentPages[0] || 1,
            section_name: group.sectionName,
            heading_level: group.headingLevel,
            element_type: primaryType,
            pages_covered: [...new Set(currentPages)],
          },
        });

        // Overlap: keep last portion of text
        const overlapText = getOverlapFromEnd(currentText, overlap);
        currentText = overlapText;
        currentStartChar = charOffset - overlapText.length;
        currentPages = [el.pageNumber];
        currentElementTypes = new Set();
      }

      // Append
      if (currentText) currentText += '\n';
      currentText += elText;
      currentPages.push(el.pageNumber);
      currentElementTypes.add(el.type);
      charOffset += elText.length + 1;
    }

    // Flush remaining
    if (currentText.trim()) {
      const primaryType = getPrimaryType(currentElementTypes);
      chunks.push({
        content: buildChunkContent(group.sectionName, primaryType, currentText),
        metadata: {
          filename,
          chunk_index: 0,
          total_chunks: 0,
          start_char: currentStartChar,
          end_char: currentStartChar + currentText.length,
          page_number: currentPages[0] || 1,
          section_name: group.sectionName,
          heading_level: group.headingLevel,
          element_type: primaryType,
          pages_covered: [...new Set(currentPages)],
        },
      });
    }
  }

  return chunks;
}

// ── Table Block Extraction ──

interface TableBlock {
  rows: StructuralElement[];
  startRowIndex: number;
}

function extractTableBlocks(elements: StructuralElement[]): TableBlock[] {
  const blocks: TableBlock[] = [];
  let currentBlock: StructuralElement[] | null = null;
  let startIdx = 0;

  for (const el of elements) {
    if (el.type === 'table_row') {
      if (!currentBlock) {
        currentBlock = [];
        startIdx = el.rowIndex || 0;
      }
      currentBlock.push(el);
    } else {
      if (currentBlock && currentBlock.length > 0) {
        blocks.push({ rows: currentBlock, startRowIndex: startIdx });
        currentBlock = null;
      }
    }
  }

  if (currentBlock && currentBlock.length > 0) {
    blocks.push({ rows: currentBlock, startRowIndex: startIdx });
  }

  return blocks;
}

// ── Helpers ──

/**
 * Prefix chunk content with section context so embeddings capture section semantics.
 */
function buildChunkContent(sectionName: string | null, elementType: string, text: string): string {
  const parts: string[] = [];
  if (sectionName) {
    parts.push(`[Section: ${sectionName}]`);
  }
  if (elementType === 'table') {
    parts.push('[Table Data]');
  }
  if (parts.length > 0) {
    return parts.join(' ') + '\n' + text;
  }
  return text;
}

function getPrimaryType(types: Set<string>): string {
  if (types.has('heading')) return 'heading';
  if (types.has('subheading')) return 'subheading';
  if (types.has('list_item')) return 'list';
  if (types.has('checkbox')) return 'checkbox';
  return 'text';
}

function getOverlapFromEnd(text: string, size: number): string {
  if (text.length <= size) return text;
  let overlap = text.slice(-size);
  // Try to start at a word boundary
  const space = overlap.indexOf(' ');
  if (space > 0 && space < size / 2) {
    overlap = overlap.slice(space + 1);
  }
  return overlap;
}
