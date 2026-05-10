/**
 * CSV Intelligence Service
 * Enterprise-grade CSV parsing, type inference, summary generation,
 * and smart RAG-compatible chunking.
 *
 * Phase 1: Deterministic parsing → typed rows → schema → JSONB storage
 * Phase 2: Summary statistics (auto-computed on ingest)
 * Phase 3: Smart chunking with header-aware row groups for RAG
 */

import * as XLSX from 'xlsx';
import { supabaseAdmin } from '../config/supabase.js';

// ── Type Definitions ─────────────────────────────────────────────────

export interface ColumnSchema {
  columnName: string;
  inferredType: 'integer' | 'float' | 'currency' | 'date' | 'duration' | 'boolean' | 'categorical' | 'free_text';
  nullable: boolean;
  uniqueValues: number;
  nullCount: number;
  min?: number;
  max?: number;
  exampleValues: string[];
}

export interface CsvEntityCandidate {
  value: string;
  columnName: string;
  occurrences: number;
  entityType: 'person' | 'organization' | 'location' | 'generic';
}

export interface CsvSummary {
  totalRows: number;
  totalColumns: number;
  duplicateRows: number;
  columnStats: Record<string, {
    nullPct: number;
    topValues: Array<{ value: string; count: number }>;
    mean?: number;
    median?: number;
    min?: number;
    max?: number;
  }>;
}

export interface CsvDataset {
  id?: string;
  schema: ColumnSchema[];
  rows: Record<string, unknown>[];
  summary: CsvSummary;
  rowCount: number;
  columnCount: number;
  sheetName?: string;
  schemaDescription?: string;
}

export interface CsvIntelligenceResult {
  datasets: CsvDataset[];
  /** Header-aware chunks for RAG embedding */
  ragChunks: string[];
  /** Human-readable summary text for the first embedded chunk */
  summaryText: string;
  /** Entity candidates extracted from categorical columns */
  entityCandidates: CsvEntityCandidate[];
}

// ── Phase 1: Deterministic Parsing ───────────────────────────────────

/**
 * Parse a CSV/Excel buffer into structured datasets.
 * Supports multi-sheet Excel files (each sheet → separate dataset).
 */
export function parseCsvBuffer(buffer: Buffer, filename: string): CsvDataset[] {
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    cellDates: true,
    cellText: true,
    raw: false,         // Get formatted values
    codepage: 65001,    // UTF-8
  });

  const datasets: CsvDataset[] = [];

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];

    // Parse to array-of-objects (header row → keys)
    const rawRows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(worksheet, {
      defval: null,       // NULL for empty cells
      raw: false,         // Formatted strings
      blankrows: false,
    });

    if (rawRows.length === 0) continue;

    // Extract headers from first row keys
    const headers = Object.keys(rawRows[0]);
    if (headers.length === 0) continue;

    // Clean rows: trim strings, normalize nulls
    const rows = rawRows.map(row => {
      const clean: Record<string, unknown> = {};
      for (const h of headers) {
        let val = row[h];
        if (val === undefined || val === null || val === '') {
          clean[h] = null;
        } else if (typeof val === 'string') {
          clean[h] = val.trim();
        } else {
          clean[h] = val;
        }
      }
      return clean;
    });

    // Validate: reject if >30% rows malformed (different column counts)
    const expectedCols = headers.length;
    const malformedCount = rows.filter(r => Object.keys(r).length !== expectedCols).length;
    if (rows.length > 0 && (malformedCount / rows.length) > 0.3) {
      console.warn(`⚠️ Sheet "${sheetName}": ${malformedCount}/${rows.length} malformed rows (>30%), skipping`);
      continue;
    }

    // Phase 1: Type inference
    const schema = inferColumnTypes(headers, rows);

    // Phase 2: Summary generation
    const summary = generateSummary(headers, rows, schema);

    datasets.push({
      schema,
      rows,
      summary,
      rowCount: rows.length,
      columnCount: headers.length,
      sheetName: workbook.SheetNames.length > 1 ? sheetName : undefined,
    });
  }

  if (datasets.length === 0) {
    console.warn(`⚠️ No valid sheets found in ${filename}`);
  }

  return datasets;
}

// ── Phase 1b: Type Inference Engine ──────────────────────────────────

const CURRENCY_REGEX = /^[\$£€₹¥]?\s*-?\d{1,3}(,\d{3})*(\.\d{1,2})?$/;
const INTEGER_REGEX = /^-?\d{1,15}$/;
const FLOAT_REGEX = /^-?\d+\.\d+$/;
const DURATION_REGEX = /^(\d+(\.\d+)?\s*(hrs?|hours?|mins?|minutes?|h|m)|\d{1,3}:\d{2}(:\d{2})?)$/i;
const DATE_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}$/,                               // 2024-01-15
  /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,                       // 1/15/2024 or 01/15/24
  /^\d{1,2}-\d{1,2}-\d{2,4}$/,                         // 15-01-2024
  /^\w{3,9}\s+\d{1,2},?\s+\d{4}$/,                     // January 15, 2024
  /^\d{1,2}\s+\w{3,9}\s+\d{4}$/,                       // 15 January 2024
  /^\d{4}\/\d{2}\/\d{2}$/,                             // 2024/01/15
];
const BOOLEAN_VALUES = new Set(['true', 'false', 'yes', 'no', '1', '0', 'y', 'n', 't', 'f']);

function inferColumnTypes(headers: string[], rows: Record<string, unknown>[]): ColumnSchema[] {
  return headers.map(header => {
    const values = rows.map(r => r[header]);
    const nonNullValues = values.filter(v => v !== null && v !== undefined);
    const stringValues = nonNullValues.map(v => String(v).trim());
    const nullCount = values.length - nonNullValues.length;
    const uniqueSet = new Set(stringValues.map(s => s.toLowerCase()));

    // Sample examples (up to 5 unique)
    const exampleValues = [...new Set(stringValues)].slice(0, 5);

    // Type detection (order matters: most specific → least specific)
    let inferredType: ColumnSchema['inferredType'] = 'free_text';
    let min: number | undefined;
    let max: number | undefined;

    if (stringValues.length === 0) {
      inferredType = 'free_text';
    } else if (stringValues.every(v => BOOLEAN_VALUES.has(v.toLowerCase()))) {
      inferredType = 'boolean';
    } else if (stringValues.every(v => DATE_PATTERNS.some(p => p.test(v)))) {
      inferredType = 'date';
    } else if (stringValues.every(v => DURATION_REGEX.test(v))) {
      inferredType = 'duration';
      const nums = stringValues.map(v => parseDurationToHours(v)).filter(n => !isNaN(n));
      if (nums.length > 0) {
        min = Math.min(...nums);
        max = Math.max(...nums);
      }
    } else if (stringValues.every(v => CURRENCY_REGEX.test(v))) {
      inferredType = 'currency';
      const nums = stringValues.map(v => parseFloat(v.replace(/[\$£€₹¥,\s]/g, '')));
      min = Math.min(...nums);
      max = Math.max(...nums);
    } else if (stringValues.every(v => INTEGER_REGEX.test(v))) {
      inferredType = 'integer';
      const nums = stringValues.map(v => parseInt(v, 10));
      min = Math.min(...nums);
      max = Math.max(...nums);
    } else if (stringValues.every(v => FLOAT_REGEX.test(v))) {
      inferredType = 'float';
      const nums = stringValues.map(v => parseFloat(v));
      min = Math.min(...nums);
      max = Math.max(...nums);
    } else if (uniqueSet.size <= Math.min(20, rows.length * 0.3) && stringValues.every(v => v.length < 100)) {
      // Low cardinality + short values = categorical
      inferredType = 'categorical';
    } else {
      inferredType = 'free_text';
    }

    // Also check if >80% of non-null values match a numeric pattern (for mixed columns)
    if (inferredType === 'free_text' && stringValues.length > 0) {
      const numericCount = stringValues.filter(v =>
        CURRENCY_REGEX.test(v) || INTEGER_REGEX.test(v) || FLOAT_REGEX.test(v)
      ).length;
      if (numericCount / stringValues.length >= 0.8) {
        // Mostly numeric — treat as float with some parsing issues
        inferredType = 'float';
        const nums = stringValues
          .map(v => parseFloat(v.replace(/[\$£€₹¥,\s]/g, '')))
          .filter(n => !isNaN(n));
        if (nums.length > 0) {
          min = Math.min(...nums);
          max = Math.max(...nums);
        }
      }
    }

    return {
      columnName: header,
      inferredType,
      nullable: nullCount > 0,
      uniqueValues: uniqueSet.size,
      nullCount,
      min,
      max,
      exampleValues,
    };
  });
}

// ── Phase 2: Summary Generation ──────────────────────────────────────

function generateSummary(
  headers: string[],
  rows: Record<string, unknown>[],
  schema: ColumnSchema[],
): CsvSummary {
  // Duplicate row detection (stringify comparison)
  const rowStrings = rows.map(r => JSON.stringify(r));
  const duplicateCount = rowStrings.length - new Set(rowStrings).size;

  // Per-column stats
  const columnStats: CsvSummary['columnStats'] = {};

  for (const col of schema) {
    const colName = col.columnName;
    const values = rows.map(r => r[colName]);
    const nonNull = values.filter(v => v !== null && v !== undefined);
    const stringVals = nonNull.map(v => String(v).trim());

    // Null percentage
    const nullPct = values.length > 0 ? Math.round(((values.length - nonNull.length) / values.length) * 100) : 0;

    // Top 5 most frequent values
    const freq: Record<string, number> = {};
    for (const v of stringVals) {
      const k = v.toLowerCase();
      freq[k] = (freq[k] || 0) + 1;
    }
    const topValues = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([value, count]) => ({ value, count }));

    // Numeric stats
    let mean: number | undefined;
    let median: number | undefined;
    let min: number | undefined;
    let max: number | undefined;

    if (['integer', 'float', 'currency'].includes(col.inferredType)) {
      const nums = stringVals
        .map(v => parseFloat(v.replace(/[\$£€₹¥,\s]/g, '')))
        .filter(n => !isNaN(n));

      if (nums.length > 0) {
        mean = Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
        const sorted = [...nums].sort((a, b) => a - b);
        median = sorted.length % 2 === 0
          ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
          : sorted[Math.floor(sorted.length / 2)];
        min = sorted[0];
        max = sorted[sorted.length - 1];
      }
    }

    columnStats[colName] = { nullPct, topValues, mean, median, min, max };
  }

  return {
    totalRows: rows.length,
    totalColumns: headers.length,
    duplicateRows: duplicateCount,
    columnStats,
  };
}

// ── Phase 2b: Row Normalization ──────────────────────────────────────

/**
 * Parse a duration string ("1.5 hrs", "1:30", "2h") to decimal hours.
 */
function parseDurationToHours(val: string): number {
  // HH:MM or HH:MM:SS format
  const hmMatch = val.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (hmMatch) {
    const hours = parseInt(hmMatch[1], 10);
    const minutes = parseInt(hmMatch[2], 10);
    const seconds = hmMatch[3] ? parseInt(hmMatch[3], 10) : 0;
    return Math.round((hours + minutes / 60 + seconds / 3600) * 100) / 100;
  }
  // "1.5 hrs", "2 hours", "30 mins", "1h", "45m"
  const unitMatch = val.match(/^(\d+(?:\.\d+)?)\s*(hrs?|hours?|h|mins?|minutes?|m)$/i);
  if (unitMatch) {
    const num = parseFloat(unitMatch[1]);
    const unit = unitMatch[2].toLowerCase();
    if (unit.startsWith('m')) return Math.round((num / 60) * 100) / 100;
    return num;
  }
  return NaN;
}

/**
 * Parse a date string to ISO format (YYYY-MM-DD).
 * Supports: 2024-01-15, 1/15/2024, 01/15/24, 15-01-2024,
 *           January 15 2024, 15 January 2024, 2024/01/15
 */
function parseDateToISO(val: string): string | null {
  try {
    // Already ISO
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;

    // YYYY/MM/DD
    const ymdSlash = val.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    if (ymdSlash) return `${ymdSlash[1]}-${ymdSlash[2]}-${ymdSlash[3]}`;

    // M/D/YYYY or MM/DD/YY
    const mdySlash = val.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (mdySlash) {
      let year = mdySlash[3].length === 2 ? `20${mdySlash[3]}` : mdySlash[3];
      return `${year}-${mdySlash[1].padStart(2, '0')}-${mdySlash[2].padStart(2, '0')}`;
    }

    // DD-MM-YYYY
    const dmyDash = val.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
    if (dmyDash) {
      let year = dmyDash[3].length === 2 ? `20${dmyDash[3]}` : dmyDash[3];
      return `${year}-${dmyDash[2].padStart(2, '0')}-${dmyDash[1].padStart(2, '0')}`;
    }

    // Month name formats: "January 15, 2024" or "15 January 2024"
    const d = new Date(val);
    if (!isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  } catch {
    // Fall through
  }
  return null;
}

/**
 * Create normalized copies of rows with __n suffix columns:
 * - currency → stripped float in `column__n`
 * - date → ISO YYYY-MM-DD in `column__n`
 * - duration → decimal hours in `column__n`
 *
 * The original columns are preserved for display; __n columns are used
 * for deterministic comparisons, range filtering, and aggregations.
 */
function normalizeRows(
  rows: Record<string, unknown>[],
  schema: ColumnSchema[],
): Record<string, unknown>[] {
  const columnsToNormalize = schema.filter(c =>
    ['currency', 'date', 'duration'].includes(c.inferredType),
  );

  if (columnsToNormalize.length === 0) return rows;

  return rows.map(row => {
    const normalized = { ...row };
    for (const col of columnsToNormalize) {
      const val = row[col.columnName];
      if (val === null || val === undefined) {
        normalized[`${col.columnName}__n`] = null;
        continue;
      }
      const strVal = String(val).trim();
      switch (col.inferredType) {
        case 'currency': {
          const num = parseFloat(strVal.replace(/[\$£€₹¥,\s]/g, ''));
          normalized[`${col.columnName}__n`] = isNaN(num) ? null : num;
          break;
        }
        case 'date': {
          normalized[`${col.columnName}__n`] = parseDateToISO(strVal);
          break;
        }
        case 'duration': {
          const hrs = parseDurationToHours(strVal);
          normalized[`${col.columnName}__n`] = isNaN(hrs) ? null : hrs;
          break;
        }
      }
    }
    return normalized;
  });
}

/**
 * Generate a human-readable schema description for injection into LLM prompts.
 * This text is compact enough to fit in a system prompt and helps the LLM
 * construct correct filter/aggregation queries.
 */
function generateSchemaDescription(dataset: CsvDataset): string {
  const lines: string[] = [];
  lines.push(`Dataset: ${dataset.sheetName || 'Sheet1'} — ${dataset.rowCount} rows × ${dataset.columnCount} cols`);

  for (const col of dataset.schema) {
    let line = `  • ${col.columnName} (${col.inferredType})`;
    if (['currency', 'date', 'duration'].includes(col.inferredType)) {
      line += ` → use "${col.columnName}__n" for numeric ops`;
    }
    if (col.min !== undefined && col.max !== undefined) {
      line += ` [${col.min}..${col.max}]`;
    }
    if (col.inferredType === 'categorical' && col.uniqueValues <= 10) {
      const topVals = dataset.summary.columnStats[col.columnName]?.topValues
        .map(tv => tv.value)
        .slice(0, 8);
      if (topVals?.length) line += ` values=[${topVals.join(', ')}]`;
    }
    if (col.nullCount > 0) {
      const pct = Math.round((col.nullCount / dataset.rowCount) * 100);
      line += ` ${pct}% null`;
    }
    lines.push(line);
  }

  return lines.join('\n');
}

/**
 * Extract entity candidates from categorical columns.
 * Identifies columns likely containing names of people, orgs, or locations
 * based on column name heuristics and value patterns.
 */
function extractEntityCandidates(datasets: CsvDataset[]): CsvEntityCandidate[] {
  const candidates: CsvEntityCandidate[] = [];

  const NAME_COL_PATTERNS = /^(name|attorney|lawyer|counsel|client|party|judge|witness|assignee|assigned|owner|contact|from|to|sender|recipient|responsible|billed?\s*to|billing\s*party)/i;
  const ORG_COL_PATTERNS = /^(company|firm|organization|org|vendor|employer|party|department|dept|institution)/i;
  const LOCATION_COL_PATTERNS = /^(city|state|country|location|venue|jurisdiction|court|address)/i;

  // Name-like value pattern: "FirstName LastName" or "LastName, FirstName"
  const nameValuePattern = /^[A-Z][a-z]+ [A-Z][a-z]+$/;
  const commaNamePattern = /^[A-Z][a-z]+, [A-Z][a-z]+/;

  for (const dataset of datasets) {
    for (const col of dataset.schema) {
      if (col.inferredType !== 'categorical') continue;
      if (col.uniqueValues > 50) continue; // Too many unique values to be useful entities

      let entityType: CsvEntityCandidate['entityType'] = 'generic';
      if (NAME_COL_PATTERNS.test(col.columnName)) {
        entityType = 'person';
      } else if (ORG_COL_PATTERNS.test(col.columnName)) {
        entityType = 'organization';
      } else if (LOCATION_COL_PATTERNS.test(col.columnName)) {
        entityType = 'location';
      } else {
        // Check if values look like names
        const topVals = dataset.summary.columnStats[col.columnName]?.topValues || [];
        const nameCount = topVals.filter(tv =>
          nameValuePattern.test(tv.value) || commaNamePattern.test(tv.value),
        ).length;
        if (nameCount > topVals.length * 0.5 && topVals.length >= 2) {
          entityType = 'person';
        }
      }

      // Only extract from person/org/location columns (skip generic)
      if (entityType === 'generic') continue;

      // Get all unique values and their frequencies
      const valueFreq: Record<string, number> = {};
      for (const row of dataset.rows) {
        const val = row[col.columnName];
        if (val === null || val === undefined) continue;
        const sv = String(val).trim();
        if (sv.length < 2) continue;
        valueFreq[sv] = (valueFreq[sv] || 0) + 1;
      }

      for (const [value, count] of Object.entries(valueFreq)) {
        candidates.push({
          value,
          columnName: col.columnName,
          occurrences: count,
          entityType,
        });
      }
    }
  }

  return candidates;
}

// ── Phase 3: Smart RAG Chunking ──────────────────────────────────────

/**
 * Generate the full CSV intelligence result: structured storage + smart RAG chunks.
 * This is the main entry point called by the document processing pipeline.
 */
export function processCsvIntelligence(buffer: Buffer, filename: string): CsvIntelligenceResult {
  const datasets = parseCsvBuffer(buffer, filename);

  if (datasets.length === 0) {
    return { datasets: [], ragChunks: [], summaryText: '', entityCandidates: [] };
  }

  // Normalize rows: add __n columns for currency, date, duration
  for (const dataset of datasets) {
    dataset.rows = normalizeRows(dataset.rows, dataset.schema);
    dataset.schemaDescription = generateSchemaDescription(dataset);
  }

  // Extract entity candidates from categorical columns
  const entityCandidates = extractEntityCandidates(datasets);

  const allChunks: string[] = [];
  const summaryParts: string[] = [];

  for (const dataset of datasets) {
    const sheetLabel = dataset.sheetName ? ` (Sheet: ${dataset.sheetName})` : '';

    // 1. Schema + Summary chunk (always first — makes the dataset discoverable in RAG)
    const summaryChunk = buildSummaryChunk(dataset, filename, sheetLabel);
    allChunks.push(summaryChunk);
    summaryParts.push(summaryChunk);

    // 2. Header-aware row group chunks
    const rowChunks = buildRowChunks(dataset, filename, sheetLabel);
    allChunks.push(...rowChunks);
  }

  return {
    datasets,
    ragChunks: allChunks,
    summaryText: summaryParts.join('\n\n'),
    entityCandidates,
  };
}

/**
 * Build a summary chunk that describes the dataset structure.
 * This is embedded so chat queries like "what data do we have?" find the CSV.
 */
function buildSummaryChunk(dataset: CsvDataset, filename: string, sheetLabel: string): string {
  const { schema, summary } = dataset;

  const colDescriptions = schema.map(col => {
    let desc = `- **${col.columnName}** (${col.inferredType})`;
    if (col.min !== undefined && col.max !== undefined) {
      desc += ` — range: ${col.min} to ${col.max}`;
    }
    if (col.uniqueValues <= 10 && col.inferredType === 'categorical') {
      const vals = summary.columnStats[col.columnName]?.topValues.map(tv => tv.value).join(', ');
      if (vals) desc += ` — values: ${vals}`;
    }
    if (col.nullCount > 0) {
      desc += ` — ${summary.columnStats[col.columnName]?.nullPct}% null`;
    }
    return desc;
  }).join('\n');

  // Numeric column summaries
  const numericSummaries = schema
    .filter(col => ['integer', 'float', 'currency'].includes(col.inferredType))
    .map(col => {
      const stats = summary.columnStats[col.columnName];
      if (!stats || stats.mean === undefined) return null;
      return `- **${col.columnName}**: mean=${stats.mean}, median=${stats.median}, min=${stats.min}, max=${stats.max}`;
    })
    .filter(Boolean)
    .join('\n');

  return `[Structured Dataset: ${filename}${sheetLabel}]
Type: CSV/Excel spreadsheet — ${summary.totalRows} rows × ${summary.totalColumns} columns${summary.duplicateRows > 0 ? ` (${summary.duplicateRows} duplicate rows)` : ''}

**Columns:**
${colDescriptions}
${numericSummaries ? `\n**Numeric Statistics:**\n${numericSummaries}` : ''}
This document contains structured tabular data. For aggregation queries (totals, averages, counts, filtering), the system uses deterministic computation — not estimation.`;
}

/**
 * Build header-aware row group chunks for RAG.
 * Each chunk includes the header row + a group of data rows,
 * ensuring no context loss across chunk boundaries.
 * Rows are never split mid-row.
 */
function buildRowChunks(
  dataset: CsvDataset,
  filename: string,
  sheetLabel: string,
  maxChunkSize: number = 1200,
): string[] {
  const { schema, rows } = dataset;
  const headers = schema.map(c => c.columnName);
  const headerLine = headers.join(' | ');
  // Prefix for every chunk: filename + header
  const chunkPrefix = `[${filename}${sheetLabel}]\n${headerLine}\n${'─'.repeat(Math.min(headerLine.length, 80))}\n`;
  const prefixSize = chunkPrefix.length;
  const maxRowsPerChunk = Math.max(5, Math.floor((maxChunkSize - prefixSize) / estimateAvgRowLength(rows, headers)));

  const chunks: string[] = [];
  let currentRows: string[] = [];
  let currentSize = prefixSize;

  for (let i = 0; i < rows.length; i++) {
    const rowLine = headers.map(h => {
      const val = rows[i][h];
      return val !== null && val !== undefined ? String(val) : '';
    }).join(' | ');

    const lineSize = rowLine.length + 1; // +1 for newline

    if (currentRows.length > 0 && (currentSize + lineSize > maxChunkSize || currentRows.length >= maxRowsPerChunk)) {
      // Flush current chunk
      chunks.push(chunkPrefix + currentRows.join('\n'));
      currentRows = [];
      currentSize = prefixSize;
    }

    currentRows.push(rowLine);
    currentSize += lineSize;
  }

  // Flush remaining
  if (currentRows.length > 0) {
    chunks.push(chunkPrefix + currentRows.join('\n'));
  }

  return chunks;
}

function estimateAvgRowLength(rows: Record<string, unknown>[], headers: string[]): number {
  if (rows.length === 0) return 50;
  const sample = rows.slice(0, Math.min(20, rows.length));
  const totalLen = sample.reduce((acc, row) => {
    return acc + headers.map(h => String(row[h] ?? '')).join(' | ').length + 1;
  }, 0);
  return Math.ceil(totalLen / sample.length);
}

// ── Storage: Save to csv_datasets table ──────────────────────────────

export async function storeCsvDataset(
  dataset: CsvDataset,
  fileId: string,
  tenantId: string,
  caseId: string | undefined,
  filename: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('csv_datasets')
      .insert({
        tenant_id: tenantId,
        file_id: fileId,
        case_id: caseId || null,
        filename,
        schema: dataset.schema,
        rows_data: dataset.rows,
        summary: dataset.summary,
        row_count: dataset.rowCount,
        column_count: dataset.columnCount,
        sheet_name: dataset.sheetName || null,
        schema_description: dataset.schemaDescription || null,
      })
      .select('id')
      .single();

    if (error) {
      console.error('❌ Failed to store CSV dataset:', error);
      return null;
    }

    console.log(`✅ CSV dataset stored: ${data.id} (${dataset.rowCount} rows × ${dataset.columnCount} cols)`);
    return data.id;
  } catch (err) {
    console.error('❌ CSV dataset storage error:', err);
    return null;
  }
}

// ── Query: Deterministic filtering on stored datasets ────────────────

export interface CsvFilter {
  column: string;
  operator: 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'fuzzy' | 'date_range' | 'in';
  value: string;
  /** For date_range operator: end date (value is start date) */
  value2?: string;
}

export interface CsvAggregation {
  column: string;
  function: 'sum' | 'avg' | 'count' | 'count_distinct' | 'min' | 'max';
}

export interface CsvQueryParams {
  datasetId: string;
  tenantId: string;
  filters?: CsvFilter[];
  /** OR-combined filters (any match passes) */
  orFilters?: CsvFilter[];
  aggregations?: CsvAggregation[];
  groupBy?: string;
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
  limit?: number;
}

export interface CsvQueryResult {
  filteredRows: Record<string, unknown>[];
  totalMatches: number;
  aggregations: Record<string, number>;
  groups: Record<string, Record<string, unknown>[]>;
  truncated?: boolean;
}

/**
 * Execute a deterministic query on a CSV dataset via the PostgreSQL RPC function.
 */
export async function queryCsvDataset(params: CsvQueryParams): Promise<CsvQueryResult> {
  const { data, error } = await supabaseAdmin.rpc('query_csv_dataset', {
    p_dataset_id: params.datasetId,
    p_tenant_id: params.tenantId,
    p_filters: params.filters || [],
    p_or_filters: params.orFilters || [],
    p_aggregations: params.aggregations || [],
    p_group_by: params.groupBy || null,
    p_order_by: params.orderBy || null,
    p_order_dir: params.orderDir || 'asc',
    p_limit: params.limit || 100,
  });

  if (error) {
    console.error('❌ CSV query error:', error);
    throw new Error(`CSV query failed: ${error.message}`);
  }

  return {
    filteredRows: data?.filtered_rows || [],
    totalMatches: data?.total_matches || 0,
    aggregations: data?.aggregations || {},
    groups: data?.groups || {},
    truncated: data?.truncated || false,
  };
}

/**
 * Find CSV datasets for a given case/tenant.
 */
export async function findCsvDatasets(
  tenantId: string,
  caseId: string,
): Promise<Array<{ id: string; filename: string; schema: ColumnSchema[]; summary: CsvSummary; rowCount: number; columnCount: number; schemaDescription: string | null }>> {
  const { data, error } = await supabaseAdmin
    .from('csv_datasets')
    .select('id, filename, schema, summary, row_count, column_count, schema_description')
    .eq('tenant_id', tenantId)
    .eq('case_id', caseId);

  if (error) {
    console.error('❌ Failed to find CSV datasets:', error);
    return [];
  }

  return (data || []).map(d => ({
    id: d.id,
    filename: d.filename,
    schema: d.schema as ColumnSchema[],
    summary: d.summary as CsvSummary,
    rowCount: d.row_count,
    columnCount: d.column_count,
    schemaDescription: d.schema_description || null,
  }));
}
