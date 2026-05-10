/**
 * Trigger extraction for all files that don't have intelligence data
 */
import { createClient } from '@supabase/supabase-js';
import { Queue } from 'bullmq';
import * as dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const extractionQueue = new Queue('legal-extraction', {
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
  },
});

async function triggerMissingIntelligence() {
  console.log('\n🔍 Finding files without intelligence data...\n');

  // Get all ready files from all matters (excluding General Documents)
  const { data: files, error: filesError } = await supabase
    .from('vault_assets')
    .select(`
      id,
      filename,
      case_id,
      tenant_id,
      status,
      cases!inner(name)
    `)
    .eq('status', 'ready')
    .neq('cases.name', 'General Documents');

  if (filesError) {
    console.error('❌ Error fetching files:', filesError.message);
    return;
  }

  console.log(`Found ${files.length} ready files (excluding General Documents)`);

  let needsExtraction = 0;
  let alreadyHasIntelligence = 0;
  const jobsToQueue: any[] = [];

  for (const file of files) {
    // Check if file has any intelligence data
    const { count: entityCount } = await supabase
      .from('matter_entities')
      .select('*', { count: 'exact', head: true })
      .eq('file_id', file.id);

    const { count: clauseCount } = await supabase
      .from('matter_clauses')
      .select('*', { count: 'exact', head: true })
      .eq('file_id', file.id);

    const { count: obligationCount } = await supabase
      .from('matter_obligations')
      .select('*', { count: 'exact', head: true })
      .eq('file_id', file.id);

    const totalIntelligence = (entityCount || 0) + (clauseCount || 0) + (obligationCount || 0);

    if (totalIntelligence === 0) {
      // Check if document has chunks (required for extraction)
      const { count: chunkCount } = await supabase
        .from('document_chunks')
        .select('*', { count: 'exact', head: true })
        .eq('file_id', file.id);

      if (chunkCount && chunkCount > 0) {
        console.log(`⚠️  NO INTELLIGENCE: ${file.filename} (${file.id}) - has ${chunkCount} chunks`);
        needsExtraction++;
        jobsToQueue.push({
          file_id: file.id,
          tenant_id: file.tenant_id,
          case_id: file.case_id,
          filename: file.filename,
        });
      } else {
        console.log(`⏭️  SKIP: ${file.filename} - no chunks available`);
      }
    } else {
      alreadyHasIntelligence++;
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   ✅ Files with intelligence: ${alreadyHasIntelligence}`);
  console.log(`   ⚠️  Files needing extraction: ${needsExtraction}`);

  if (needsExtraction === 0) {
    console.log('\n✨ All files already have intelligence data!');
    await extractionQueue.close();
    return;
  }

  console.log(`\n🚀 Queueing ${needsExtraction} extraction jobs...\n`);

  for (const jobData of jobsToQueue) {
    try {
      const job = await extractionQueue.add(
        'extract-legal-intelligence',
        jobData,
        {
          jobId: `extract-${jobData.file_id}`,
          priority: 5,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        }
      );
      console.log(`   ✅ Queued: ${jobData.filename} (Job ID: ${job.id})`);
    } catch (error) {
      console.error(`   ❌ Failed to queue ${jobData.filename}:`, error);
    }
  }

  console.log(`\n✅ Done! ${needsExtraction} extraction jobs queued.`);
  console.log(`\nℹ️  Monitor progress by checking the extraction worker logs.`);
  console.log(`   The extraction worker should be running: npm run worker:extraction`);

  await extractionQueue.close();
}

triggerMissingIntelligence().catch(console.error);
