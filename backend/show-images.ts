import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function showImages() {
  const { data: images, error } = await supabase
    .from('vault_assets')
    .select('*')
    .eq('parent_asset_id', '11c17e0e-15d8-40ff-961d-3bdcb1c4abb1')
    .eq('asset_type', 'image')
    .order('image_index', { ascending: true });

  if (error) {
    console.error('Error:', error);
    return;
  }

  console.log('📸 Extracted Images from OJ Simpson Case:\n');
  
  for (const img of images || []) {
    console.log(`--- Image ${(img.image_index ?? 0) + 1} ---`);
    console.log(`  File: ${img.filename}`);
    console.log(`  Page: ${img.source_page}`);
    console.log(`  Classification: ${img.classification || 'pending'}`);
    console.log(`  Size: ${(img.file_size / 1024).toFixed(1)} KB`);
    console.log(`  Storage: ${img.storage_path}`);
    
    // Get signed URL
    const { data: urlData } = await supabase.storage
      .from('documents')
      .createSignedUrl(img.storage_path, 3600);
    
    if (urlData?.signedUrl) {
      console.log(`  URL: ${urlData.signedUrl.substring(0, 100)}...`);
    }
    console.log('');
  }
}

showImages();
