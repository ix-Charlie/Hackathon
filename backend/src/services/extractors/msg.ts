/**
 * MSG (Microsoft Outlook Email) Text Extractor
 * 
 * Pure local parsing — no API calls, no AI, no embedding, no network.
 * Uses @kenjiuno/msgreader for OLE2 compound file parsing
 * and html-to-text for HTML body cleanup.
 * 
 * Follows the same pattern as pdf.ts, docx.ts, xlsx.ts extractors.
 */

import MsgReaderModule from '@kenjiuno/msgreader';
import { convert as htmlToText } from 'html-to-text';
import * as CFB from 'cfb';

// Handle CJS default export interop
const MsgReader = (MsgReaderModule as any).default || MsgReaderModule;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MsgAttachment {
  filename: string;
  extracted_text: string;
}

export interface MsgExtractionResult {
  text: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  date: string;
  bodyText: string;
  bodyHtmlCleaned: string;
  attachments: MsgAttachment[];
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
  const textExtensions = [
    'txt', 'csv', 'md', 'log', 'json', 'xml', 'html', 'htm',
    'yaml', 'yml', 'ini', 'conf', 'sql', 'js', 'ts', 'py',
    'rb', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'css', 'scss',
  ];

  if (!textExtensions.includes(ext)) {
    return `[Binary attachment: ${filename}]`;
  }

  try {
    const text = Buffer.from(content).toString('utf-8');
    // Verify it's actually readable text
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

/**
 * Try to extract HTML body directly from the CFB container
 * MsgReader doesn't expose this property, so we read it ourselves.
 * Property tag 0x1035001E = PR_BODY_HTML (ANSI string)
 * Property tag 0x1035001F = PR_BODY_HTML (Unicode string)
 */
function extractHtmlBodyFromCfb(buffer: Buffer): string {
  try {
    const cfb = CFB.read(buffer);
    
    // Try ANSI HTML body first (0x1035001E)
    const ansiEntry = cfb.FileIndex.find(e => 
      e.name === '__substg1.0_1035001E'
    );
    if (ansiEntry && ansiEntry.content && ansiEntry.size > 0) {
      return Buffer.from(ansiEntry.content).toString('utf-8');
    }

    // Try Unicode HTML body (0x1035001F)
    const unicodeEntry = cfb.FileIndex.find(e => 
      e.name === '__substg1.0_1035001F'
    );
    if (unicodeEntry && unicodeEntry.content && unicodeEntry.size > 0) {
      // UTF-16LE decode
      const buf = Buffer.from(unicodeEntry.content);
      const chars: string[] = [];
      for (let i = 0; i < buf.length - 1; i += 2) {
        chars.push(String.fromCharCode(buf.readUInt16LE(i)));
      }
      return chars.join('');
    }
  } catch {
    // Fallback: no HTML body available
  }
  return '';
}

// ─── Main extraction function ───────────────────────────────────────────────

/**
 * Extract text from a .msg (Outlook email) buffer
 * Returns combined text and structured metadata.
 */
export async function extractMsgText(buffer: Buffer): Promise<MsgExtractionResult> {
  console.log(`📧 Extracting MSG email from ${buffer.length} bytes...`);

  const arrayBuf = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
  const reader = new MsgReader(arrayBuf);
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
          to.push(formatted);
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
  // MsgReader doesn't expose HTML body, so we read it from CFB directly
  const rawHtml = extractHtmlBodyFromCfb(buffer);
  const bodyHtmlCleaned = cleanHtmlBody(rawHtml);

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

  // ── Build combined text for RAG ──
  const parts: string[] = [];

  if (subject) parts.push(`Subject: ${subject}`);
  if (from) parts.push(`From: ${from}`);
  if (to.length > 0) parts.push(`To: ${to.join('; ')}`);
  if (cc.length > 0) parts.push(`CC: ${cc.join('; ')}`);
  if (bcc.length > 0) parts.push(`BCC: ${bcc.join('; ')}`);
  if (date) parts.push(`Date: ${date}`);

  parts.push(''); // blank separator

  // Use whichever body version is richer
  const mainBody = bodyHtmlCleaned.length > bodyText.length ? bodyHtmlCleaned : bodyText;
  if (mainBody) parts.push(mainBody);

  // Append readable attachment text
  for (const att of attachments) {
    if (att.extracted_text && !att.extracted_text.startsWith('[Binary attachment:')) {
      parts.push('');
      parts.push(`--- Attachment: ${att.filename} ---`);
      parts.push(att.extracted_text);
    }
  }

  const combinedText = parts.join('\n');

  console.log(`✅ MSG extracted: subject="${subject}", body=${bodyText.length} chars, ${attachments.length} attachment(s)`);

  return {
    text: combinedText,
    subject,
    from,
    to,
    cc,
    bcc,
    date: date ? String(date) : '',
    bodyText,
    bodyHtmlCleaned,
    attachments,
  };
}
