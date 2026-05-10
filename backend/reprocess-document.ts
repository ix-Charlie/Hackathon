/**
 * Script to reprocess a document to extract images
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { Queue } from 'bullmq';
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const queue = new Queue('document-processing', {
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
  },
});

async function reprocessDocument() {
  // Find the OJ Simpson file
  const { data: files, error } = await supabase
    .from('vault_assets')
    .select('id, filename, storage_path, case_id, tenant_id, file_type')
    .ilike('filename', '%simpson%')
    .order('created_at', { ascending: false })
    .limit(1);

  if (error || !files || files.length === 0) {
    console.error('Could not find OJ Simpson file:', error);
    return;
  }

  const file = files[0];
  console.log('Found file:', file);

  // Reset status to pending
  await supabase
    .from('vault_assets')
    .update({ status: 'pending' })
    .eq('id', file.id);

  // Delete existing chunks to reprocess
  await supabase
    .from('document_chunks')
    .delete()
    .eq('document_file_id', file.id);

  // Delete existing child images (vault_assets with parent_asset_id)
  await supabase
    .from('vault_assets')
    .delete()
    .eq('parent_asset_id', file.id)
    .eq('asset_type', 'image');

  // Add to queue
  const job = await queue.add('process-document', {
    file_id: file.id,
    tenant_id: file.tenant_id,
    case_id: file.case_id,
    folder_id: null,
    storage_path: file.storage_path,
    filename: file.filename,
    filetype: file.file_type || 'application/pdf',
  });

  console.log('Added job to queue:', job.id);
  console.log('File will be reprocessed with image extraction enabled');
  
  await queue.close();
}

reprocessDocument().catch(console.error);
