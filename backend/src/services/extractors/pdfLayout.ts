/**
 * Layout-Aware PDF Extractor
 * Uses pdfjs-dist to extract text with page numbers, positions, and font metadata.
 * Detects headings, sections, tables, and structural elements for section-aware chunking.
 */

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdfjs-dist/legacy/build/pdf.worker.mjs';

// ── Types ──

export interface LayoutTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string;
  fontSize: number;
  isBold: boolean;
  pageNumber: number;
}

export interface LayoutLine {
  text: string;
  pageNumber: number;
  y: number;
  fontSize: number;
  isBold: boolean;
  items: LayoutTextItem[];
}

export type StructuralElementType = 'heading' | 'subheading' | 'table_row' | 'list_item' | 'checkbox' | 'text' | 'page_break';

export interface StructuralElement {
  type: StructuralElementType;
  text: string;
  pageNumber: number;
  /** Detected section name this element belongs to */
  sectionName: string | null;
  /** For tables: row index within the table */
  rowIndex?: number;
  /** Heading level: 1 = top-level, 2 = sub-heading, etc. */
  headingLevel?: number;
  /** Y position on page for ordering */
  y: number;
  fontSize: number;
}

export interface LayoutExtractionResult {
  elements: StructuralElement[];
  pageCount: number;
  /** All detected section names in order */
  sectionNames: string[];
  info?: {
    title?: string;
    author?: string;
    subject?: string;
  };
}

// ── Heading / Section Detection Patterns ──

const FORM_SECTION_PATTERNS = [
  /^(?:PART|Part)\s+[A-Z0-9IVX]+[\s:.\-]/,
  /^(?:SECTION|Section)\s+\d+/,
  /^(?:SCHEDULE|Schedule)\s+[A-Z0-9]+/,
  /^\d+\.\s+[A-Z][A-Z\s]{3,}/,           // "1. APPLICANT INFORMATION"
  /^[IVX]+\.\s+[A-Z]/,                     // "III. CLAIMS"
  /^[A-Z][A-Z\s,()]{5,}$/,                 // ALL-CAPS line ≥ 6 chars (likely heading)
  /^(?:THE\s+)?(?:APPLICANT|RESPONDENT|CHILD(?:REN)?|CLAIM|ORDER|RELIEF|PRAYER|FACTS|GROUNDS|COURT|WITNESS|AFFIDAVIT)/i,
  /^(?:CLAIM\s+BY|CLAIMS?\s+OF|ORDER\s+SOUGHT|DETAILS\s+OF|INFORMATION\s+ABOUT)/i,
  /^(?:BACKGROUND|INTRODUCTION|SUMMARY|CONCLUSION|SUBMISSIONS?|ARGUMENT)/i,
  /^(?:APPLICATION|NOTICE|DECLARATION|CERTIFICATE)/i,
];

const TABLE_INDICATORS = [
  /\t/,                                     // Tab-separated
  /\s{3,}/,                                 // Multiple spaces (column alignment)
  /^[\s]*[\w\s]+:\s+[\w\s]+$/,             // "Field: Value" pattern
  /^\|.*\|$/,                               // Pipe-delimited
  /^[-─═]+$/,                               // Horizontal rules
];

const LIST_PATTERNS = [
  /^\s*[•●○▪▸►◆]\s+/,                     // Bullet points
  /^\s*[-–—]\s+/,                           // Dashes as bullets
  /^\s*\([a-z]\)\s+/i,                      // (a) (b) (c)
  /^\s*[a-z]\)\s+/i,                        // a) b) c)
  /^\s*\d+\)\s+/,                           // 1) 2) 3)
];

const CHECKBOX_PATTERNS = [
  /^\s*[☐☑✓✗✘□■◻◼]\s*/,                   // Unicode checkboxes
  /^\s*\[\s*[xX✓]?\s*\]\s*/,               // [x] or [ ]
];

// ── Main Extraction ──

/**
 * Extract structured layout elements from a PDF buffer.
 * Returns an ordered list of structural elements with section assignments.
 */
export async function extractPdfLayout(buffer: Buffer): Promise<LayoutExtractionResult> {
  console.log(`📐 Layout-aware PDF extraction from ${buffer.length} bytes...`);

  const uint8Array = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({ data: uint8Array, useSystemFonts: true });
  const pdf = await loadingTask.promise;
  const pageCount = pdf.numPages;

  // Get document info
  const meta = await pdf.getMetadata().catch(() => null);
  const info = meta?.info as Record<string, string> | undefined;

  // Step 1: Extract raw text items with positions from every page
  const allLines: LayoutLine[] = [];
  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1.0 });
    const pageHeight = viewport.height;

    // Group text items into lines by Y position (items within 3pt are same line)
    const lineMap = new Map<number, LayoutTextItem[]>();

    for (const item of textContent.items as any[]) {
      if (!item.str || item.str.trim().length === 0) continue;

      const [, , , , tx, ty] = item.transform || [0, 0, 0, 0, 0, 0];
      // Invert Y so top of page is 0
      const y = pageHeight - ty;
      const fontSize = Math.abs(item.transform?.[0] || item.height || 12);
      const fontName = item.fontName || '';
      const isBold = /bold/i.test(fontName) || /Black/i.test(fontName);

      const textItem: LayoutTextItem = {
        text: item.str,
        x: tx,
        y,
        width: item.width || 0,
        height: item.height || fontSize,
        fontName,
        fontSize,
        isBold,
        pageNumber: pageNum,
      };

      // Bucket into lines (round Y to nearest 3pt)
      const lineKey = Math.round(y / 3) * 3;
      if (!lineMap.has(lineKey)) lineMap.set(lineKey, []);
      lineMap.get(lineKey)!.push(textItem);
    }

    // Sort lines top-to-bottom, items left-to-right within each line
    const sortedKeys = Array.from(lineMap.keys()).sort((a, b) => a - b);
    for (const key of sortedKeys) {
      const items = lineMap.get(key)!.sort((a, b) => a.x - b.x);
      const lineText = items.map(i => i.text).join(' ').trim();
      if (!lineText) continue;

      const maxFontSize = Math.max(...items.map(i => i.fontSize));
      const anyBold = items.some(i => i.isBold);

      allLines.push({
        text: lineText,
        pageNumber: pageNum,
        y: key,
        fontSize: maxFontSize,
        isBold: anyBold,
        items,
      });
    }
  }

  if (allLines.length === 0) {
    console.warn('⚠️ No text items found — PDF may be scanned');
    return { elements: [], pageCount, sectionNames: [], info: info ? { title: info.Title, author: info.Author, subject: info.Subject } : undefined };
  }

  // Step 2: Compute statistics for heading detection
  const fontSizes = allLines.map(l => l.fontSize);
  const medianFontSize = getMedian(fontSizes);
  const maxFontSize = Math.max(...fontSizes);

  // Step 3: Classify each line into a structural element
  const elements: StructuralElement[] = [];
  let currentSection: string | null = null;
  let tableRowIndex = 0;
  let inTable = false;

  for (const line of allLines) {
    const trimmed = line.text.trim();
    if (!trimmed) continue;

    const classification = classifyLine(line, medianFontSize, maxFontSize);

    if (classification.type === 'heading' || classification.type === 'subheading') {
      currentSection = normalizeHeading(trimmed);
      inTable = false;
      tableRowIndex = 0;
    }

    if (classification.type === 'table_row') {
      if (!inTable) { inTable = true; tableRowIndex = 0; }
      classification.rowIndex = tableRowIndex++;
    } else {
      if (inTable) { inTable = false; tableRowIndex = 0; }
    }

    elements.push({
      ...classification,
      text: trimmed,
      pageNumber: line.pageNumber,
      sectionName: currentSection,
      y: line.y,
      fontSize: line.fontSize,
    });
  }

  // Step 4: Collect section names in order
  const sectionNames: string[] = [];
  const seenSections = new Set<string>();
  for (const el of elements) {
    if (el.sectionName && !seenSections.has(el.sectionName)) {
      seenSections.add(el.sectionName);
      sectionNames.push(el.sectionName);
    }
  }

  console.log(`📐 Extracted ${elements.length} structural elements across ${pageCount} pages`);
  console.log(`📐 Detected ${sectionNames.length} sections: ${sectionNames.slice(0, 8).join(', ')}${sectionNames.length > 8 ? '...' : ''}`);

  return {
    elements,
    pageCount,
    sectionNames,
    info: info ? { title: info.Title, author: info.Author, subject: info.Subject } : undefined,
  };
}

// ── Classification Logic ──

function classifyLine(
  line: LayoutLine,
  medianFontSize: number,
  maxFontSize: number
): Omit<StructuralElement, 'text' | 'pageNumber' | 'sectionName' | 'y' | 'fontSize'> {
  const text = line.text.trim();

  // Checkbox
  if (CHECKBOX_PATTERNS.some(p => p.test(text))) {
    return { type: 'checkbox' as StructuralElementType };
  }

  // Heading detection: large font, bold, ALL-CAPS, or matches form section pattern
  const isLargeFont = line.fontSize > medianFontSize * 1.15;
  const isAllCaps = text === text.toUpperCase() && text.length > 3 && /[A-Z]/.test(text);
  const matchesSectionPattern = FORM_SECTION_PATTERNS.some(p => p.test(text));

  if (matchesSectionPattern || (isAllCaps && text.length > 4 && text.length < 120)) {
    const isTop = line.fontSize >= maxFontSize * 0.85 || (isLargeFont && line.isBold);
    return {
      type: isTop ? 'heading' : 'subheading',
      headingLevel: isTop ? 1 : 2,
    };
  }

  if (isLargeFont && line.isBold && text.length < 120) {
    return { type: 'heading', headingLevel: 1 };
  }

  if (line.isBold && text.length < 100 && (isLargeFont || isAllCaps)) {
    return { type: 'subheading', headingLevel: 2 };
  }

  // List items
  if (LIST_PATTERNS.some(p => p.test(text))) {
    return { type: 'list_item' };
  }

  // Table rows: multiple tab/space-separated columns, or "Label: Value" patterns
  if (isTableRow(line)) {
    return { type: 'table_row', rowIndex: 0 };
  }

  return { type: 'text' };
}

function isTableRow(line: LayoutLine): boolean {
  // If items are spread across the page width with gaps
  if (line.items.length >= 2) {
    const xs = line.items.map(i => i.x);
    const gaps = [];
    for (let i = 1; i < xs.length; i++) {
      gaps.push(xs[i] - (xs[i - 1] + (line.items[i - 1].width || 0)));
    }
    const largeGaps = gaps.filter(g => g > 30).length;
    if (largeGaps >= 1 && line.items.length >= 3) return true;
  }

  // Tab or multiple-space separated
  const text = line.text;
  if (/\t/.test(text)) return true;
  if (/\s{4,}/.test(text) && text.split(/\s{4,}/).length >= 2) return true;

  // "Label: Value" on a single line with enough spacing
  if (/^[\w\s]+:\s+.+/.test(text) && line.items.length >= 2) return true;

  return false;
}

// ── Utilities ──

function normalizeHeading(text: string): string {
  return text
    .replace(/^[\d.]+\s*/, '')        // Remove leading "1." or "1.2."
    .replace(/^[IVX]+\.\s*/, '')      // Remove "III."
    .replace(/^(?:PART|SECTION|SCHEDULE)\s+[A-Z0-9]+[\s:.\-]*/i, '') // Remove "PART A:" prefix (keep the title)
    .replace(/[:.\-]+\s*$/, '')       // Remove trailing punctuation
    .trim()
    || text.trim();                   // Fallback to original if everything was stripped
}

function getMedian(arr: number[]): number {
  if (arr.length === 0) return 12;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
