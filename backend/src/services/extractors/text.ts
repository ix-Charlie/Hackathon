/**
 * Plain Text Extractor
 * Handles: .txt, .md, .json, .xml, .html, .css, .js, etc.
 */

export interface TextExtractionResult {
  text: string;
  encoding: string;
}

/**
 * Extract text from a plain text buffer
 */
export async function extractPlainText(
  buffer: Buffer,
  mimeType?: string
): Promise<TextExtractionResult> {
  console.log(`📄 Extracting plain text from ${buffer.length} bytes...`);

  // Try UTF-8 first
  let text = buffer.toString('utf-8');
  let encoding = 'utf-8';

  // Check for BOM and handle different encodings
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    // UTF-16 LE BOM
    text = buffer.toString('utf16le');
    encoding = 'utf-16le';
  } else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    // UTF-16 BE BOM
    text = buffer.swap16().toString('utf16le');
    encoding = 'utf-16be';
  } else if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    // UTF-8 BOM - remove it
    text = buffer.slice(3).toString('utf-8');
  }

  // Clean up based on content type
  if (mimeType === 'application/json') {
    text = cleanJsonText(text);
  } else if (mimeType === 'text/html' || mimeType === 'application/xhtml+xml') {
    text = cleanHtmlText(text);
  } else if (mimeType === 'text/xml' || mimeType === 'application/xml') {
    text = cleanXmlText(text);
  }

  console.log(`✅ Text extracted: ${text.length} characters (${encoding})`);

  return { text, encoding };
}

/**
 * Clean JSON text for readability
 */
function cleanJsonText(text: string): string {
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

/**
 * Clean HTML text - extract readable content
 */
function cleanHtmlText(text: string): string {
  return text
    // Remove script tags and content
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    // Remove style tags and content
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Replace block elements with newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|br)[^>]*>/gi, '\n')
    // Remove remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Clean whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Clean XML text - extract readable content
 */
function cleanXmlText(text: string): string {
  return text
    // Remove XML declaration
    .replace(/<\?xml[^>]*\?>/gi, '')
    // Remove CDATA markers but keep content
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    // Remove comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Clean whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
