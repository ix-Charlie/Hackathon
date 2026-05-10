/**
 * MSG (Microsoft Outlook Email) Text Extractor
 * 
 * Pure local parsing — no API calls, no AI, no embedding, no network.
 * Uses @kenjiuno/msgreader for OLE2 compound file parsing
 * and html-to-text for HTML body cleanup.
 * 
 * Follows the same pattern as pdf.ts, docx.ts, xlsx.ts extractors.
 * 
 * Usage:
 *   import { parseMsgFile, extractMsgText } from './msg.js';
 *   const result = await parseMsgFile('/path/to/file.msg');
 *   // or from buffer:
 *   const result = await extractMsgText(buffer);
 */

import MsgReaderModule from '@kenjiuno/msgreader';
import { convert as htmlToText } from 'html-to-text';
import * as CFB from 'cfb';
import fs from 'fs';

// Handle CJS default export interop
const MsgReader = (MsgReaderModule as any).default || MsgReaderModule;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MsgAttachment {
  filename: string;
  extracted_text: string;
}

export interface MsgExtractionResult {
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  date: string;
  body_text: string;
  body_html_cleaned: string;
  attachments: MsgAttachment[];
}

export interface MsgExtractorOutput {
  text: string;
  metadata: {
    subject: string;
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    date: string;
    attachmentCount: number;
    attachmentNames: string[];
  };
}

// ─── Recipient type constants (MAPI) ────────────────────────────────────────

const MAPI_TO: 'to'   = 'to';
const MAPI_CC: 'cc'   = 'cc';
const MAPI_BCC: 'bcc' = 'bcc';

// ─── Text cleaning utilities ────────────────────────────────────────────────

/**
 * Remove binary noise, encoding artifacts, and tracking junk from text
 */
function cleanTextContent(text: string): string {
  if (!text) return '';

  return text
    // Remove null bytes and control characters (except newlines/tabs)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Remove CID references (inline image placeholders)
    .replace(/\[?cid:[^\]\s>]+\]?/gi, '')
    // Remove tracking pixel indicators
    .replace(/<img[^>]*(?:tracking|pixel|beacon)[^>]*>/gi, '')
    // Remove Microsoft-specific XML tags
    .replace(/<o:p>[\s\S]*?<\/o:p>/gi, '')
    .replace(/<\/?o:[^>]+>/gi, '')
    // Remove encoded artifacts like =20, =3D, etc.
    .replace(/=[0-9A-F]{2}/gi, (match) => {
      try {
        return String.fromCharCode(parseInt(match.slice(1), 16));
      } catch {
        return '';
      }
    })
    // Normalize line endings
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Collapse excessive whitespace on single lines
    .replace(/[ \t]+/g, ' ')
    // Collapse 3+ consecutive blank lines into 2
    .replace(/\n{3,}/g, '\n\n')
    // Trim each line
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    // Final trim
    .trim();
}

/**
 * Convert HTML body to clean readable text
 */
function cleanHtmlBody(html: string): string {
  if (!html) return '';

  // Pre-clean: remove tracking pixels and CID images before conversion
  let cleaned = html
    .replace(/<img[^>]*src=["']cid:[^"']*["'][^>]*>/gi, '')
    .replace(/<img[^>]*(?:tracking|pixel|beacon|width=["']1["']|height=["']1["'])[^>]*>/gi, '')
    .replace(/<o:p>[\s\S]*?<\/o:p>/gi, '')
    .replace(/<\/?o:[^>]+>/gi, '');

  // Convert HTML to plain text
  const text = htmlToText(cleaned, {
    wordwrap: false,
    preserveNewlines: true,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'a', options: { ignoreHref: false } },
      { selector: 'table', format: 'dataTable' },
    ],
  });

  return cleanTextContent(text);
}

/**
 * Try to extract readable text from an attachment's binary content
 */
function extractAttachmentText(content: Uint8Array, filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  const textExtensions = ['txt', 'csv', 'md', 'log', 'json', 'xml', 'html', 'htm', 'yaml', 'yml', 'ini', 'conf', 'sql', 'js', 'ts', 'py', 'rb', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'css', 'scss'];

  if (!textExtensions.includes(ext)) {
    return `[Binary attachment: ${filename}]`;
  }

  try {
    const text = Buffer.from(content).toString('utf-8');
    // Verify it's actually readable text (not binary masquerading as text)
    const printableRatio = text.replace(/[^\x20-\x7E\n\r\t]/g, '').length / Math.max(text.length, 1);
    if (printableRatio < 0.7) {
      return `[Binary attachment: ${filename}]`;
    }
    return cleanTextContent(text);
  } catch {
    return `[Binary attachment: ${filename}]`;
  }
}

/**
 * Format a recipient entry (name + email if both available)
 */
function formatRecipient(recipient: any): string {
  const name = recipient.name || '';
  const email = recipient.smtpAddress || recipient.email || '';

  if (name && email && name !== email) {
    return `${name} <${email}>`;
  }
  return name || email || 'Unknown';
}

// ─── Main extraction functions ──────────────────────────────────────────────

/**
 * Extract structured data from a .msg file buffer
 * This is the core parsing function — pure local, no API calls.
 */
export async function extractMsgText(buffer: Buffer): Promise<MsgExtractionResult> {
  console.log(`📧 Extracting MSG email from ${buffer.length} bytes...`);

  const reader = new MsgReader(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
  const fileData = reader.getFileData();

  // ── Subject ──
  const subject = fileData.subject || '';

  // ── Sender ──
  const senderName = fileData.senderName || '';
  const senderEmail = (fileData as any).senderSmtpAddress || (fileData as any).senderEmail || '';
  const from = senderName && senderEmail && senderName !== senderEmail
    ? `${senderName} <${senderEmail}>`
    : senderName || senderEmail || 'Unknown';

  // ── Recipients (To / CC / BCC) ──
  const to: string[] = [];
  const cc: string[] = [];
  const bcc: string[] = [];

  if (fileData.recipients && Array.isArray(fileData.recipients)) {
    for (const recip of fileData.recipients) {
      const formatted = formatRecipient(recip);
      const recipType = recip.recipType ?? MAPI_TO as 'to' | 'cc' | 'bcc';

      switch (recipType) {
        case MAPI_TO:
          to.push(formatted);
          break;
        case MAPI_CC:
          cc.push(formatted);
          break;
        case MAPI_BCC:
          bcc.push(formatted);
          break;
        default:
          to.push(formatted); // Default to "To" if unknown
      }
    }
  }

  // Fallback: if recipients array empty but display fields exist
  if (to.length === 0 && (fileData as any).displayTo) {
    to.push(...(fileData as any).displayTo.split(';').map((s: string) => s.trim()).filter(Boolean));
  }
  if (cc.length === 0 && (fileData as any).displayCc) {
    cc.push(...(fileData as any).displayCc.split(';').map((s: string) => s.trim()).filter(Boolean));
  }
  if (bcc.length === 0 && (fileData as any).displayBcc) {
    bcc.push(...(fileData as any).displayBcc.split(';').map((s: string) => s.trim()).filter(Boolean));
  }

  // ── Date ──
  const date = (fileData as any).messageDeliveryTime
    || (fileData as any).clientSubmitTime
    || (fileData as any).creationTime
    || '';

  // ── Body (plain text) ──
  const bodyText = cleanTextContent(fileData.body || '');

  // ── Body HTML → cleaned text ──
  // MsgReader doesn't extract HTML body natively, so we read it directly from CFB
  let bodyHtml = (fileData as any).bodyHtml || (fileData as any).htmlBody || '';

  if (!bodyHtml) {
    // Fallback: read PR_BODY_HTML (0x1035) directly from the OLE2 compound file
    try {
      const cfb = CFB.read(buffer);
      // Try ANSI string (001E) first, then Unicode (001F)
      const htmlStreamNames = [
        '/__substg1.0_1035001E',   // PR_BODY_HTML as PT_STRING8
        '/__substg1.0_1035001F',   // PR_BODY_HTML as PT_UNICODE
      ];
      for (const streamName of htmlStreamNames) {
        const entry = CFB.find(cfb, streamName);
        if (entry && entry.content && entry.content.length > 0) {
          if (streamName.endsWith('001F')) {
            // Unicode: decode UTF-16LE
            bodyHtml = Buffer.from(entry.content).toString('utf16le');
          } else {
            // ANSI / UTF-8
            bodyHtml = Buffer.from(entry.content).toString('utf-8');
          }
          break;
        }
      }
    } catch (cfbErr) {
      console.warn('⚠️ Could not read HTML body from CFB:', cfbErr);
    }
  }

  const bodyHtmlCleaned = cleanHtmlBody(bodyHtml);

  // ── Attachments ──
  const attachments: MsgAttachment[] = [];

  if (fileData.attachments && Array.isArray(fileData.attachments)) {
    for (const attInfo of fileData.attachments) {
      const filename = attInfo.fileName || attInfo.name || 'unnamed_attachment';

      let extractedText = '';
      try {
        const attData = reader.getAttachment(attInfo);
        if (attData && attData.content) {
          extractedText = extractAttachmentText(attData.content, filename);
        } else {
          extractedText = `[Attachment present but content not extractable: ${filename}]`;
        }
      } catch (err) {
        extractedText = `[Error extracting attachment: ${filename}]`;
        console.warn(`⚠️ Could not extract attachment "${filename}":`, err);
      }

      attachments.push({ filename, extracted_text: extractedText });
    }
  }

  console.log(`✅ MSG extracted: subject="${subject}", body=${bodyText.length} chars, ${attachments.length} attachment(s)`);

  return {
    subject,
    from,
    to,
    cc,
    bcc,
    date: date ? String(date) : '',
    body_text: bodyText,
    body_html_cleaned: bodyHtmlCleaned,
    attachments,
  };
}

/**
 * Parse a .msg file from a file path
 * Convenience wrapper around extractMsgText
 */
export async function parseMsgFile(filePath: string): Promise<MsgExtractionResult> {
  const buffer = fs.readFileSync(filePath);
  return extractMsgText(Buffer.from(buffer));
}

/**
 * Extract text from a .msg buffer in the format expected by the extractor index
 * (matching ExtractionResult interface from extractors/index.ts)
 * 
 * This produces a single combined text string suitable for RAG chunking,
 * plus structured metadata.
 */
export async function extractMsgForPipeline(buffer: Buffer): Promise<MsgExtractorOutput> {
  const parsed = await extractMsgText(buffer);

  // Build a single combined text block that's optimal for RAG
  const parts: string[] = [];

  if (parsed.subject) {
    parts.push(`Subject: ${parsed.subject}`);
  }
  if (parsed.from) {
    parts.push(`From: ${parsed.from}`);
  }
  if (parsed.to.length > 0) {
    parts.push(`To: ${parsed.to.join('; ')}`);
  }
  if (parsed.cc.length > 0) {
    parts.push(`CC: ${parsed.cc.join('; ')}`);
  }
  if (parsed.bcc.length > 0) {
    parts.push(`BCC: ${parsed.bcc.join('; ')}`);
  }
  if (parsed.date) {
    parts.push(`Date: ${parsed.date}`);
  }

  parts.push(''); // blank line separator

  // Prefer HTML-cleaned body if available and longer, else plain text
  const bodyToUse = parsed.body_html_cleaned.length > parsed.body_text.length
    ? parsed.body_html_cleaned
    : parsed.body_text;

  if (bodyToUse) {
    parts.push(bodyToUse);
  }

  // Append attachment text
  for (const att of parsed.attachments) {
    if (att.extracted_text && !att.extracted_text.startsWith('[Binary attachment:')) {
      parts.push('');
      parts.push(`--- Attachment: ${att.filename} ---`);
      parts.push(att.extracted_text);
    }
  }

  return {
    text: parts.join('\n'),
    metadata: {
      subject: parsed.subject,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      bcc: parsed.bcc,
      date: parsed.date,
      attachmentCount: parsed.attachments.length,
      attachmentNames: parsed.attachments.map(a => a.filename),
    },
  };
}
