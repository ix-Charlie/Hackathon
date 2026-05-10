// @deno-types="https://deno.land/x/types/index.d.ts"

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Type declarations for Deno
declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
};

interface ProcessDocumentRequest {
  file_id: string;
  tenant_id: string;
  case_id: string;
  folder_id?: string;
  storage_path: string;
  filename: string;
  filetype: string;
}

interface TextChunk {
  content: string;
  metadata: {
    filename: string;
    chunk_index: number;
    total_chunks: number;
    start_char: number;
    end_char: number;
  };
}

// ============================================================================
// TEXT EXTRACTION
// ============================================================================

/**
 * Extract text from various file types
 */
async function extractText(
  fileBlob: Blob,
  filename: string,
  mimeType: string
): Promise<string> {
  console.log(`📄 Extracting text from: ${filename} (${mimeType})`);

  // Plain text files
  if (mimeType.startsWith('text/') || mimeType === 'application/json') {
    return await fileBlob.text();
  }

  // CSV files
  if (mimeType === 'text/csv' || filename.endsWith('.csv')) {
    return await fileBlob.text();
  }

  // PDF files - use pdf-parse compatible approach
  if (mimeType === 'application/pdf' || filename.endsWith('.pdf')) {
    return await extractPdfText(fileBlob);
  }

  // Word documents (.docx)
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    filename.endsWith('.docx')
  ) {
    return await extractDocxText(fileBlob);
  }

  // Fallback: try to read as text
  try {
    return await fileBlob.text();
  } catch {
    throw new Error(`Unsupported file type: ${mimeType}`);
  }
}

/**
 * Extract text from PDF using PDF.js (Mozilla's production-grade library)
 * Modular design: OCR can be added as fallback later
 */
async function extractPdfText(blob: Blob): Promise<string> {
  console.log('📄 Starting PDF.js text extraction...');
  console.log(`📄 Blob size: ${blob.size} bytes`);
  
  try {
    // Dynamic import of PDF.js - use legacy build for better Deno compatibility
    const pdfjsLib = await import("https://esm.sh/pdfjs-dist@3.11.174/legacy/build/pdf.mjs");
    
    // Convert blob to ArrayBuffer
    const arrayBuffer = await blob.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    
    console.log(`📄 ArrayBuffer size: ${arrayBuffer.byteLength} bytes`);
    
    // Load the PDF document
    const loadingTask = pdfjsLib.getDocument({
      data: uint8Array,
      // Disable worker for Deno/Edge compatibility
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
      disableFontFace: true,
    });
    
    const pdf = await loadingTask.promise;
    console.log(`📄 PDF loaded successfully: ${pdf.numPages} pages`);
    
    const textParts: string[] = [];
    
    // Extract text from each page
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      try {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        
        // Combine text items with proper spacing
        let lastY: number | null = null;
        let pageText = '';
        
        for (const item of textContent.items) {
          if ('str' in item && item.str) {
            // Check if we need a newline (different Y position)
            if (lastY !== null && 'transform' in item) {
              const currentY = item.transform[5];
              if (Math.abs(currentY - lastY) > 5) {
                pageText += '\n';
              } else if (pageText && !pageText.endsWith(' ')) {
                pageText += ' ';
              }
            }
            
            pageText += item.str;
            
            if ('transform' in item) {
              lastY = item.transform[5];
            }
          }
        }
        
        if (pageText.trim()) {
          textParts.push(pageText.trim());
          console.log(`📄 Page ${pageNum}: extracted ${pageText.length} chars`);
        } else {
          console.log(`📄 Page ${pageNum}: no text found (may be image/scanned)`);
        }
      } catch (pageError) {
        console.error(`❌ Error extracting page ${pageNum}:`, pageError);
      }
    }
    
    const fullText = textParts.join('\n\n');
    console.log(`✅ PDF.js total extracted: ${fullText.length} characters from ${pdf.numPages} pages`);
    
    // Validate extracted text is meaningful (not garbage)
    const meaningfulChars = fullText.replace(/[^a-zA-Z0-9\s]/g, '').length;
    const meaningfulRatio = meaningfulChars / Math.max(fullText.length, 1);
    console.log(`📊 Meaningful char ratio: ${(meaningfulRatio * 100).toFixed(1)}%`);
    
    if (fullText.length < 50 || meaningfulRatio < 0.3) {
      console.warn('⚠️ PDF.js extracted minimal/garbage text. PDF may be scanned/image-based.');
      return `[PDF Document: "${blob.size > 100000 ? 'Large' : 'Small'} PDF" - This appears to be a scanned document or image-based PDF. Text extraction requires OCR processing which is not yet available. The document has ${pdf.numPages} page(s).]`;
    }
    
    return fullText;
    
  } catch (error) {
    console.error('❌ PDF.js extraction failed:', error);
    console.error('Error details:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
    
    // Return informative message instead of garbage
    return `[PDF Document: Text extraction failed. This PDF may be corrupted, password-protected, or require OCR for scanned content. Error: ${error instanceof Error ? error.message : 'Unknown error'}]`;
  }
}

/**
 * Extract text from DOCX files
 * DOCX is a ZIP containing XML files
 */
async function extractDocxText(blob: Blob): Promise<string> {
  // DOCX is a ZIP file - we need to extract document.xml
  // Using a simplified approach for Deno
  
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const content = decoder.decode(bytes);
  
  // Look for text content in the XML
  const textMatches = content.match(/<w:t[^>]*>([^<]+)<\/w:t>/g);
  
  if (textMatches) {
    const text = textMatches
      .map(match => {
        const textContent = match.replace(/<[^>]+>/g, '');
        return textContent;
      })
      .join(' ');
    
    return text.replace(/\s+/g, ' ').trim();
  }
  
  // Fallback: extract any readable text
  return content
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^\x20-\x7E\n\r\t]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================================
// TEXT CHUNKING
// ============================================================================

/**
 * Split text into overlapping chunks for better context
 */
function chunkText(
  text: string,
  filename: string,
  chunkSize: number = 1500,  // ~375 tokens (4 chars per token average)
  overlap: number = 200      // ~50 tokens overlap
): TextChunk[] {
  const chunks: TextChunk[] = [];
  
  if (!text || text.length === 0) {
    return [];
  }
  
  // Clean the text
  const cleanedText = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  
  // Split by sentences for better chunk boundaries
  const sentences = cleanedText.split(/(?<=[.!?])\s+/);
  
  let currentChunk = '';
  let startChar = 0;
  let chunkIndex = 0;
  
  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > chunkSize && currentChunk.length > 0) {
      // Save current chunk
      chunks.push({
        content: currentChunk.trim(),
        metadata: {
          filename,
          chunk_index: chunkIndex,
          total_chunks: 0, // Will be updated after
          start_char: startChar,
          end_char: startChar + currentChunk.length,
        },
      });
      
      // Start new chunk with overlap
      const words = currentChunk.split(' ');
      const overlapWords = words.slice(-Math.ceil(overlap / 5)); // ~5 chars per word
      currentChunk = overlapWords.join(' ') + ' ' + sentence;
      startChar = startChar + currentChunk.length - overlap;
      chunkIndex++;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + sentence;
    }
  }
  
  // Add final chunk
  if (currentChunk.trim()) {
    chunks.push({
      content: currentChunk.trim(),
      metadata: {
        filename,
        chunk_index: chunkIndex,
        total_chunks: 0,
        start_char: startChar,
        end_char: startChar + currentChunk.length,
      },
    });
  }
  
  // Update total_chunks count
  const totalChunks = chunks.length;
  chunks.forEach(chunk => {
    chunk.metadata.total_chunks = totalChunks;
  });
  
  console.log(`📦 Created ${chunks.length} chunks from ${cleanedText.length} characters`);
  return chunks;
}

// ============================================================================
// EMBEDDING GENERATION
// ============================================================================

/**
 * Generate embeddings using OpenAI API
 * Uses text-embedding-3-small (1536 dimensions) - best cost/quality ratio
 */
async function generateEmbeddings(
  texts: string[],
  openaiApiKey: string
): Promise<number[][]> {
  const MODEL = 'text-embedding-3-small'; // 1536 dims, $0.02/1M tokens
  console.log(`🧠 Generating embeddings for ${texts.length} chunks...`);
  
  // OpenAI has a limit of 8191 tokens per text and 2048 texts per batch
  // We'll process in smaller batches to be safe
  const BATCH_SIZE = 100;
  const allEmbeddings: number[][] = [];
  
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        input: batch,
      }),
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error(`❌ OpenAI embedding error:`, error);
      throw new Error(`Failed to generate embeddings: ${error}`);
    }
    
    const data = await response.json();
    const embeddings = data.data.map((item: { embedding: number[] }) => item.embedding);
    allEmbeddings.push(...embeddings);
    
    console.log(`✅ Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${embeddings.length} embeddings generated`);
  }
  
  return allEmbeddings;
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // 1. AUTHENTICATION
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const openaiApiKey = Deno.env.get('OPENAI_API_KEY')!;

    if (!openaiApiKey) {
      return new Response(
        JSON.stringify({ error: 'OpenAI API key not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Use service role for database operations (bypasses RLS)
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Also create client with user token for auth verification
    const supabaseClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } }
    });

    // Verify user is authenticated
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token);
    
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 2. PARSE REQUEST
    const body: ProcessDocumentRequest = await req.json();
    
    const { file_id, tenant_id, case_id, folder_id, storage_path, filename, filetype } = body;
    
    if (!file_id || !tenant_id || !storage_path || !filename) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: file_id, tenant_id, storage_path, filename' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`📥 Processing document: ${filename} (${file_id})`);

    // 3. UPDATE STATUS TO PROCESSING
    await supabaseAdmin
      .from('vault_assets')
      .update({ status: 'processing' })
      .eq('id', file_id);

    // 4. DOWNLOAD FILE FROM STORAGE
    const { data: fileData, error: downloadError } = await supabaseAdmin.storage
      .from('documents')
      .download(storage_path);

    if (downloadError || !fileData) {
      console.error('❌ Failed to download file:', downloadError);
      await supabaseAdmin
        .from('vault_assets')
        .update({ status: 'failed' })
        .eq('id', file_id);
      
      return new Response(
        JSON.stringify({ error: 'Failed to download file from storage' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 5. EXTRACT TEXT
    let extractedText: string;
    try {
      extractedText = await extractText(fileData, filename, filetype);
      console.log(`📄 Extracted ${extractedText.length} characters`);
    } catch (extractError) {
      console.error('❌ Text extraction failed:', extractError);
      await supabaseAdmin
        .from('vault_assets')
        .update({ status: 'failed' })
        .eq('id', file_id);
      
      return new Response(
        JSON.stringify({ error: `Text extraction failed: ${extractError}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 6. CHUNK TEXT
    const chunks = chunkText(extractedText, filename);
    
    if (chunks.length === 0) {
      console.warn('⚠️ No chunks created - file may be empty or unreadable');
      await supabaseAdmin
        .from('vault_assets')
        .update({ status: 'ready' }) // Mark as ready but with no chunks
        .eq('id', file_id);
      
      return new Response(
        JSON.stringify({ 
          success: true, 
          message: 'File processed but no extractable text found',
          chunks_created: 0 
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 7. GENERATE EMBEDDINGS (single model for cost efficiency)
    const chunkTexts = chunks.map(c => c.content);
    const embeddings = await generateEmbeddings(chunkTexts, openaiApiKey);

    // 8. SAVE CHUNKS TO DATABASE
    const chunkRecords = chunks.map((chunk, index) => ({
      tenant_id,
      file_id,
      case_id,
      folder_id: folder_id || null,
      content: chunk.content,
      metadata: chunk.metadata,
      embedding: embeddings[index],
      // Note: 'fts' column is auto-generated from content via GENERATED ALWAYS AS
    }));

    // Delete any existing chunks for this file (in case of reprocessing)
    await supabaseAdmin
      .from('document_chunks')
      .delete()
      .eq('file_id', file_id);

    // Insert new chunks in batches
    const CHUNK_BATCH_SIZE = 50;
    for (let i = 0; i < chunkRecords.length; i += CHUNK_BATCH_SIZE) {
      const batch = chunkRecords.slice(i, i + CHUNK_BATCH_SIZE);
      
      const { error: insertError } = await supabaseAdmin
        .from('document_chunks')
        .insert(batch);
      
      if (insertError) {
        console.error(`❌ Failed to insert chunk batch:`, insertError);
        throw new Error(`Failed to save chunks: ${insertError.message}`);
      }
      
      console.log(`✅ Saved chunks ${i + 1} - ${Math.min(i + CHUNK_BATCH_SIZE, chunkRecords.length)}`);
    }

    // 9. UPDATE FILE STATUS TO READY
    await supabaseAdmin
      .from('vault_assets')
      .update({ status: 'ready' })
      .eq('id', file_id);

    console.log(`✅ Document processed successfully: ${filename}`);

    return new Response(
      JSON.stringify({
        success: true,
        file_id,
        filename,
        text_length: extractedText.length,
        chunks_created: chunks.length,
        embeddings_generated: embeddings.length,
        model: 'text-embedding-3-small',
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('❌ Process document error:', error);
    return new Response(
      JSON.stringify({ error: `Processing failed: ${error}` }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
