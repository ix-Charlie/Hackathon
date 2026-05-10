import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function check() {
  // Check vault_assets for images (unified table)
  const { data: images, error: imgError } = await supabase
    .from('vault_assets')
    .select('*')
    .eq('asset_type', 'image')
    .limit(5);
  
  console.log('vault_assets images:');
  console.log('Error:', imgError?.message || 'None');
  console.log('Count:', images?.length || 0);
  
  // Check OJ Simpson file status
  const { data: files } = await supabase
    .from('vault_assets')
    .select('id, filename, status')
    .ilike('filename', '%simpson%')
    .limit(5);
  
  console.log('\nOJ Simpson files:');
  console.log(JSON.stringify(files, null, 2));
  
  // Check document_processing for image info
  if (files && files.length > 0) {
    for (const f of files) {
      const { data: dp } = await supabase
        .from('document_processing')
        .select('has_images, image_count, has_ocr_content')
        .eq('asset_id', f.id)
        .single();
      console.log(`  ${f.filename} processing:`, dp);
    }
  }
}

check();
