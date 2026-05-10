// Run this with: node setup-backend.js

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🚀 Setting up Node.js backend for document processing...\n');

// Helper to create file with directories
function createFile(path, content) {
  const fullPath = join(__dirname, path);
  const dir = dirname(fullPath);
  
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  writeFileSync(fullPath, content, 'utf8');
  console.log(`✅ Created: ${path}`);
}

// 1. Server entry point
createFile('server/index.ts', `import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { processDocumentHandler } from './routes/processDocument.js';

// Load environment variables
dotenv.config({ path: '../.env' });

const app = express();
const PORT = process.env.API_PORT || 3001;

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Document processing endpoint
app.post('/api/process-document', processDocumentHandler);

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('❌ Server error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Start server
app.listen(PORT, () => {
  console.log(\`🚀 Document processing API running on port \${PORT}\`);
  console.log(\`📄 Endpoint: http://localhost:\${PORT}/api/process-document\`);
});

export default app;
`);

// 2. Process document route
createFile('server/routes/processDocument.ts', `import { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { processDocument } from '../services/documentProcessor.js';

interface ProcessDocumentRequest {
  file_id: string;
  tenant_id: string;
  case_id: string;
  folder_id?: string;
  storage_path: string;
  filename: string;
  filetype: string;
}

export async function processDocumentHandler(req: Request, res: Response): Promise<void> {
  try {
    // 1. AUTHENTICATION
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ error: 'Missing authorization header' });
      return;
    }

    const supabaseUrl = process.env.SUPABASE_URL!;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY!;
    const openaiApiKey = process.env.OPENAI_API_KEY!;

    if (!supabaseUrl || !supabaseServiceKey || !openaiApiKey) {
      res.status(500).json({ error: 'Server configuration missing' });
      return;
    }

    // Use service role for database operations (bypasses RLS)
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Create client with user token for auth verification
    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    // Verify user is authenticated
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token);
    
    if (authError || !user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // 2. PARSE REQUEST
    const body: ProcessDocumentRequest = req.body;
    
    const { file_id, tenant_id, case_id, folder_id, storage_path, filename, filetype } = body;
    
    if (!file_id || !tenant_id || !storage_path || !filename) {
      res.status(400).json({ 
        error: 'Missing required fields: file_id, tenant_id, storage_path, filename' 
      });
      return;
    }

    console.log(\`📥 Processing document: \${filename} (\${file_id})\`);

    // 3. PROCESS DOCUMENT
    const result = await processDocument({
      supabaseAdmin,
      openaiApiKey,
      file_id,
      tenant_id,
      case_id,
      folder_id,
      storage_path,
      filename,
      filetype,
    });

    res.json(result);

  } catch (error) {
    console.error('❌ Process document error:', error);
    res.status(500).json({ 
      error: \`Processing failed: \${error instanceof Error ? error.message : error}\` 
    });
  }
}
`);

// 3. Document processor (core logic) - PART 1
const processorPart1 = `import { SupabaseClient } from '@supabase/supabase-js';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';

// ============================================================================
// TYPES
// ============================================================================

interface ProcessDocumentParams {
  supabaseAdmin: SupabaseClient;
  openaiApiKey: string;
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

interface ProcessResult {
  success: boolean;
  file_id: string;
  filename: string;
  text_length: number;
  chunks_created: number;
  embeddings_generated: number;
  model: string;
}

// ============================================================================
// TEXT EXTRACTION
// ============================================================================

async function extractText(
  fileBuffer: Buffer,
  filename: string,
  mimeType: string
): Promise<string> {
  console.log(\`📄 Extracting text from: \${filename} (\${mimeType})\`);

  if (mimeType.startsWith('text/') || mimeType === 'application/json') {
    return fileBuffer.toString('utf-8');
  }

  if (mimeType === 'text/csv' || filename.endsWith('.csv')) {
    return fileBuffer.toString('utf-8');
  }

  if (mimeType === 'application/pdf' || filename.endsWith('.pdf')) {
    return await extractPdfText(fileBuffer);
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    filename.endsWith('.docx')
  ) {
    return await extractDocxText(fileBuffer);
  }

  try {
    return fileBuffer.toString('utf-8');
  } catch {
    throw new Error(\`Unsupported file type: \${mimeType}\`);
  }
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  console.log('📄 Starting PDF.js text extraction...');
  console.log(\`📄 Buffer size: \${buffer.length} bytes\`);
  
  try {
    const uint8Array = new Uint8Array(buffer);
    
    const loadingTask = pdfjsLib.getDocument({
      data: uint8Array,
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
      disableFontFace: true,
    });
    
    const pdf = await loadingTask.promise;
    console.log(\`📄 PDF loaded successfully: \${pdf.numPages} pages\`);
    
    const textParts: string[] = [];
    
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      try {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        
        let lastY: number | null = null;
        let pageText = '';
        
        for (const item of textContent.items) {
          if ('str' in item && item.str) {
            if (lastY !== null && 'transform' in item) {
              const currentY = (item as any).transform[5];
              if (Math.abs(currentY - lastY) > 5) {
                pageText += '\\n';
              } else if (pageText && !pageText.endsWith(' ')) {
                pageText += ' ';
              }
            }
            
            pageText += item.str;
            
            if ('transform' in item) {
              lastY = (item as any).transform[5];
            }
          }
        }
        
        if (pageText.trim()) {
          textParts.push(pageText.trim());
          console.log(\`📄 Page \${pageNum}: extracted \${pageText.length} chars\`);
        } else {
          console.log(\`📄 Page \${pageNum}: no text found (may be image/scanned)\`);
        }
      } catch (pageError) {
        console.error(\`❌ Error extracting page \${pageNum}:\`, pageError);
      }
    }
    
    const fullText = textParts.join('\\n\\n');
    console.log(\`✅ PDF.js total extracted: \${fullText.length} characters from \${pdf.numPages} pages\`);
    
    const meaningfulChars = fullText.replace(/[^a-zA-Z0-9\\s]/g, '').length;
    const meaningfulRatio = meaningfulChars / Math.max(fullText.length, 1);
    console.log(\`📊 Meaningful char ratio: \${(meaningfulRatio * 100).toFixed(1)}%\`);
    
    if (fullText.length < 50 || meaningfulRatio < 0.3) {
      console.warn('⚠️ PDF.js extracted minimal/garbage text. PDF may be scanned/image-based.');
      return \`[PDF Document: This appears to be a scanned document or image-based PDF. Text extraction requires OCR processing which is not yet available. The document has \${pdf.numPages} page(s).]\`;
    }
    
    return fullText;
    
  } catch (error) {
    console.error('❌ PDF.js extraction failed:', error);
    return \`[PDF Document: Text extraction failed. Error: \${error instanceof Error ? error.message : 'Unknown error'}]\`;
  }
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  console.log('📄 Starting DOCX text extraction with mammoth...');
  
  try {
    const result = await mammoth.extractRawText({ buffer });
    console.log(\`✅ DOCX extracted: \${result.value.length} characters\`);
    return result.value;
  } catch (error) {
    console.error('❌ DOCX extraction failed:', error);
    throw new Error(\`DOCX extraction failed: \${error}\`);
  }
}
`;

const processorPart2 = `
// ============================================================================
// TEXT CHUNKING
// ============================================================================

function chunkText(
  text: string,
  filename: string,
  chunkSize: number = 1500,
  overlap: number = 200
): TextChunk[] {
  const chunks: TextChunk[] = [];
  
  if (!text || text.length === 0) {
    return [];
  }
  
  const cleanedText = text
    .replace(/\\r\\n/g, '\\n')
    .replace(/\\r/g, '\\n')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim();
  
  const sentences = cleanedText.split(/(?<=[.!?])\\s+/);
  
  let currentChunk = '';
  let startChar = 0;
  let chunkIndex = 0;
  
  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > chunkSize && currentChunk.length > 0) {
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
      
      const words = currentChunk.split(' ');
      const overlapWords = words.slice(-Math.ceil(overlap / 5));
      currentChunk = overlapWords.join(' ') + ' ' + sentence;
      startChar = startChar + currentChunk.length - overlap;
      chunkIndex++;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + sentence;
    }
  }
  
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
  
  const totalChunks = chunks.length;
  chunks.forEach(chunk => {
    chunk.metadata.total_chunks = totalChunks;
  });
  
  console.log(\`📦 Created \${chunks.length} chunks from \${cleanedText.length} characters\`);
  return chunks;
}

// ============================================================================
// EMBEDDING GENERATION
// ============================================================================

async function generateEmbeddings(
  texts: string[],
  openaiApiKey: string
): Promise<number[][]> {
  const MODEL = 'text-embedding-3-small';
  console.log(\`🧠 Generating embeddings for \${texts.length} chunks...\`);
  
  const BATCH_SIZE = 100;
  const allEmbeddings: number[][] = [];
  
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': \`Bearer \${openaiApiKey}\`,
      },
      body: JSON.stringify({
        model: MODEL,
        input: batch,
      }),
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error(\`❌ OpenAI embedding error:\`, error);
      throw new Error(\`Failed to generate embeddings: \${error}\`);
    }
    
    const data = await response.json();
    const embeddings = data.data.map((item: { embedding: number[] }) => item.embedding);
    allEmbeddings.push(...embeddings);
    
    console.log(\`✅ Batch \${Math.floor(i / BATCH_SIZE) + 1}: \${embeddings.length} embeddings generated\`);
  }
  
  return allEmbeddings;
}

// ============================================================================
// MAIN PROCESSOR
// ============================================================================

export async function processDocument(params: ProcessDocumentParams): Promise<ProcessResult> {
  const {
    supabaseAdmin,
    openaiApiKey,
    file_id,
    tenant_id,
    case_id,
    folder_id,
    storage_path,
    filename,
    filetype,
  } = params;

  await supabaseAdmin
    .from('vault_assets')
    .update({ status: 'processing' })
    .eq('id', file_id);

  try {
    const { data: fileData, error: downloadError } = await supabaseAdmin.storage
      .from('documents')
      .download(storage_path);

    if (downloadError || !fileData) {
      console.error('❌ Failed to download file:', downloadError);
      await supabaseAdmin
        .from('vault_assets')
        .update({ status: 'failed' })
        .eq('id', file_id);
      
      throw new Error('Failed to download file from storage');
    }

    const arrayBuffer = await fileData.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const extractedText = await extractText(buffer, filename, filetype);
    console.log(\`📄 Extracted \${extractedText.length} characters\`);

    const chunks = chunkText(extractedText, filename);
    
    if (chunks.length === 0) {
      console.warn('⚠️ No chunks created - file may be empty or unreadable');
      await supabaseAdmin
        .from('vault_assets')
        .update({ status: 'ready' })
        .eq('id', file_id);
      
      return {
        success: true,
        file_id,
        filename,
        text_length: extractedText.length,
        chunks_created: 0,
        embeddings_generated: 0,
        model: 'text-embedding-3-small',
      };
    }

    const chunkTexts = chunks.map(c => c.content);
    const embeddings = await generateEmbeddings(chunkTexts, openaiApiKey);

    const chunkRecords = chunks.map((chunk, index) => ({
      tenant_id,
      file_id,
      case_id,
      folder_id: folder_id || null,
      content: chunk.content,
      metadata: chunk.metadata,
      embedding: embeddings[index],
    }));

    await supabaseAdmin
      .from('document_chunks')
      .delete()
      .eq('file_id', file_id);

    const CHUNK_BATCH_SIZE = 50;
    for (let i = 0; i < chunkRecords.length; i += CHUNK_BATCH_SIZE) {
      const batch = chunkRecords.slice(i, i + CHUNK_BATCH_SIZE);
      
      const { error: insertError } = await supabaseAdmin
        .from('document_chunks')
        .insert(batch);
      
      if (insertError) {
        console.error(\`❌ Failed to insert chunk batch:\`, insertError);
        throw new Error(\`Failed to save chunks: \${insertError.message}\`);
      }
      
      console.log(\`✅ Saved chunks \${i + 1} - \${Math.min(i + CHUNK_BATCH_SIZE, chunkRecords.length)}\`);
    }

    await supabaseAdmin
      .from('vault_assets')
      .update({ status: 'ready' })
      .eq('id', file_id);

    console.log(\`✅ Document processed successfully: \${filename}\`);

    return {
      success: true,
      file_id,
      filename,
      text_length: extractedText.length,
      chunks_created: chunks.length,
      embeddings_generated: embeddings.length,
      model: 'text-embedding-3-small',
    };

  } catch (error) {
    console.error('❌ Document processing failed:', error);
    
    await supabaseAdmin
      .from('vault_assets')
      .update({ status: 'failed' })
      .eq('id', file_id);
    
    throw error;
  }
}
`;

createFile('server/services/documentProcessor.ts', processorPart1 + processorPart2);

// 4. Package.json
createFile('server/package.json', `{
  "name": "maks-document-processor",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx watch index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.39.0",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "express": "^4.18.2",
    "mammoth": "^1.6.0",
    "pdfjs-dist": "^3.11.174"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/node": "^22.14.0",
    "tsx": "^4.7.0",
    "typescript": "^5.8.2"
  }
}
`);

// 5. TypeScript config
createFile('server/tsconfig.json', `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": ".",
    "declaration": true
  },
  "include": ["./**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
`);

// 6. Update .env instruction
console.log('\n📝 Next steps:');
console.log('1. Add to your .env file:');
console.log('   DOCUMENT_PROCESSOR_URL=http://localhost:3001');
console.log('   SUPABASE_SERVICE_ROLE_KEY=your_service_role_key');
console.log('   (OPENAI_API_KEY should already be there)');
console.log('\n2. Install server dependencies:');
console.log('   cd server && npm install');
console.log('\n3. Start the server:');
console.log('   npm run dev');
console.log('\n4. In another terminal, start your frontend:');
console.log('   npm run dev');
console.log('\n✅ Setup complete! Now manually update services/fileService.ts');
console.log('   Replace the SUPABASE_URL/functions/v1/process-document');
console.log('   with: http://localhost:3001/api/process-document\n');