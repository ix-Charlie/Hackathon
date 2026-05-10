import { supabase } from './supabaseClient';
import { SUPABASE_URL, BACKEND_API_URL } from './config';
import { UploadedFile, DocumentImage, VaultAssetType } from '../types';
import { getUserTenantId, clearTenantCache } from './tenantUtils';

export { getUserTenantId, clearTenantCache };

/**
 * Clean up all matter intelligence data for given file IDs.
 * Called when files are deleted to prevent orphaned intelligence records.
 */
async function cleanupIntelligence(fileIds: string[]): Promise<void> {
  if (!fileIds || fileIds.length === 0) return;

  const tables = [
    'matter_entities',
    'matter_clauses',
    'matter_obligations',
    'matter_dates',
    'matter_risks',
    'matter_cross_references',
  ];

  for (const table of tables) {
    const { error } = await supabase.from(table).delete().in('file_id', fileIds);
    if (error) console.warn(`⚠️ Failed to clean ${table}:`, error.message);
  }

  // Clean extraction jobs
  const { error: ejError } = await supabase.from('extraction_jobs').delete().in('file_id', fileIds);
  if (ejError) console.warn('⚠️ Failed to clean extraction_jobs:', ejError.message);

  // Clean document_processing metadata
  const { error: dpError } = await supabase.from('document_processing').delete().in('asset_id', fileIds);
  if (dpError) console.warn('⚠️ Failed to clean document_processing:', dpError.message);

  // Clean child images (extracted from documents, now in vault_assets)
  const { error: childImgError } = await supabase.from('vault_assets').delete().in('parent_asset_id', fileIds);
  if (childImgError) console.warn('⚠️ Failed to clean child images:', childImgError.message);

  console.log(`🧹 Cleaned intelligence for ${fileIds.length} file(s)`);
}

/**
 * Clean up all matter intelligence data for a case.
 * Called when an entire case/matter is deleted.
 */
async function cleanupCaseIntelligence(caseId: string): Promise<void> {
  const tenantId = await getUserTenantId();
  if (!tenantId) return;

  const tables = [
    'matter_entities',
    'matter_clauses',
    'matter_obligations',
    'matter_dates',
    'matter_risks',
    'matter_cross_references',
  ];

  for (const table of tables) {
    const { error } = await supabase.from(table).delete().eq('case_id', caseId).eq('tenant_id', tenantId);
    if (error) console.warn(`⚠️ Failed to clean ${table} for case:`, error.message);
  }

  // Clean canonical entities for the case
  const { error: ceError } = await supabase.from('canonical_entities').delete().eq('case_id', caseId);
  if (ceError) console.warn('⚠️ Failed to clean canonical_entities:', ceError.message);

  // Clean matter summaries
  const { error: msError } = await supabase.from('matter_summaries').delete().eq('case_id', caseId);
  if (msError) console.warn('⚠️ Failed to clean matter_summaries:', msError.message);

  console.log(`🧹 Cleaned all intelligence for case ${caseId}`);
}

export { cleanupCaseIntelligence };

/**
 * Database representation of a vault asset (formerly document_files)
 */
export interface VaultAsset {
  id: string;
  tenant_id: string;
  case_id?: string;
  folder_id?: string;
  filename: string;
  filetype: string;
  file_size: number;
  storage_path: string;
  uploaded_by?: string;
  created_at: string;
  status: 'uploaded' | 'processing' | 'ready' | 'failed';
  processing_stage?: string | null;
  asset_type: VaultAssetType;
  // Image-specific fields (only populated for asset_type === 'image')
  ocr_text?: string;
  vision_summary?: string;
  classification?: string;
  confidence_score?: number;
  thumbnail_url?: string;
  normalized_url?: string;
  entities?: string[];
  linked_case_id?: string;
  match_score?: number;
  link_status?: 'auto' | 'suggested' | 'none';
}

/** @deprecated Use VaultAsset instead */
export type DocumentFile = VaultAsset;

/**
 * Fetch all files for the current user's tenant
 */
export async function fetchFiles(): Promise<VaultAsset[]> {
  const tenantId = await getUserTenantId();
  
  if (!tenantId) {
    console.error('No tenant found for user');
    return [];
  }

  const { data, error } = await supabase
    .from('vault_assets')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching files:', error);
    return [];
  }

  return data || [];
}

/**
 * Fetch files for a specific case
 */
export async function fetchFilesByCase(caseId: string): Promise<VaultAsset[]> {
  const tenantId = await getUserTenantId();
  
  if (!tenantId) {
    console.error('No tenant found for user');
    return [];
  }

  const { data, error } = await supabase
    .from('vault_assets')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('case_id', caseId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching files:', error);
    return [];
  }

  return data || [];
}

/**
 * Fetch files for a specific folder
 */
export async function fetchFilesByFolder(folderId: string): Promise<VaultAsset[]> {
  const tenantId = await getUserTenantId();
  
  if (!tenantId) {
    console.error('No tenant found for user');
    return [];
  }

  const { data, error } = await supabase
    .from('vault_assets')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('folder_id', folderId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching files:', error);
    return [];
  }

  return data || [];
}

/**
 * Upload a file to Supabase Storage and save metadata to database
 */
export async function uploadFile(
  file: File,
  caseId: string,
  folderId?: string
): Promise<VaultAsset | null> {
  const tenantId = await getUserTenantId();
  
  if (!tenantId) {
    console.error('No tenant found for user');
    return null;
  }

  const { data: { user } } = await supabase.auth.getUser();

  // Generate unique storage path
  const timestamp = Date.now();
  const sanitizedName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
  const storagePath = `${tenantId}/${caseId}/${folderId || 'root'}/${timestamp}_${sanitizedName}`;

  console.log('Uploading file:', {
    filename: file.name,
    size: file.size,
    type: file.type,
    storagePath,
  });

  // Upload to Supabase Storage
  const { data: storageData, error: storageError } = await supabase.storage
    .from('documents')
    .upload(storagePath, file, {
      cacheControl: '3600',
      upsert: false,
    });

  if (storageError) {
    console.error('Error uploading file to storage:', storageError);
    return null;
  }

  console.log('File uploaded to storage:', storageData);

  // Determine correct MIME type (browsers may report empty or generic for .msg etc.)
  let fileType = file.type;
  if (!fileType || fileType === 'application/octet-stream') {
    const ext = file.name.toLowerCase().split('.').pop();
    const extMimeMap: Record<string, string> = {
      msg: 'application/vnd.ms-outlook',
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      csv: 'text/csv',
      txt: 'text/plain',
    };
    fileType = (ext && extMimeMap[ext]) || fileType || 'application/octet-stream';
  }

  // Detect asset type from MIME
  const detectedAssetType: VaultAssetType = fileType.startsWith('image/') ? 'image'
    : (fileType.includes('spreadsheet') || fileType.includes('excel') || fileType === 'text/csv') ? 'spreadsheet'
    : 'document';

  // Save metadata to database
  const insertData: Record<string, any> = {
    tenant_id: tenantId,
    case_id: caseId,
    folder_id: folderId || null,
    filename: file.name,
    filetype: fileType,
    storage_path: storagePath,
    uploaded_by: user?.id,
    file_size: file.size,
    status: 'uploaded',
    asset_type: detectedAssetType,
  };
  
  const { data, error } = await supabase
    .from('vault_assets')
    .insert(insertData)
    .select()
    .single();

  if (error) {
    console.error('Error saving file metadata:', error.message, error.details, error.hint, error.code);
    
    // Clean up storage if database insert fails
    await supabase.storage.from('documents').remove([storagePath]);
    return null;
  }

  console.log('File metadata saved:', data);
  
  // Trigger document processing (async - don't wait for completion)
  triggerDocumentProcessing({
    file_id: data.id,
    tenant_id: tenantId,
    case_id: caseId,
    folder_id: folderId,
    storage_path: storagePath,
    filename: file.name,
    filetype: fileType,
  });

  return data;
}

/**
 * Trigger the document processing via Node.js backend
 * This runs asynchronously - the file will be processed in the background via job queue
 */
async function triggerDocumentProcessing(params: {
  file_id: string;
  tenant_id: string;
  case_id: string;
  folder_id?: string;
  storage_path: string;
  filename: string;
  filetype: string;
}): Promise<void> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session?.access_token) {
      console.error('No session for document processing');
      return;
    }

    console.log('🚀 Triggering document processing for:', params.filename);

    // Use Node.js backend instead of Supabase Edge Function
    const response = await fetch(`${BACKEND_API_URL}/api/documents/process`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('❌ Document processing failed:', errorData);
      
      // Update status to failed
      await supabase
        .from('vault_assets')
        .update({ status: 'failed' })
        .eq('id', params.file_id);
    } else {
      const result = await response.json();
      console.log('✅ Document queued for processing:', result);
    }
  } catch (err) {
    console.error('❌ Error triggering document processing:', err);
    
    // Update status to failed
    await supabase
      .from('vault_assets')
      .update({ status: 'failed' })
      .eq('id', params.file_id);
  }
}

/**
 * Upload multiple files
 */
export async function uploadFiles(
  files: File[],
  caseId: string,
  folderId?: string
): Promise<VaultAsset[]> {
  const results: VaultAsset[] = [];
  
  for (const file of files) {
    const result = await uploadFile(file, caseId, folderId);
    if (result) {
      results.push(result);
    }
  }
  
  return results;
}

/**
 * Download a file from storage
 */
export async function downloadFile(storagePath: string): Promise<Blob | null> {
  const { data, error } = await supabase.storage
    .from('documents')
    .download(storagePath);

  if (error) {
    console.error('Error downloading file:', error);
    return null;
  }

  return data;
}

/**
 * Get a signed URL for a file (for viewing in browser)
 */
export async function getFileUrl(storagePath: string, expiresIn: number = 3600): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from('documents')
    .createSignedUrl(storagePath, expiresIn);

  if (error) {
    console.error('Error getting signed URL:', error);
    return null;
  }

  return data?.signedUrl || null;
}

/**
 * Delete a file from storage and database
 */
export async function deleteFile(fileId: string): Promise<boolean> {
  const tenantId = await getUserTenantId();
  
  if (!tenantId) {
    console.error('No tenant found for user');
    return false;
  }

  // First, get the file to get its storage path
  const { data: file, error: fetchError } = await supabase
    .from('vault_assets')
    .select('storage_path')
    .eq('id', fileId)
    .eq('tenant_id', tenantId)
    .single();

  if (fetchError || !file) {
    console.error('Error fetching file for deletion:', fetchError);
    return false;
  }

  // Delete from storage
  const { error: storageError } = await supabase.storage
    .from('documents')
    .remove([file.storage_path]);

  if (storageError) {
    console.error('Error deleting file from storage:', storageError);
    // Continue to delete from database anyway
  }

  // Delete from database
  const { data: deletedRows, error: dbError } = await supabase
    .from('vault_assets')
    .delete()
    .select('id')
    .eq('id', fileId)
    .eq('tenant_id', tenantId);

  if (dbError) {
    console.error('Error deleting file from database:', dbError);
    return false;
  }

  if (!deletedRows || deletedRows.length === 0) {
    console.warn('[fileService.deleteFile] No file rows deleted:', { fileId, tenantId });
    return false;
  }

  // Also delete associated document_chunks
  const { error: chunksError } = await supabase
    .from('document_chunks')
    .delete()
    .eq('file_id', fileId)
    .eq('tenant_id', tenantId);

  if (chunksError) {
    console.error('Error deleting document chunks:', chunksError);
    // Not critical, continue
  }

  // Clean up matter intelligence (entities, clauses, obligations, dates, risks)
  await cleanupIntelligence([fileId]);

  return true;
}

/**
 * Delete all files for a case
 */
export async function deleteFilesByCase(caseId: string): Promise<boolean> {
  const tenantId = await getUserTenantId();
  
  if (!tenantId) {
    console.error('No tenant found for user');
    return false;
  }

  // Get all files for this case
  const { data: files, error: fetchError } = await supabase
    .from('vault_assets')
    .select('id, storage_path')
    .eq('case_id', caseId)
    .eq('tenant_id', tenantId);

  if (fetchError) {
    console.error('Error fetching files for case:', fetchError);
    return false;
  }

  // Delete from storage
  if (files && files.length > 0) {
    const storagePaths = files.map(f => f.storage_path);
    const { error: storageError } = await supabase.storage
      .from('documents')
      .remove(storagePaths);

    if (storageError) {
      console.error('Error deleting files from storage:', storageError);
    }

    // Delete associated chunks
    const fileIds = files.map(f => f.id);
    const { error: chunksError } = await supabase
      .from('document_chunks')
      .delete()
      .in('file_id', fileIds);

    if (chunksError) {
      console.error('Error deleting document chunks:', chunksError);
    }

    // Clean up matter intelligence for all files
    await cleanupIntelligence(fileIds);
  }

  // Delete from database
  const { error } = await supabase
    .from('vault_assets')
    .delete()
    .eq('case_id', caseId)
    .eq('tenant_id', tenantId);

  if (error) {
    console.error('Error deleting files from database:', error);
    return false;
  }

  return true;
}

/**
 * Delete all files for a folder
 */
export async function deleteFilesByFolder(folderId: string): Promise<boolean> {
  const tenantId = await getUserTenantId();
  
  if (!tenantId) {
    console.error('No tenant found for user');
    return false;
  }

  // Get all files for this folder
  const { data: files, error: fetchError } = await supabase
    .from('vault_assets')
    .select('id, storage_path')
    .eq('folder_id', folderId)
    .eq('tenant_id', tenantId);

  if (fetchError) {
    console.error('Error fetching files for folder:', fetchError);
    return false;
  }

  // Delete from storage
  if (files && files.length > 0) {
    const storagePaths = files.map(f => f.storage_path);
    const { error: storageError } = await supabase.storage
      .from('documents')
      .remove(storagePaths);

    if (storageError) {
      console.error('Error deleting files from storage:', storageError);
    }

    // Delete associated chunks
    const fileIds = files.map(f => f.id);
    const { error: chunksError } = await supabase
      .from('document_chunks')
      .delete()
      .in('file_id', fileIds);

    if (chunksError) {
      console.error('Error deleting document chunks:', chunksError);
    }

    // Clean up matter intelligence for all files
    await cleanupIntelligence(fileIds);
  }

  // Delete from database
  const { error } = await supabase
    .from('vault_assets')
    .delete()
    .eq('folder_id', folderId)
    .eq('tenant_id', tenantId);

  if (error) {
    console.error('Error deleting files from database:', error);
    return false;
  }

  return true;
}

/**
 * Update file status
 */
export async function updateFileStatus(
  fileId: string,
  status: 'uploaded' | 'processing' | 'ready' | 'failed'
): Promise<boolean> {
  const tenantId = await getUserTenantId();
  
  if (!tenantId) {
    console.error('No tenant found for user');
    return false;
  }

  const { error } = await supabase
    .from('vault_assets')
    .update({ status })
    .eq('id', fileId)
    .eq('tenant_id', tenantId);

  if (error) {
    console.error('Error updating file status:', error);
    return false;
  }

  return true;
}

/**
 * Convert VaultAsset to UploadedFile format for frontend compatibility
 */
export function vaultAssetToUploadedFile(asset: VaultAsset): UploadedFile {
  return {
    id: asset.id,
    name: asset.filename,
    mimeType: asset.filetype,
    data: '', // Data is in storage, not returned here
    size: asset.file_size,
    case_id: asset.case_id,
    folder_id: asset.folder_id,
    tenant_id: asset.tenant_id,
    uploaded_by: asset.uploaded_by,
    created_at: asset.created_at,
    status: asset.status,
    processing_stage: asset.processing_stage,
    asset_type: asset.asset_type,
    // Image-specific fields
    ocr_text: asset.ocr_text,
    vision_summary: asset.vision_summary,
    classification: asset.classification as UploadedFile['classification'],
    confidence_score: asset.confidence_score,
    thumbnail_url: asset.thumbnail_url,
    normalized_url: asset.normalized_url,
    entities: asset.entities,
    linked_case_id: asset.linked_case_id,
    match_score: asset.match_score,
    link_status: asset.link_status,
  };
}

/** @deprecated Use vaultAssetToUploadedFile instead */
export const documentFileToUploadedFile = vaultAssetToUploadedFile;

/**
 * Convert multiple VaultAssets to UploadedFiles
 */
export function vaultAssetsToUploadedFiles(assets: VaultAsset[]): UploadedFile[] {
  return assets.map(vaultAssetToUploadedFile);
}

/** @deprecated Use vaultAssetsToUploadedFiles instead */
export const documentFilesToUploadedFiles = vaultAssetsToUploadedFiles;

// ============================================================================
// JOB STATUS HELPERS (for tracking document processing)
// ============================================================================

export interface JobStatus {
  job_id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  progress?: number;
  result?: {
    success: boolean;
    file_id: string;
    filename: string;
    text_length: number;
    chunks_created: number;
    embeddings_generated: number;
    processing_time_ms: number;
    error?: string;
  };
  error?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
}

/**
 * Get the processing status of a document job
 */
export async function getDocumentJobStatus(fileId: string): Promise<JobStatus | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session?.access_token) {
      console.error('No session for getting job status');
      return null;
    }

    const response = await fetch(`${BACKEND_API_URL}/api/documents/file/${fileId}/status`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null; // No job found
      }
      console.error('Failed to get job status:', await response.text());
      return null;
    }

    return await response.json();
  } catch (err) {
    console.error('Error getting job status:', err);
    return null;
  }
}

/**
 * Poll for document processing completion
 * @param fileId - The file ID to monitor
 * @param onProgress - Callback for progress updates
 * @param intervalMs - Polling interval in milliseconds
 * @param timeoutMs - Maximum time to wait
 */
export async function pollDocumentProcessing(
  fileId: string,
  onProgress?: (status: JobStatus) => void,
  intervalMs: number = 2000,
  timeoutMs: number = 300000 // 5 minutes
): Promise<JobStatus | null> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    const checkStatus = async () => {
      if (Date.now() - startTime > timeoutMs) {
        console.warn('Document processing polling timed out');
        resolve(null);
        return;
      }

      const status = await getDocumentJobStatus(fileId);

      if (status) {
        onProgress?.(status);

        if (status.status === 'completed' || status.status === 'failed') {
          resolve(status);
          return;
        }
      }

      // Continue polling
      setTimeout(checkStatus, intervalMs);
    };

    checkStatus();
  });
}

/**
 * Fetch images for a document
 */
export async function fetchDocumentImages(fileId: string): Promise<DocumentImage[]> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session?.access_token) {
      console.error('No session for fetching images');
      return [];
    }

    const response = await fetch(`${BACKEND_API_URL}/api/documents/${fileId}/images`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
      },
    });

    if (!response.ok) {
      console.error('Failed to fetch document images');
      return [];
    }

    const data = await response.json();
    return data.images || [];
  } catch (error) {
    console.error('Error fetching document images:', error);
    return [];
  }
}

/**
 * Check if a document has images
 */
export async function documentHasImages(fileId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('document_processing')
    .select('has_images, image_count')
    .eq('asset_id', fileId)
    .single();
  
  if (error || !data) return false;
  return data.has_images && data.image_count > 0;
}

/**
 * Move files and/or folders to a different matter
 */
export async function moveItems(params: {
  file_ids?: string[];
  folder_ids?: string[];
  target_case_id: string;
  target_folder_id?: string;
}): Promise<{ success: boolean; moved: { folders: number; files: number } }> {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session?.access_token) {
    throw new Error('Not authenticated');
  }

  const response = await fetch(`${BACKEND_API_URL}/api/documents/move`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to move items' }));
    throw new Error(error.error || 'Failed to move items');
  }

  return response.json();
}

