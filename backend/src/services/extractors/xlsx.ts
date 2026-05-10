/**
 * Excel/Spreadsheet Text Extractor
 * Uses xlsx (SheetJS) for Excel file extraction
 */

import * as XLSX from 'xlsx';

export interface XlsxExtractionResult {
  text: string;
  sheetCount: number;
  sheetNames: string[];
}

/**
 * Extract text from an Excel file buffer
 * Supports: .xlsx, .xls, .csv
 */
export async function extractXlsxText(buffer: Buffer): Promise<XlsxExtractionResult> {
  console.log(`📄 Extracting Excel text from ${buffer.length} bytes...`);

  try {
    const workbook = XLSX.read(buffer, {
      type: 'buffer',
      cellDates: true,
      cellText: true,
    });

    const sheetNames = workbook.SheetNames;
    const textParts: string[] = [];

    for (const sheetName of sheetNames) {
      const worksheet = workbook.Sheets[sheetName];
      
      // Convert to CSV-like text for better readability
      const sheetText = XLSX.utils.sheet_to_csv(worksheet, {
        blankrows: false,
        strip: true,
      });

      if (sheetText.trim()) {
        textParts.push(`--- Sheet: ${sheetName} ---\n${sheetText}`);
      }
    }

    const text = textParts.join('\n\n');
    console.log(`✅ Excel extracted: ${text.length} chars from ${sheetNames.length} sheets`);

    return {
      text,
      sheetCount: sheetNames.length,
      sheetNames,
    };
  } catch (error) {
    console.error('❌ Excel extraction error:', error);
    throw new Error(`Excel extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Extract text from a CSV file buffer
 */
export async function extractCsvText(buffer: Buffer): Promise<string> {
  console.log(`📄 Extracting CSV text from ${buffer.length} bytes...`);

  try {
    // CSV is just text, but we can parse it for validation
    const workbook = XLSX.read(buffer, {
      type: 'buffer',
    });

    const firstSheet = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheet];

    const text = XLSX.utils.sheet_to_csv(worksheet, {
      blankrows: false,
      strip: true,
    });

    console.log(`✅ CSV extracted: ${text.length} characters`);
    return text;
  } catch {
    // Fallback: treat as plain text
    console.log('⚠️ CSV parse failed, treating as plain text');
    return buffer.toString('utf-8');
  }
}
