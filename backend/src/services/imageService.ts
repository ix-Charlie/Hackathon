/**
 * Image Extraction Service — Unified via vault_assets
 *
 * Extracted images from PDFs/DOCX/XLSX are now stored as vault_assets
 * with parent_asset_id linking back to the parent document. Each image
 * is queued through the full Phase B image pipeline (OCR, classification,
 * thumbnail, summary, entity extraction, case linking).
 *
 * The legacy `document_images` table is eliminated.
 */

import { supabaseAdmin } from '../config/supabase.js';
import { performOcr, mightContainText, OcrResult } from './ocrService.js';
import { addImageJob } from './queueService.js';
import { ProcessImageJob } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

export interface ExtractedImage {
  buffer: Buffer;
  filename: string;
  pageNumber?: number;
  imageIndex: number;
  width?: number;
  height?: number;
  mimeType: string;
  // Metadata for context
  surroundingText?: string;
  caption?: string;
}

export interface StoredImage {
  id: string;
  storagePath: string;
  filename: string;
  pageNumber?: number;
  imageIndex: number;
  width?: number;
  height?: number;
  mimeType: string;
  fileSize: number;
  ocrText?: string;
  ocrConfidence?: number;
  // Metadata for context
  surroundingText?: string;
  caption?: string;
}

/**
 * Process and store extracted images into vault_assets,
 * then queue each through the full image processing pipeline.
 *
 * Quick inline OCR is still performed here so that OCR text can be
 * appended to the parent document's text before chunking. The pipeline
 * will later run the full Vision-based OCR + classification + summary.
 */
export async function processAndStoreImages(
  images: ExtractedImage[],
  parentAssetId: string,
  tenantId: string,
  performOcrOnImages: boolean = true,
  onProgress?: (current: number, total: number) => void
): Promise<StoredImage[]> {
  console.log(`🖼️ Processing ${images.length} images from document into vault_assets...`);

  // Look up parent document to inherit case_id / folder_id / uploaded_by
  const { data: parentDoc } = await supabaseAdmin
    .from('vault_assets')
    .select('case_id, folder_id, uploaded_by')
    .eq('id', parentAssetId)
    .single();

  const caseId = parentDoc?.case_id ?? null;
  const folderId = parentDoc?.folder_id ?? null;
  const uploadedBy = parentDoc?.uploaded_by ?? null;

  const storedImages: StoredImage[] = [];

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    onProgress?.(i + 1, images.length);

    try {
      const imageId = uuidv4();

      // Generate storage path under parent document's namespace
      const storagePath = `${tenantId}/images/${parentAssetId}/${image.imageIndex}_${image.filename}`;

      // Upload raw image to Supabase Storage
      const { error: uploadError } = await supabaseAdmin.storage
        .from('documents')
        .upload(storagePath, image.buffer, {
          contentType: image.mimeType,
          upsert: true,
        });

      if (uploadError) {
        console.error(`❌ Failed to upload image ${image.filename}:`, uploadError);
        continue;
      }

      // Quick inline OCR for document chunking (the full pipeline does deeper OCR later)
      let ocrResult: OcrResult | null = null;
      if (performOcrOnImages && mightContainText(image.width ?? 0, image.height ?? 0)) {
        try {
          ocrResult = await performOcr(image.buffer);
          if (ocrResult.confidence < 0.3 || ocrResult.text.length < 10) {
            ocrResult = null;
          }
        } catch (ocrError) {
          console.warn(`⚠️ Quick OCR failed for image ${image.filename}:`, ocrError);
        }
      }

      // Insert into vault_assets as a child image of the parent document
      const { data: dbAsset, error: dbError } = await supabaseAdmin
        .from('vault_assets')
        .insert({
          id: imageId,
          tenant_id: tenantId,
          case_id: caseId,
          folder_id: folderId,
          filename: image.filename,
          filetype: image.mimeType,
          file_size: image.buffer.length,
          storage_path: storagePath,
          uploaded_by: uploadedBy,
          status: 'uploaded',   // Will become 'processing' → 'ready' via image pipeline
          asset_type: 'image',
          parent_asset_id: parentAssetId,
          source_page: image.pageNumber ?? null,
          image_index: image.imageIndex,
          ocr_text: ocrResult?.text || null,
        })
        .select('id')
        .single();

      if (dbError) {
        console.error(`❌ Failed to insert vault_asset for image:`, dbError);
        continue;
      }

      // Queue through the full Phase B image processing pipeline
      const imageJob: ProcessImageJob = {
        file_id: dbAsset.id,
        tenant_id: tenantId,
        case_id: caseId,
        folder_id: folderId ?? undefined,
        storage_path: storagePath,
        filename: image.filename,
        filetype: image.mimeType,
        user_id: uploadedBy ?? '',
        created_at: new Date().toISOString(),
        asset_type: 'image',
        parent_asset_id: parentAssetId,
        source_page: image.pageNumber,
        image_index: image.imageIndex,
      };

      try {
        await addImageJob(imageJob);
        console.log(`📤 Queued image ${image.filename} for full pipeline processing`);
      } catch (queueErr) {
        console.warn(`⚠️ Failed to queue image job (non-fatal):`, queueErr);
        // Image is stored in vault_assets — pipeline can be triggered manually later
      }

      storedImages.push({
        id: dbAsset.id,
        storagePath,
        filename: image.filename,
        pageNumber: image.pageNumber,
        imageIndex: image.imageIndex,
        width: image.width,
        height: image.height,
        mimeType: image.mimeType,
        fileSize: image.buffer.length,
        ocrText: ocrResult?.text,
        ocrConfidence: ocrResult?.confidence,
        surroundingText: image.surroundingText,
        caption: image.caption,
      });

      console.log(`✅ Stored image: ${image.filename} → vault_assets (parent: ${parentAssetId})${ocrResult ? ` (OCR: ${ocrResult.text.substring(0, 50)}...)` : ''}`);

    } catch (error) {
      console.error(`❌ Error processing image ${image.filename}:`, error);
    }
  }

  // Update document_processing table with image info
  if (storedImages.length > 0) {
    const hasOcrContent = storedImages.some(img => img.ocrText && img.ocrText.length > 0);

    await supabaseAdmin
      .from('document_processing')
      .upsert({
        asset_id: parentAssetId,
        has_images: true,
        image_count: storedImages.length,
        has_ocr_content: hasOcrContent,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'asset_id' });
  }

  console.log(`🖼️ Stored ${storedImages.length}/${images.length} images into vault_assets`);

  return storedImages;
}

/**
 * Get images belonging to a parent document (extracted images)
 * Now queries vault_assets where parent_asset_id = documentFileId
 */
export async function getDocumentImages(documentFileId: string): Promise<StoredImage[]> {
  const { data, error } = await supabaseAdmin
    .from('vault_assets')
    .select('*')
    .eq('parent_asset_id', documentFileId)
    .eq('asset_type', 'image')
    .order('image_index', { ascending: true });

  if (error) {
    console.error('Error fetching document images:', error);
    return [];
  }

  return (data || []).map(img => ({
    id: img.id,
    storagePath: img.storage_path,
    filename: img.filename,
    pageNumber: img.source_page,
    imageIndex: img.image_index ?? 0,
    width: null as any,
    height: null as any,
    mimeType: img.filetype,
    fileSize: img.file_size,
    ocrText: img.ocr_text,
    ocrConfidence: null as any,
  }));
}

/**
 * Get signed URL for an image
 */
export async function getImageUrl(storagePath: string, expiresIn: number = 3600): Promise<string | null> {
  const { data, error } = await supabaseAdmin.storage
    .from('documents')
    .createSignedUrl(storagePath, expiresIn);

  if (error) {
    console.error('Error creating signed URL:', error);
    return null;
  }

  return data.signedUrl;
}

/**
 * Delete images for a document (child vault_assets)
 */
export async function deleteDocumentImages(documentFileId: string): Promise<void> {
  // Get all child images for the parent document
  const { data: images } = await supabaseAdmin
    .from('vault_assets')
    .select('id, storage_path')
    .eq('parent_asset_id', documentFileId)
    .eq('asset_type', 'image');

  if (images && images.length > 0) {
    // Delete from storage
    const paths = images.map(img => img.storage_path);
    await supabaseAdmin.storage.from('documents').remove(paths);

    // Delete from vault_assets
    const ids = images.map(img => img.id);
    await supabaseAdmin
      .from('vault_assets')
      .delete()
      .in('id', ids);
  }
}
