/**
 * Layout-Aware DOCX Extractor
 * Uses mammoth's HTML conversion to preserve headings, tables, and lists.
 * Converts the HTML structure into StructuralElements for section-aware chunking.
 */

import mammoth from 'mammoth';
import { StructuralElement, StructuralElementType, LayoutExtractionResult } from './pdfLayout.js';

/**
 * Extract structured layout elements from a DOCX buffer.
 * Uses mammoth's HTML output to detect headings, tables, and lists.
 */
export async function extractDocxLayout(buffer: Buffer): Promise<LayoutExtractionResult> {
  console.log(`📐 Layout-aware DOCX extraction from ${buffer.length} bytes...`);

  const result = await mammoth.convertToHtml({ buffer }, {
    styleMap: [
      "p[style-name='Heading 1'] => h1:fresh",
      "p[style-name='Heading 2'] => h2:fresh",
      "p[style-name='Heading 3'] => h3:fresh",
      "p[style-name='Heading 4'] => h4:fresh",
    ],
  });

  const html = result.value;
  if (!html || html.trim().length === 0) {
    return { elements: [], pageCount: 1, sectionNames: [] };
  }

  const elements: StructuralElement[] = [];
  let currentSection: string | null = null;
  let tableRowIndex = 0;
  let inTable = false;

  // Parse HTML tags sequentially
  // We process: h1-h4, p, li, tr/td, table
  const tagRegex = /<(h[1-4]|p|li|tr|table|\/table)[^>]*>([\s\S]*?)<\/\1>|<tr[^>]*>([\s\S]*?)<\/tr>/gi;

  // Simpler approach: split by major HTML elements
  const parts = splitHtmlIntoElements(html);

  for (const part of parts) {
    if (!part.text.trim()) continue;

    const el: StructuralElement = {
      type: part.type,
      text: part.text.trim(),
      pageNumber: 1, // DOCX doesn't have pages, default to 1
      sectionName: currentSection,
      y: 0,
      fontSize: 12,
    };

    if (part.type === 'heading' || part.type === 'subheading') {
      currentSection = part.text.trim();
      el.sectionName = currentSection;
      el.headingLevel = part.headingLevel || 1;
      inTable = false;
      tableRowIndex = 0;
    }

    if (part.type === 'table_row') {
      if (!inTable) { inTable = true; tableRowIndex = 0; }
      el.rowIndex = tableRowIndex++;
    } else {
      if (inTable) { inTable = false; tableRowIndex = 0; }
    }

    elements.push(el);
  }

  // Collect section names
  const sectionNames: string[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    if (el.sectionName && !seen.has(el.sectionName)) {
      seen.add(el.sectionName);
      sectionNames.push(el.sectionName);
    }
  }

  console.log(`📐 DOCX layout: ${elements.length} elements, ${sectionNames.length} sections`);
  return { elements, pageCount: 1, sectionNames };
}

// ── HTML Parsing Helpers ──

interface HtmlElement {
  type: StructuralElementType;
  text: string;
  headingLevel?: number;
}

function splitHtmlIntoElements(html: string): HtmlElement[] {
  const elements: HtmlElement[] = [];

  // Match block-level HTML elements
  const blockPattern = /<(h[1-6]|p|li|tr|td|th|blockquote|div)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  let lastIndex = 0;

  // First pass: extract table rows specially
  const tableRowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const tableRows = new Set<string>();
  let trMatch;
  while ((trMatch = tableRowPattern.exec(html)) !== null) {
    const rowHtml = trMatch[1];
    const cells = extractCellTexts(rowHtml);
    if (cells.length > 0) {
      const rowText = cells.join(' | ');
      tableRows.add(trMatch[0]);
      elements.push({ type: 'table_row', text: rowText });
    }
  }

  // Second pass: extract non-table elements
  const nonTableHtml = html.replace(/<table[\s\S]*?<\/table>/gi, '<TABLE_PLACEHOLDER/>');
  const elementPattern = /<(h[1-6]|p|li|blockquote)[^>]*>([\s\S]*?)<\/\1>/gi;

  while ((match = elementPattern.exec(nonTableHtml)) !== null) {
    const tag = match[1].toLowerCase();
    const innerHtml = match[2];
    const text = stripHtml(innerHtml).trim();

    if (!text) continue;

    if (tag.startsWith('h')) {
      const level = parseInt(tag[1], 10);
      elements.push({
        type: level <= 2 ? 'heading' : 'subheading',
        text,
        headingLevel: level,
      });
    } else if (tag === 'li') {
      elements.push({ type: 'list_item', text: `• ${text}` });
    } else {
      // Check for checkbox patterns
      if (/^\s*[☐☑✓✗□■\[\]]\s*/u.test(text)) {
        elements.push({ type: 'checkbox', text });
      } else {
        elements.push({ type: 'text', text });
      }
    }
  }

  return elements;
}

function extractCellTexts(rowHtml: string): string[] {
  const cells: string[] = [];
  const cellPattern = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let match;
  while ((match = cellPattern.exec(rowHtml)) !== null) {
    const text = stripHtml(match[1]).trim();
    if (text) cells.push(text);
  }
  return cells;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
