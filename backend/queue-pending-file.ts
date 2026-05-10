/**
 * Quick script to queue a pending file for processing
 * Usage: tsx queue-pending-file.ts <file_id>
 */

import { supabaseAdmin } from './src/config/supabase.js';
import { addDocumentJob } from './src/services/queueService.js';

const fileId = process.argv[2];

if (!fileId) {
  console.error('Usage: tsx queue-pending-file.ts <file_id>');
  process.exit(1);
}

async function queueFile() {
  console.log(`\n📄 Fetching file ${fileId}...`);

  const { data: file, error } = await supabaseAdmin
    .from('vault_assets')
    .select('*')
    .eq('id', fileId)
    .single();

  if (error || !file) {
    console.error('❌ File not found:', error);
    process.exit(1);
  }

  console.log(`✅ Found: ${file.filename}`);
  console.log(`   Status: ${file.status}`);

  if (file.status === 'processing' || file.status === 'ready') {
    console.log('⚠️  File is already processed or processing');
    process.exit(0);
  }

  console.log('\n🚀 Queueing for processing...');

  const job = await addDocumentJob({
    file_id: file.id,
    tenant_id: file.tenant_id,
    case_id: file.case_id,
    folder_id: file.folder_id,
    storage_path: file.storage_path,
    filename: file.filename,
    filetype: file.filetype,
    user_id: file.uploaded_by || 'system',
    created_at: file.created_at,
  });

  console.log(`✅ Queued! Job ID: ${job.id}`);
  console.log(`   The worker will pick it up shortly.`);
  
  process.exit(0);
}

queueFile().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
