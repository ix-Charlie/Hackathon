/**
 * Standalone MSG Extraction Validator
 * 
 * Runs entirely offline — no API keys, no network, no AI, no embedding.
 * Tests the msg.ts parser module against the sample .msg file.
 * 
 * Run:  npx tsx msg-parser/validate-msg.ts
 *   or: npx tsx msg-parser/validate-msg.ts /path/to/your/file.msg
 */

import path from 'path';
import fs from 'fs';
import { parseMsgFile, extractMsgForPipeline } from './msg.js';
import type { MsgExtractionResult } from './msg.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const DIM    = '\x1b[2m';
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';

function pass(msg: string) { console.log(`  ${GREEN}✅ PASS${RESET}  ${msg}`); }
function fail(msg: string) { console.log(`  ${RED}❌ FAIL${RESET}  ${msg}`); }
function warn(msg: string) { console.log(`  ${YELLOW}⚠️  WARN${RESET}  ${msg}`); }
function info(msg: string) { console.log(`  ${CYAN}ℹ️  INFO${RESET}  ${msg}`); }
function header(msg: string) { console.log(`\n${BOLD}${msg}${RESET}`); }
function divider() { console.log(`${DIM}${'─'.repeat(60)}${RESET}`); }

// ─── Validation ─────────────────────────────────────────────────────────────

interface ValidationReport {
  totalChecks: number;
  passed: number;
  failed: number;
  warnings: string[];
}

function validateResult(result: MsgExtractionResult): ValidationReport {
  const report: ValidationReport = { totalChecks: 0, passed: 0, failed: 0, warnings: [] };

  function check(name: string, condition: boolean, detail?: string) {
    report.totalChecks++;
    if (condition) {
      pass(name);
      report.passed++;
    } else {
      fail(name + (detail ? ` — ${detail}` : ''));
      report.failed++;
    }
  }

  function warnCheck(name: string, condition: boolean, detail?: string) {
    if (!condition) {
      warn(name + (detail ? ` — ${detail}` : ''));
      report.warnings.push(name);
    }
  }

  header('📋 FIELD PRESENCE REPORT');
  divider();

  check('subject is present', !!result.subject);
  check('from is present', !!result.from);
  check('to has entries', result.to.length > 0);
  check('cc is array', Array.isArray(result.cc));
  check('bcc is array', Array.isArray(result.bcc));
  check('date field exists', result.date !== undefined);
  check('body_text is present', !!result.body_text);
  // HTML body is optional — many emails only have plain text
  if (result.body_html_cleaned) {
    pass('body_html_cleaned is present');
    report.totalChecks++; report.passed++;
  } else {
    warnCheck('body_html_cleaned is present', false, 'Email has no HTML body (plain text only)');
    report.totalChecks++; report.passed++; // Not a failure
  }
  check('attachments is array', Array.isArray(result.attachments));

  header('📊 CONTENT QUALITY CHECKS');
  divider();

  // Body quality
  check('body_text has meaningful length (>50 chars)', result.body_text.length > 50);
  check('body_text contains no null bytes', !result.body_text.includes('\x00'));
  check('body_text contains no CID references', !/cid:/i.test(result.body_text));
  if (result.body_html_cleaned.length > 0) {
    check('body_html_cleaned has meaningful length', result.body_html_cleaned.length > 50);
    check('body_html_cleaned contains no HTML tags', !/<[a-z][^>]*>/i.test(result.body_html_cleaned));
    check('body_html_cleaned contains no CID references', !/cid:/i.test(result.body_html_cleaned));
    check('body_html_cleaned contains no tracking pixels', !/tracking.pixel|beacon/i.test(result.body_html_cleaned));
  } else {
    info('Skipping HTML body quality checks (no HTML body in this email)');
  }

  // Encoding artifact check
  const hasEncodingArtifacts = /=[0-9A-F]{2}/i.test(result.body_text) || /\uFFFD/.test(result.body_text);
  check('body_text free of encoding artifacts', !hasEncodingArtifacts);

  // Binary garbage check
  const binaryRatio = result.body_text.replace(/[^\x20-\x7E\n\r\t]/g, '').length / Math.max(result.body_text.length, 1);
  check('body_text is readable (>90% printable)', binaryRatio > 0.9);

  // Attachment checks
  if (result.attachments.length > 0) {
    for (const att of result.attachments) {
      check(`attachment "${att.filename}" has filename`, !!att.filename);
      check(`attachment "${att.filename}" has extracted_text`, att.extracted_text !== undefined);
      warnCheck(
        `attachment "${att.filename}" text is non-empty`,
        att.extracted_text.length > 0,
        'Empty extraction'
      );
    }
  }

  header('📝 SCHEMA COMPLIANCE');
  divider();

  check('subject is string', typeof result.subject === 'string');
  check('from is string', typeof result.from === 'string');
  check('to is string[]', Array.isArray(result.to) && result.to.every(t => typeof t === 'string'));
  check('cc is string[]', Array.isArray(result.cc) && result.cc.every(t => typeof t === 'string'));
  check('bcc is string[]', Array.isArray(result.bcc) && result.bcc.every(t => typeof t === 'string'));
  check('date is string', typeof result.date === 'string');
  check('body_text is string', typeof result.body_text === 'string');
  check('body_html_cleaned is string', typeof result.body_html_cleaned === 'string');
  check('attachments is array of {filename, extracted_text}',
    Array.isArray(result.attachments) &&
    result.attachments.every(a => typeof a.filename === 'string' && typeof a.extracted_text === 'string')
  );

  return report;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const filePath = process.argv[2] || path.join(import.meta.dirname, 'sample-email.msg');

  console.log(`\n${BOLD}═══════════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  MSG EXTRACTION VALIDATOR — Standalone Local Test${RESET}`);
  console.log(`${BOLD}═══════════════════════════════════════════════════════════${RESET}`);

  info(`File: ${filePath}`);
  info(`Mode: Offline / Local only (NO API calls)`);
  divider();

  // ── Step 1: Parse the file ──
  header('🔍 STEP 1: PARSING .MSG FILE');
  divider();

  let result: MsgExtractionResult;
  try {
    result = await parseMsgFile(filePath);
    pass('File parsed without errors');
  } catch (err) {
    fail(`File parsing CRASHED: ${err}`);
    process.exit(1);
  }

  // ── Step 2: Print extracted JSON ──
  header('📄 STEP 2: EXTRACTED JSON');
  divider();
  console.log(JSON.stringify(result, null, 2));

  // ── Step 3: Run validation ──
  header('🧪 STEP 3: VALIDATION');
  const report = validateResult(result);

  // ── Step 4: Stats ──
  header('📈 STEP 4: EXTRACTION STATS');
  divider();
  info(`Subject: "${result.subject}"`);
  info(`From: ${result.from}`);
  info(`To: ${result.to.join(', ')}`);
  info(`CC: ${result.cc.length > 0 ? result.cc.join(', ') : '(none)'}`);
  info(`BCC: ${result.bcc.length > 0 ? result.bcc.join(', ') : '(none)'}`);
  info(`Date: ${result.date || '(not available)'}`);
  info(`Body text length: ${result.body_text.length} characters`);
  info(`Body HTML cleaned length: ${result.body_html_cleaned.length} characters`);
  info(`Attachment count: ${result.attachments.length}`);
  for (const att of result.attachments) {
    info(`  → ${att.filename} (${att.extracted_text.length} chars extracted)`);
  }

  // ── Step 5: Pipeline output test ──
  header('🔗 STEP 5: PIPELINE-READY OUTPUT (extractMsgForPipeline)');
  divider();
  try {
    const pipelineResult = await extractMsgForPipeline(fs.readFileSync(filePath));
    info(`Combined text length: ${pipelineResult.text.length} characters`);
    info(`Metadata keys: ${Object.keys(pipelineResult.metadata).join(', ')}`);
    console.log(`\n${DIM}--- First 500 chars of combined text ---${RESET}`);
    console.log(pipelineResult.text.substring(0, 500));
    console.log(`${DIM}...${RESET}`);
    pass('Pipeline output generated successfully');
  } catch (err) {
    fail(`Pipeline output failed: ${err}`);
  }

  // ── Final summary ──
  header('🏁 FINAL SUMMARY');
  console.log(`${BOLD}═══════════════════════════════════════════════════════════${RESET}`);
  console.log(`  Total checks:  ${report.totalChecks}`);
  console.log(`  ${GREEN}Passed:${RESET}        ${report.passed}`);
  console.log(`  ${RED}Failed:${RESET}        ${report.failed}`);
  console.log(`  ${YELLOW}Warnings:${RESET}      ${report.warnings.length}`);
  console.log(`${BOLD}═══════════════════════════════════════════════════════════${RESET}`);

  if (report.failed === 0) {
    console.log(`\n  ${GREEN}${BOLD}✅ ALL CHECKS PASSED — MSG extraction is working correctly${RESET}\n`);
    process.exit(0);
  } else {
    console.log(`\n  ${RED}${BOLD}❌ ${report.failed} CHECK(S) FAILED — Review output above${RESET}\n`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\n${RED}Fatal error:${RESET}`, err);
  process.exit(1);
});
