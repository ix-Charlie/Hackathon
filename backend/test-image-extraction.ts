/**
 * Test image extraction on existing OJ Simpson file
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { extractPdfImages } from './src/services/extractors/pdfImages.js';
import { processAndStoreImages } from './src/services/imageService.js';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function testImageExtraction() {
  console.log('🔍 Finding OJ Simpson file...');
  
  // Find the file
  const { data: files, error: findError } = await supabase
    .from('vault_assets')
    .select('id, filename, storage_path, tenant_id, filetype')
    .ilike('filename', '%simpson%')
    .order('created_at', { ascending: false })
    .limit(1);

  if (findError || !files || files.length === 0) {
    console.error('❌ Could not find file:', findError);
    return;
  }

  const file = files[0];
  console.log('📄 Found file:', file.filename);
  console.log('   Storage path:', file.storage_path);
  console.log('   File ID:', file.id);
  console.log('   Tenant ID:', file.tenant_id);

  // Download the file
  console.log('\n📥 Downloading file from storage...');
  const { data: blob, error: downloadError } = await supabase.storage
    .from('documents')
    .download(file.storage_path);

  if (downloadError || !blob) {
    console.error('❌ Download failed:', downloadError);
    return;
  }

  const buffer = Buffer.from(await blob.arrayBuffer());
  console.log('✅ Downloaded', buffer.length, 'bytes');

  // Extract images
  console.log('\n🖼️ Extracting images from PDF...');
  try {
    const result = await extractPdfImages(buffer, (current, total) => {
      console.log(`   Processing page ${current}/${total}`);
    });

    console.log('\n📊 Extraction Result:');
    console.log('   Images found:', result.images.length);
    console.log('   Needs OCR:', result.needsOcr);

    if (result.images.length > 0) {
      console.log('\n🖼️ Image details:');
      result.images.forEach((img, i) => {
        console.log(`   ${i + 1}. ${img.filename} - Page ${img.pageNumber}, ${img.width}x${img.height}, ${img.buffer.length} bytes`);
      });

      // Store images in database
      console.log('\n💾 Storing images in database...');
      const storedImages = await processAndStoreImages(
        result.images,
        file.id,
        file.tenant_id,
        result.needsOcr,
        (current, total) => console.log(`   Storing image ${current}/${total}`)
      );

      console.log('\n✅ Stored', storedImages.length, 'images');
      
      // Update document_processing table
      await supabase
        .from('document_processing')
        .upsert({
          asset_id: file.id,
          has_images: storedImages.length > 0,
          image_count: storedImages.length,
          has_ocr_content: storedImages.some(img => img.ocrText && img.ocrText.length > 0)
        }, { onConflict: 'asset_id' });

      console.log('✅ Updated document_processing record');

      // Show OCR results
      const withOcr = storedImages.filter(img => img.ocrText);
      if (withOcr.length > 0) {
        console.log('\n📝 OCR Results:');
        withOcr.forEach(img => {
          console.log(`\n--- ${img.filename} (confidence: ${(img.ocrConfidence! * 100).toFixed(1)}%) ---`);
          console.log(img.ocrText?.substring(0, 500) + (img.ocrText && img.ocrText.length > 500 ? '...' : ''));
        });
      }
    } else {
      console.log('\n⚠️ No images found in PDF');
      console.log('This PDF might be text-only (not scanned)');
    }
  } catch (err) {
    console.error('❌ Image extraction failed:', err);
  }
}

testImageExtraction().catch(console.error);
