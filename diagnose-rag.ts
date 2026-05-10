/**
 * Diagnostic script to check RAG system health
 * Checks: documents, chunks, embeddings
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function diagnoseRAG() {
  console.log('🔍 RAG System Diagnostic\n');
  
  // 1. Check authentication
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    console.error('❌ Not authenticated. Please log in first.');
    process.exit(1);
  }
  console.log(`✅ Authenticated as: ${user.email}\n`);
  
  // 2. Get tenant_id
  const { data: memberData } = await supabase
    .from('tenant_members')
    .select('tenant_id')
    .eq('user_id', user.id)
    .single();
  
  if (!memberData?.tenant_id) {
    console.error('❌ No tenant found for user');
    process.exit(1);
  }
  const tenantId = memberData.tenant_id;
  console.log(`✅ Tenant ID: ${tenantId}\n`);
  
  // 3. Check documents
  const { data: files, error: filesError } = await supabase
    .from('files')
    .select('id, name, file_type, created_at, processing_status')
    .eq('tenant_id', tenantId);
  
  if (filesError) {
    console.error('❌ Error fetching files:', filesError);
  } else if (!files || files.length === 0) {
    console.log('⚠️  No documents found in your vault.\n');
    console.log('Upload documents first to use RAG search.');
    process.exit(0);
  } else {
    console.log(`✅ Found ${files.length} documents:\n`);
    files.forEach((f, i) => {
      console.log(`   ${i + 1}. ${f.name} (${f.file_type}) - ${f.processing_status}`);
    });
    console.log('');
  }
  
  // 4. Check chunks
  const { data: chunks, error: chunksError } = await supabase
    .from('document_chunks')
    .select('id, file_id, content, embedding')
    .in('file_id', files.map(f => f.id))
    .limit(100);
  
  if (chunksError) {
    console.error('❌ Error fetching chunks:', chunksError);
  } else if (!chunks || chunks.length === 0) {
    console.log('⚠️  No chunks found for your documents!\n');
    console.log('Documents were uploaded but not processed into searchable chunks.');
    console.log('Check the backend worker/processing service.');
  } else {
    console.log(`✅ Found ${chunks.length} chunks\n`);
    
    // Check embeddings
    const chunksWithEmbeddings = chunks.filter(c => c.embedding && c.embedding.length > 0);
    const chunksWithoutEmbeddings = chunks.length - chunksWithEmbeddings.length;
    
    if (chunksWithEmbeddings.length === 0) {
      console.log('❌ NO EMBEDDINGS FOUND!');
      console.log('   Chunks exist but have no vector embeddings.');
      console.log('   This is why search returns nothing.');
      console.log('   Check embedding generation in backend.\n');
    } else if (chunksWithoutEmbeddings > 0) {
      console.log(`⚠️  ${chunksWithoutEmbeddings} chunks missing embeddings`);
      console.log(`✅ ${chunksWithEmbeddings.length} chunks have embeddings\n`);
    } else {
      console.log(`✅ All chunks have embeddings!\n`);
    }
    
    // Show sample chunk
    const sampleChunk = chunks[0];
    console.log('Sample chunk:');
    console.log(`  Content preview: ${sampleChunk.content.substring(0, 100)}...`);
    console.log(`  Has embedding: ${sampleChunk.embedding ? 'Yes' : 'No'}`);
    console.log('');
  }
  
  // 5. Test search for "Alishba"
  console.log('🔍 Testing search for "Alishba"...\n');
  
  const { data: searchResults, error: searchError } = await supabase
    .from('document_chunks')
    .select('content, metadata')
    .in('file_id', files.map(f => f.id))
    .ilike('content', '%alishba%');
  
  if (searchError) {
    console.error('❌ Search error:', searchError);
  } else if (!searchResults || searchResults.length === 0) {
    console.log('⚠️  No chunks contain "Alishba" (case-insensitive text search)');
    console.log('   The text might be in a different format or not extracted properly.');
  } else {
    console.log(`✅ Found ${searchResults.length} chunks mentioning "Alishba":\n`);
    searchResults.slice(0, 3).forEach((chunk, i) => {
      console.log(`--- Chunk ${i + 1} ---`);
      console.log(chunk.content.substring(0, 200) + '...\n');
    });
  }
  
  console.log('\n✨ Diagnostic complete!');
}

diagnoseRAG().catch(console.error);
