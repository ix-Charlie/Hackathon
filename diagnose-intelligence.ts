/**
 * Diagnostic script to check matter intelligence status
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.VITE_SUPABASE_SERVICE_ROLE_KEY!
);

async function diagnose() {
  console.log('\n🔍 DIAGNOSING MATTER INTELLIGENCE\n');

  // 1. Check if intelligence tables exist
  console.log('1️⃣ Checking if intelligence tables exist...');
  const tables = ['matter_entities', 'matter_clauses', 'matter_obligations', 'matter_dates', 'matter_risks', 'extraction_jobs'];
  
  for (const table of tables) {
    try {
      const { count, error } = await supabase
        .from(table)
        .select('*', { count: 'exact', head: true });
      
      if (error) {
        console.error(`   ❌ Table '${table}' error:`, error.message);
      } else {
        console.log(`   ✅ Table '${table}' exists (${count} records)`);
      }
    } catch (err) {
      console.error(`   ❌ Table '${table}' check failed:`, err);
    }
  }

  // 2. Check recent extraction jobs
  console.log('\n2️⃣ Checking recent extraction jobs...');
  const { data: jobs, error: jobsError } = await supabase
    .from('extraction_jobs')
    .select('id, file_id, status, model_used, tokens_used, results, error, created_at, completed_at')
    .order('created_at', { ascending: false })
    .limit(10);

  if (jobsError) {
    console.error('   ❌ Error fetching extraction jobs:', jobsError.message);
  } else if (!jobs || jobs.length === 0) {
    console.log('   ⚠️ No extraction jobs found');
  } else {
    console.log(`   Found ${jobs.length} recent extraction jobs:`);
    for (const job of jobs) {
      console.log(`\n   Job ${job.id}:`);
      console.log(`     Status: ${job.status}`);
      console.log(`     File ID: ${job.file_id}`);
      console.log(`     Model: ${job.model_used || 'N/A'}`);
      console.log(`     Tokens: ${job.tokens_used || 0}`);
      console.log(`     Created: ${job.created_at}`);
      console.log(`     Completed: ${job.completed_at || 'N/A'}`);
      if (job.results) {
        console.log(`     Results:`, job.results);
      }
      if (job.error) {
        console.log(`     ❌ Error: ${job.error}`);
      }
    }
  }

  // 3. Check which matters have files
  console.log('\n3️⃣ Checking matters with files...');
  const { data: cases, error: casesError } = await supabase
    .from('cases')
    .select('id, name, (vault_assets(count))')
    .order('created_at', { ascending: false })
    .limit(5);

  if (casesError) {
    console.error('   ❌ Error fetching cases:', casesError.message);
  } else {
    for (const c of cases || []) {
      console.log(`   Matter: ${c.name} (${c.id})`);
      
      // Get file count for this matter
      const { count: fileCount } = await supabase
        .from('vault_assets')
        .select('*', { count: 'exact', head: true })
        .eq('case_id', c.id);
      
      // Get intelligence count for this matter
      const { count: entityCount } = await supabase
        .from('matter_entities')
        .select('*', { count: 'exact', head: true })
        .eq('case_id', c.id);
      
      const { count: clauseCount } = await supabase
        .from('matter_clauses')
        .select('*', { count: 'exact', head: true })
        .eq('case_id', c.id);
      
      const { count: obligationCount } = await supabase
        .from('matter_obligations')
        .select('*', { count: 'exact', head: true })
        .eq('case_id', c.id);
      
      console.log(`     Files: ${fileCount || 0}`);
      console.log(`     Entities: ${entityCount || 0}`);
      console.log(`     Clauses: ${clauseCount || 0}`);
      console.log(`     Obligations: ${obligationCount || 0}`);
    }
  }

  // 4. Check if files have chunks (required for extraction)
  console.log('\n4️⃣ Checking if files have document chunks...');
  const { data: assets, error: assetsError } = await supabase
    .from('vault_assets')
    .select('id, filename, case_id, status')
    .eq('status', 'ready')
    .order('created_at', { ascending: false })
    .limit(5);

  if (assetsError) {
    console.error('   ❌ Error fetching files:', assetsError.message);
  } else {
    for (const asset of assets || []) {
      const { count: chunkCount } = await supabase
        .from('document_chunks')
        .select('*', { count: 'exact', head: true })
        .eq('file_id', asset.id);
      
      const { data: extractionJob } = await supabase
        .from('extraction_jobs')
        .select('status, error')
        .eq('file_id', asset.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      
      console.log(`\n   File: ${asset.filename} (${asset.id})`);
      console.log(`     Chunks: ${chunkCount || 0}`);
      console.log(`     Extraction Job: ${extractionJob?.status || 'none'}`);
      if (extractionJob?.error) {
        console.log(`     ❌ Job Error: ${extractionJob.error}`);
      }
    }
  }

  console.log('\n✅ Diagnosis complete!');
}

diagnose().catch(console.error);
