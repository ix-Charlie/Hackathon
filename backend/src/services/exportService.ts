/**
 * Export Service — Word (DOCX) and PDF generation for legal documents
 * Uses `docx` for Word and `pdfkit` for PDF — industry-standard Node.js libraries.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
  Header,
  Footer,
  PageNumber,
  NumberFormat,
  SectionType,
} from 'docx';
import PDFDocument from 'pdfkit';

// ── Types ──

export interface ExportSection {
  heading?: string;
  content: string;
  type: 'text' | 'table' | 'list' | 'heading';
}

export interface ExportPayload {
  title: string;
  subtitle?: string;
  sections: ExportSection[];
  metadata: {
    matter?: string;
    date: string;
    author?: string;
    caseNumber?: string;
  };
}

// ── Markdown → Sections Parser ──

/**
 * Parses markdown content (from chat responses) into structured ExportSection[].
 * Handles headings, bullet lists, tables, and plain text.
 */
export function parseMarkdownToSections(markdown: string): ExportSection[] {
  const sections: ExportSection[] = [];
  const lines = markdown.split('\n');
  let currentSection: ExportSection | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length > 0 && currentSection) {
      currentSection.content = buffer.join('\n').trim();
      if (currentSection.content) sections.push(currentSection);
      buffer = [];
    }
    currentSection = null;
  };

  for (const line of lines) {
    // Detect headings
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      flush();
      sections.push({ heading: headingMatch[2].trim(), content: '', type: 'heading' });
      currentSection = { content: '', type: 'text' };
      continue;
    }

    // Detect table rows (| col | col |)
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      // Skip separator rows (|---|---|)
      if (/^\|[\s\-:|]+\|$/.test(line.trim())) continue;
      if (!currentSection || currentSection.type !== 'table') {
        flush();
        currentSection = { content: '', type: 'table' };
      }
      buffer.push(line.trim());
      continue;
    }

    // Detect list items
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      if (!currentSection || currentSection.type !== 'list') {
        flush();
        currentSection = { content: '', type: 'list' };
      }
      buffer.push(line.trim());
      continue;
    }

    // Plain text
    if (!currentSection || currentSection.type !== 'text') {
      flush();
      currentSection = { content: '', type: 'text' };
    }
    buffer.push(line);
  }
  flush();

  return sections;
}

// ── Word Document Generation ──

function stripMarkdownFormatting(text: string): TextRun[] {
  const runs: TextRun[] = [];
  // Simple bold/italic parser
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  for (const part of parts) {
    if (part.startsWith('**') && part.endsWith('**')) {
      runs.push(new TextRun({ text: part.slice(2, -2), bold: true, font: 'Times New Roman', size: 24 }));
    } else if (part.startsWith('*') && part.endsWith('*')) {
      runs.push(new TextRun({ text: part.slice(1, -1), italics: true, font: 'Times New Roman', size: 24 }));
    } else if (part) {
      runs.push(new TextRun({ text: part, font: 'Times New Roman', size: 24 }));
    }
  }
  return runs;
}

function parseTableSection(content: string): Table {
  const rows = content.split('\n').filter(r => r.trim());
  const parsedRows = rows.map(row =>
    row.split('|').filter(c => c.trim()).map(c => c.trim())
  );

  if (parsedRows.length === 0) {
    return new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('')] })] })] });
  }

  const tableRows = parsedRows.map((cells, idx) =>
    new TableRow({
      children: cells.map(cell =>
        new TableCell({
          children: [new Paragraph({
            children: [new TextRun({
              text: cell,
              bold: idx === 0,
              font: 'Times New Roman',
              size: 20,
            })],
          })],
          width: { size: Math.floor(9000 / cells.length), type: WidthType.DXA },
        })
      ),
    })
  );

  return new Table({
    rows: tableRows,
    width: { size: 9000, type: WidthType.DXA },
  });
}

export async function generateWordDocument(payload: ExportPayload): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];

  // Title
  children.push(new Paragraph({
    children: [new TextRun({ text: payload.title, bold: true, font: 'Times New Roman', size: 32 })],
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 },
  }));

  // Subtitle / metadata
  if (payload.subtitle) {
    children.push(new Paragraph({
      children: [new TextRun({ text: payload.subtitle, italics: true, font: 'Times New Roman', size: 24 })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
    }));
  }

  const metaLine = [
    payload.metadata.matter && `Matter: ${payload.metadata.matter}`,
    payload.metadata.caseNumber && `Case #: ${payload.metadata.caseNumber}`,
    `Date: ${payload.metadata.date}`,
  ].filter(Boolean).join('  |  ');

  children.push(new Paragraph({
    children: [new TextRun({ text: metaLine, font: 'Times New Roman', size: 20, color: '666666' })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 400 },
  }));

  // Horizontal rule
  children.push(new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: '999999' } },
    spacing: { after: 200 },
  }));

  // Sections
  for (const section of payload.sections) {
    if (section.type === 'heading' && section.heading) {
      children.push(new Paragraph({
        children: [new TextRun({ text: section.heading, bold: true, font: 'Times New Roman', size: 28 })],
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 300, after: 100 },
      }));
      continue;
    }

    if (section.heading) {
      children.push(new Paragraph({
        children: [new TextRun({ text: section.heading, bold: true, font: 'Times New Roman', size: 26 })],
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 200, after: 100 },
      }));
    }

    if (section.type === 'table' && section.content) {
      children.push(parseTableSection(section.content));
    } else if (section.type === 'list' && section.content) {
      const items = section.content.split('\n');
      for (const item of items) {
        const cleaned = item.replace(/^\s*[-*]\s+/, '').replace(/^\s*\d+\.\s+/, '');
        children.push(new Paragraph({
          children: stripMarkdownFormatting(cleaned),
          bullet: { level: 0 },
          spacing: { after: 60 },
        }));
      }
    } else if (section.content) {
      const paragraphs = section.content.split('\n\n');
      for (const para of paragraphs) {
        if (para.trim()) {
          children.push(new Paragraph({
            children: stripMarkdownFormatting(para.trim()),
            spacing: { after: 120, line: 276 },
          }));
        }
      }
    }
  }

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }, // 1 inch margins
          size: { width: 12240, height: 15840 }, // Letter size
        },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            children: [new TextRun({ text: payload.title, font: 'Times New Roman', size: 18, color: '999999' })],
            alignment: AlignmentType.RIGHT,
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            children: [
              new TextRun({ text: 'Page ', font: 'Times New Roman', size: 18 }),
              new TextRun({ children: [PageNumber.CURRENT], font: 'Times New Roman', size: 18 }),
            ],
            alignment: AlignmentType.CENTER,
          })],
        }),
      },
      children,
    }],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}

// ── PDF Document Generation ──

export function generatePdfDocument(payload: ExportPayload): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 72, bottom: 72, left: 72, right: 72 }, // 1 inch
      info: {
        Title: payload.title,
        Author: payload.metadata.author || '',
        Subject: payload.metadata.matter || '',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Title
    doc.font('Times-Bold').fontSize(16).text(payload.title, { align: 'center' });
    doc.moveDown(0.3);

    // Subtitle
    if (payload.subtitle) {
      doc.font('Times-Italic').fontSize(12).text(payload.subtitle, { align: 'center' });
      doc.moveDown(0.2);
    }

    // Metadata line
    const metaLine = [
      payload.metadata.matter && `Matter: ${payload.metadata.matter}`,
      payload.metadata.caseNumber && `Case #: ${payload.metadata.caseNumber}`,
      `Date: ${payload.metadata.date}`,
    ].filter(Boolean).join('  |  ');
    doc.font('Times-Roman').fontSize(9).fillColor('#666666').text(metaLine, { align: 'center' });
    doc.moveDown(0.5);
    doc.fillColor('#000000');

    // Horizontal rule
    doc.moveTo(72, doc.y).lineTo(540, doc.y).stroke('#999999');
    doc.moveDown(0.5);

    // Sections
    for (const section of payload.sections) {
      if (section.type === 'heading' && section.heading) {
        doc.moveDown(0.3);
        doc.font('Times-Bold').fontSize(13).text(section.heading);
        doc.moveDown(0.2);
        continue;
      }

      if (section.heading) {
        doc.moveDown(0.2);
        doc.font('Times-Bold').fontSize(11).text(section.heading);
        doc.moveDown(0.1);
      }

      if (section.type === 'list' && section.content) {
        const items = section.content.split('\n');
        doc.font('Times-Roman').fontSize(11);
        for (const item of items) {
          const cleaned = item.replace(/^\s*[-*]\s+/, '').replace(/^\s*\d+\.\s+/, '');
          // Strip markdown bold/italic for PDF plain text
          const plainText = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1');
          doc.text(`  • ${plainText}`, { indent: 20 });
        }
        doc.moveDown(0.2);
      } else if (section.type === 'table' && section.content) {
        // Simple table rendering — rows separated by pipes
        const rows = section.content.split('\n').filter(r => r.trim());
        doc.font('Times-Roman').fontSize(9);
        for (let i = 0; i < rows.length; i++) {
          const cells = rows[i].split('|').filter(c => c.trim()).map(c => c.trim());
          const cellText = cells.join('  |  ');
          doc.font(i === 0 ? 'Times-Bold' : 'Times-Roman').text(cellText);
        }
        doc.moveDown(0.3);
      } else if (section.content) {
        const plainText = section.content
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/\*([^*]+)\*/g, '$1');
        doc.font('Times-Roman').fontSize(11).text(plainText.trim(), { lineGap: 3 });
        doc.moveDown(0.2);
      }
    }

    // Footer with page numbers is added automatically by PDFKit
    doc.end();
  });
}
