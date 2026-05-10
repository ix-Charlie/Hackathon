# Hybrid RAG Implementation Plan
## Based on Existing Database Schema

**Date:** December 19, 2025  
**Branch:** `hybrid-rag`  
**Architecture:** Multi-tenant with vector search

---

## ✅ Existing Database (Already Good!)

Your database already has most of what we need:

### **Table: `document_files`**
Stores file metadata and location
- ✅ `id` (uuid) - File identifier
- ✅ `tenant_id` (uuid) - Multi-tenant support
- ✅ `filename` (text) - Original filename
- ✅ `filetype` (text) - MIME type
- ✅ `storage_path` (text) - Storage location
- ✅ `uploaded_by` (uuid) - User who uploaded
- ✅ `created_at` (timestamp)

### **Table: `document_chunks`**
Perfect for RAG! Stores text chunks with embeddings
- ✅ `id` (bigint) - Chunk identifier
- ✅ `tenant_id` (uuid) - Multi-tenant isolation
- ✅ `file_id` (uuid) - Links to document_files
- ✅ `content` (text) - The actual chunk text
- ✅ `embedding` (vector) - **Already has vector support!**
- ✅ `metadata` (jsonb) - Can store page numbers, etc.
- ✅ `created_at` (timestamp)

### **Table: `chat_sessions` & `chat_messages`**
Already set up for chat history
- ✅ Sessions linked to user_id and tenant_id
- ✅ Messages have role (user/assistant) and content

### **Table: `usage_logs`**
Perfect for tracking API usage
- ✅ `tokens_in` / `tokens_out` - Track OpenAI usage
- ✅ `model` - Track which model used
- ✅ Links to user_id and tenant_id

### **Table: `user_rate_limits`**
Already configured for rate limiting
- ✅ `request_count` - Current usage
- ✅ `limit_per_hour` - Max requests
- ✅ `window_start` - Rate limit window

---

## 📝 Required Database Modifications

### **1. Add Missing Columns to `document_files`**
```sql
ALTER TABLE document_files 
ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id),
ADD COLUMN IF NOT EXISTS status text DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'error', 'deleted')),
ADD COLUMN IF NOT EXISTS file_size_bytes bigint,
ADD COLUMN IF NOT EXISTS page_count integer,
ADD COLUMN IF NOT EXISTS processing_error text;

CREATE INDEX IF NOT EXISTS idx_document_files_user_id ON document_files(user_id);
CREATE INDEX IF NOT EXISTS idx_document_files_tenant_status ON document_files(tenant_id, status);
```

**Why:** Track processing status and link directly to users for RLS

### **2. Add Missing Columns to `document_chunks`**
```sql
ALTER TABLE document_chunks 
ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id),
ADD COLUMN IF NOT EXISTS chunk_index integer,
ADD COLUMN IF NOT EXISTS token_count integer;

CREATE INDEX IF NOT EXISTS idx_document_chunks_file_id ON document_chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_user_id ON document_chunks(user_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_tenant_id ON document_chunks(tenant_id);
```

**Why:** Track chunk order and enable user-level RLS

### **3. Enable pgvector Extension**
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

**Why:** Required for vector similarity search

### **4. Create Vector Index**
```sql
-- Drop old index if exists
DROP INDEX IF EXISTS document_chunks_embedding_idx;

-- Create new optimized index
CREATE INDEX document_chunks_embedding_idx 
ON document_chunks 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
```

**Why:** Speeds up similarity search by 100x+

### **5. Create Similarity Search Function**
```sql
CREATE OR REPLACE FUNCTION match_document_chunks(
  query_embedding vector(1536),
  user_id_param uuid,
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 5
)
RETURNS TABLE (
  id bigint,
  file_id uuid,
  content text,
  metadata jsonb,
  similarity float,
  filename text
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.id,
    dc.file_id,
    dc.content,
    dc.metadata,
    1 - (dc.embedding <=> query_embedding) AS similarity,
    df.filename
  FROM document_chunks dc
  JOIN document_files df ON dc.file_id = df.id
  WHERE dc.user_id = user_id_param
    AND 1 - (dc.embedding <=> query_embedding) > match_threshold
  ORDER BY dc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
```

**Why:** Core function for RAG - finds relevant chunks for user queries

### **6. Add RLS Policies**
```sql
-- Enable RLS
ALTER TABLE document_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;

-- Users can only see their own files
CREATE POLICY "Users can view own files"
ON document_files FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own files"
ON document_files FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Users can only see their own chunks
CREATE POLICY "Users can view own chunks"
ON document_chunks FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own chunks"
ON document_chunks FOR INSERT
WITH CHECK (auth.uid() = user_id);
```

**Why:** Security - users can't access other users' documents

---

## 🚀 Implementation Phases

### **Phase 1: Database Migration** (15 minutes)
1. Run all ALTER TABLE commands
2. Enable pgvector extension
3. Create vector index
4. Create similarity search function
5. Enable RLS policies
6. Verify everything works

### **Phase 2: File Processing Pipeline** (2 hours)
1. Create `services/documentProcessingService.ts`
   - Text extraction (PDF, DOCX, etc.)
   - Chunking strategy (500 words per chunk)
   - Store file metadata in `document_files`
   
2. Create `services/embeddingService.ts`
   - Call OpenAI Embeddings API
   - Batch processing for efficiency
   - Store embeddings in `document_chunks`
   
3. Update file upload flow
   - Upload → Extract → Chunk → Embed → Store
   - Show processing status to user

### **Phase 3: RAG Search Service** (1 hour)
1. Create `services/ragService.ts`
   - Embed user query
   - Call `match_document_chunks()` function
   - Return top relevant chunks
   
2. Update Edge Function
   - Use RAG search instead of sending all files
   - Send only relevant chunks to OpenAI

### **Phase 4: UI Updates** (1 hour)
1. Show document library (from `document_files` table)
2. Display processing status
3. Show which documents were used in response
4. Add "Delete Document" functionality

### **Phase 5: Usage Tracking** (30 minutes)
1. Log token usage to `usage_logs` table
2. Enforce rate limits from `user_rate_limits`
3. Check subscription tier limits

---

## 📊 Data Flow

```
User uploads file
    ↓
[document_files] status='processing'
    ↓
Extract text → Chunk into 500-word pieces
    ↓
Generate embeddings (OpenAI API)
    ↓
[document_chunks] store chunks + embeddings
    ↓
[document_files] status='ready'

---

User asks question
    ↓
Embed question (OpenAI API)
    ↓
match_document_chunks(query_embedding, user_id)
    ↓
Get top 5 relevant chunks
    ↓
Send chunks + question to OpenAI GPT-4o
    ↓
Return answer
    ↓
[usage_logs] log tokens used
```

---

## 🎯 Next Steps

**IMMEDIATE:**
1. ✅ Confirm database modifications needed
2. ❌ Run SQL migrations on Supabase dashboard
3. ❌ Verify vector extension and indexes
4. ❌ Test similarity search function

**Want me to generate the complete SQL migration script to run?**
