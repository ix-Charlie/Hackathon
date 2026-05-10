/**
 * Document Processing Routes
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { verifyToken, supabaseAdmin } from '../config/supabase.js';
import { addDocumentJob, getJobStatus, getJobByFileId, cancelJob, getQueueStats, addImageJob, getImageJobByFileId, addExtractionJob } from '../services/queueService.js';
import { processDocument } from '../services/documentService.js';
import { isSupported, getSupportedExtensions, getSupportedMimeTypes } from '../services/extractors/index.js';
import { ProcessDocumentJob, ProcessImageJob } from '../types/index.js';
import { config } from '../config/index.js';
import { getDocumentImages, getImageUrl } from '../services/imageService.js';
import { detectAssetType, isImageMimeType } from '../services/assetTypeDetector.js';
import { confirmCaseLink, rejectCaseLink } from '../services/vault/caseLinker.js';

const router = Router();

// Request validation schema
const processDocumentSchema = z.object({
  file_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  case_id: z.string().uuid(),
  folder_id: z.string().uuid().optional(),
  storage_path: z.string().min(1),
  filename: z.string().min(1),
  filetype: z.string().min(1),
});

/**
 * Middleware to verify authentication
 */
async function requireAuth(req: Request, res: Response, next: () => void) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.replace('Bearer ', '');
  const user = await verifyToken(token);

  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Attach user to request
  (req as any).user = user;
  next();
}

/**
 * POST /api/documents/process
 * Queue a document for processing
 */
router.post('/process', requireAuth, async (req: Request, res: Response) => {
  try {
    // Validate request body
    const parsed = processDocumentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid request body',
        details: parsed.error.errors,
      });
    }

    const data = parsed.data;
    const user = (req as any).user;

    // ── Image routing: skip document pipeline entirely ──────────────
    if (isImageMimeType(data.filetype)) {
      // Check for duplicate image job
      const existingImgJob = await getImageJobByFileId(data.file_id);
      if (existingImgJob) {
        const state = await existingImgJob.getState();
        if (state === 'active' || state === 'waiting') {
          return res.status(409).json({
            error: 'Image is already being processed',
            job_id: existingImgJob.id,
            status: state,
          });
        }
      }

      const imageJobData: ProcessImageJob = {
        ...data,
        user_id: user.id,
        created_at: new Date().toISOString(),
        asset_type: 'image',
      };

      const job = await addImageJob(imageJobData);

      return res.status(202).json({
        message: 'Image queued for processing',
        job_id: job.id,
        file_id: data.file_id,
        filename: data.filename,
        pipeline: 'image',
      });
    }

    // ── Document pipeline (existing) ────────────────────────────────
    // Check if file type is supported
    if (!isSupported(data.filename, data.filetype)) {
      return res.status(400).json({
        error: `Unsupported file type: ${data.filetype}`,
        supported_extensions: getSupportedExtensions(),
        supported_mime_types: getSupportedMimeTypes(),
      });
    }

    // Create job data
    const jobData: ProcessDocumentJob = {
      ...data,
      user_id: user.id,
      created_at: new Date().toISOString(),
    };

    // Check if job already exists
    const existingJob = await getJobByFileId(data.file_id);
    if (existingJob) {
      const state = await existingJob.getState();
      if (state === 'active' || state === 'waiting') {
        return res.status(409).json({
          error: 'Document is already being processed',
          job_id: existingJob.id,
          status: state,
        });
      }
    }

    // Add to queue
    const job = await addDocumentJob(jobData);

    res.status(202).json({
      message: 'Document queued for processing',
      job_id: job.id,
      file_id: data.file_id,
      filename: data.filename,
    });

  } catch (error) {
    console.error('Error queuing document:', error);
    res.status(500).json({
      error: 'Failed to queue document for processing',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/documents/process-sync
 * Process a document synchronously (for small files)
 * Useful for testing or when immediate result is needed
 */
router.post('/process-sync', requireAuth, async (req: Request, res: Response) => {
  try {
    const parsed = processDocumentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid request body',
        details: parsed.error.errors,
      });
    }

    const data = parsed.data;
    const user = (req as any).user;

    if (!isSupported(data.filename, data.filetype)) {
      return res.status(400).json({
        error: `Unsupported file type: ${data.filetype}`,
      });
    }

    const jobData: ProcessDocumentJob = {
      ...data,
      user_id: user.id,
      created_at: new Date().toISOString(),
    };

    // Process synchronously
    const result = await processDocument(jobData);

    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }

  } catch (error) {
    console.error('Error processing document:', error);
    res.status(500).json({
      error: 'Failed to process document',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/documents/job/:jobId
 * Get job status
 */
router.get('/job/:jobId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const status = await getJobStatus(jobId);

    if (!status) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json(status);

  } catch (error) {
    console.error('Error getting job status:', error);
    res.status(500).json({
      error: 'Failed to get job status',
    });
  }
});

/**
 * GET /api/documents/file/:fileId/status
 * Get processing status for a file
 */
router.get('/file/:fileId/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const { fileId } = req.params;
    const job = await getJobByFileId(fileId);

    if (!job) {
      return res.status(404).json({ error: 'No processing job found for this file' });
    }

    const status = await getJobStatus(job.id || '');
    res.json(status);

  } catch (error) {
    console.error('Error getting file status:', error);
    res.status(500).json({
      error: 'Failed to get file status',
    });
  }
});

/**
 * DELETE /api/documents/job/:jobId
 * Cancel a pending job
 */
router.delete('/job/:jobId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const cancelled = await cancelJob(jobId);

    if (cancelled) {
      res.json({ message: 'Job cancelled successfully' });
    } else {
      res.status(400).json({ error: 'Cannot cancel job - it may already be processing or completed' });
    }

  } catch (error) {
    console.error('Error cancelling job:', error);
    res.status(500).json({
      error: 'Failed to cancel job',
    });
  }
});

/**
 * GET /api/documents/queue/stats
 * Get queue statistics (admin only)
 */
router.get('/queue/stats', requireAuth, async (_req: Request, res: Response) => {
  try {
    const stats = await getQueueStats();
    res.json(stats);
  } catch (error) {
    console.error('Error getting queue stats:', error);
    res.status(500).json({
      error: 'Failed to get queue statistics',
    });
  }
});

/**
 * GET /api/documents/supported
 * Get list of supported file types
 */
router.get('/supported', (_req: Request, res: Response) => {
  res.json({
    extensions: getSupportedExtensions(),
    mime_types: getSupportedMimeTypes(),
    max_file_size_mb: config.processing.maxFileSizeMB,
  });
});

/**
 * GET /api/documents/:fileId/images
 * Get images extracted from a document
 */
router.get('/:fileId/images', requireAuth, async (req: Request, res: Response) => {
  try {
    const { fileId } = req.params;
    
    if (!fileId) {
      return res.status(400).json({ error: 'File ID is required' });
    }
    
    const images = await getDocumentImages(fileId);
    
    // Generate signed URLs for each image
    const imagesWithUrls = await Promise.all(
      images.map(async (img) => ({
        ...img,
        url: await getImageUrl(img.storagePath),
      }))
    );
    
    res.json({
      file_id: fileId,
      image_count: images.length,
      images: imagesWithUrls,
    });
  } catch (error) {
    console.error('Error fetching document images:', error);
    res.status(500).json({
      error: 'Failed to fetch document images',
    });
  }
});

/**
 * GET /api/documents/:fileId/images/:imageId
 * Get a specific image URL
 */
router.get('/:fileId/images/:imageId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { fileId, imageId } = req.params;
    
    const images = await getDocumentImages(fileId);
    const image = images.find(img => img.id === imageId);
    
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    const url = await getImageUrl(image.storagePath);
    
    res.json({
      ...image,
      url,
    });
  } catch (error) {
    console.error('Error fetching image:', error);
    res.status(500).json({
      error: 'Failed to fetch image',
    });
  }
});

/**
 * POST /api/documents/move
 * Move files and/or folders to a different matter
 * Handles nested folders recursively
 */
router.post('/move', requireAuth, async (req: Request, res: Response) => {
  try {
    const { file_ids = [], folder_ids = [], target_case_id, target_folder_id = null } = req.body;
    const userId = (req as any).user.id;

    // Validation
    if (!target_case_id || (file_ids.length === 0 && folder_ids.length === 0)) {
      return res.status(400).json({ 
        error: 'Must specify target_case_id and at least one file_id or folder_id' 
      });
    }

    // Get user's tenant_id
    const { data: tenantData, error: tenantError } = await supabaseAdmin
      .from('tenant_members')
      .select('tenant_id')
      .eq('user_id', userId)
      .single();

    if (tenantError || !tenantData) {
      return res.status(403).json({ error: 'No tenant found' });
    }

    const tenantId = tenantData.tenant_id;

    // Verify user has access to target matter
    const { data: targetCase, error: targetError } = await supabaseAdmin
      .from('cases')
      .select('id')
      .eq('id', target_case_id)
      .eq('tenant_id', tenantId)
      .single();

    if (targetError || !targetCase) {
      return res.status(403).json({ error: 'Target matter not found or access denied' });
    }

    // Recursive function to get all nested folder IDs
    async function getAllNestedFolderIds(folderIds: string[]): Promise<string[]> {
      if (folderIds.length === 0) return [];
      
      const { data: childFolders, error } = await supabaseAdmin
        .from('folders')
        .select('id')
        .in('parent_folder_id', folderIds)
        .eq('tenant_id', tenantId);

      if (error || !childFolders) return folderIds;

      const childIds = childFolders.map(f => f.id);
      if (childIds.length === 0) return folderIds;

      const deeperIds = await getAllNestedFolderIds(childIds);
      return [...folderIds, ...childIds, ...deeperIds];
    }

    // Get all folder IDs including nested ones
    const allFolderIds = folder_ids.length > 0 
      ? await getAllNestedFolderIds(folder_ids)
      : [];

    // Get all file IDs (direct selections + files in selected folders)
    let allFileIds = [...file_ids];
    if (allFolderIds.length > 0) {
      const { data: folderFiles, error: filesError } = await supabaseAdmin
        .from('vault_assets')
        .select('id')
        .in('folder_id', allFolderIds)
        .eq('tenant_id', tenantId);

      if (!filesError && folderFiles) {
        allFileIds.push(...folderFiles.map(f => f.id));
      }
    }

    // Also get files directly selected that might not be in folders
    const uniqueFileIds = [...new Set(allFileIds)];
    const uniqueFolderIds = [...new Set(allFolderIds)];

    // Move all folders
    if (uniqueFolderIds.length > 0) {
      // Top-level selected folders get reparented to target_folder_id (or root)
      const { error: moveFoldersError } = await supabaseAdmin
        .from('folders')
        .update({ case_id: target_case_id, parent_folder_id: target_folder_id })
        .in('id', folder_ids)
        .eq('tenant_id', tenantId);

      // Nested child folders just get their case_id updated (keep parent relationship)
      const nestedOnlyIds = uniqueFolderIds.filter(id => !folder_ids.includes(id));
      if (nestedOnlyIds.length > 0) {
        await supabaseAdmin
          .from('folders')
          .update({ case_id: target_case_id })
          .in('id', nestedOnlyIds)
          .eq('tenant_id', tenantId);
      }

      if (moveFoldersError) {
        console.error('Error moving folders:', moveFoldersError);
        throw moveFoldersError;
      }
    }

    // Move all files — direct selections go to target_folder_id, nested files keep their folder
    if (uniqueFileIds.length > 0) {
      // Get file details for extraction jobs later
      const { data: filesToMove, error: filesDataError } = await supabaseAdmin
        .from('vault_assets')
        .select('id, filename, case_id')
        .in('id', uniqueFileIds)
        .eq('tenant_id', tenantId);

      if (filesDataError) {
        throw filesDataError;
      }

      // Files that are directly selected (not inside a moved folder) get reparented
      const directFileIds = file_ids.filter((id: string) => uniqueFileIds.includes(id));
      if (directFileIds.length > 0) {
        await supabaseAdmin
          .from('vault_assets')
          .update({ case_id: target_case_id, folder_id: target_folder_id })
          .in('id', directFileIds)
          .eq('tenant_id', tenantId);
      }
      // Files inside moved folders just get case_id updated (keep folder relationship)
      const folderFileIds = uniqueFileIds.filter((id: string) => !directFileIds.includes(id));
      if (folderFileIds.length > 0) {
        await supabaseAdmin
          .from('vault_assets')
          .update({ case_id: target_case_id })
          .in('id', folderFileIds)
          .eq('tenant_id', tenantId);
      }

      // ── INTELLIGENCE EXTRACTION FOR NEW MATTER ──
      // When files move to a new matter:
      // 1. OLD matter keeps its intelligence data (we'll handle cleanup separately later)
      // 2. Each moved file gets extracted in the context of the NEW matter
      // 3. New intelligence is ADDED to the target matter's existing data
      
      // Queue extraction jobs for files moved to the new matter
      // Only extract for non-General matters
      const { data: targetCaseData } = await supabaseAdmin
        .from('cases')
        .select('name')
        .eq('id', target_case_id)
        .single();

      const shouldExtract = targetCaseData?.name !== 'General Documents';

      if (shouldExtract && filesToMove) {
        console.log(`🧠 Queueing intelligence extraction for ${filesToMove.length} file(s) in new matter context...`);
        let queuedCount = 0;

        for (const file of filesToMove) {
          // Only queue if file has chunks (was previously processed)
          const { count: chunkCount } = await supabaseAdmin
            .from('document_chunks')
            .select('*', { count: 'exact', head: true })
            .eq('file_id', file.id);

          if (chunkCount && chunkCount > 0) {
            try {
              // Extract in the context of the NEW matter (target_case_id)
              // This will add intelligence to the target matter without affecting the old matter
              await addExtractionJob({
                file_id: file.id,
                tenant_id: tenantId,
                case_id: target_case_id,
                filename: file.filename,
              });
              queuedCount++;
            } catch (extractionError) {
              console.warn(`⚠️ Failed to queue extraction for ${file.filename}:`, extractionError);
            }
          }
        }

        console.log(`✅ Queued ${queuedCount} extraction job(s) - intelligence will be added to target matter`);
      }
    }

    res.json({
      success: true,
      moved: {
        folders: uniqueFolderIds.length,
        files: uniqueFileIds.length,
      },
    });
  } catch (error) {
    console.error('Error moving items:', error);
    res.status(500).json({ error: 'Failed to move items' });
  }
});

// ── Image Case Link Endpoints ────────────────────────────────────────

/**
 * POST /api/documents/:fileId/confirm-link
 * Confirm a suggested case link for an image asset
 */
router.post('/:fileId/confirm-link', requireAuth, async (req: Request, res: Response) => {
  try {
    const { fileId } = req.params;
    const { case_id } = req.body;

    if (!case_id) {
      return res.status(400).json({ error: 'case_id is required' });
    }

    await confirmCaseLink(fileId, case_id);
    res.json({ success: true, message: 'Case link confirmed' });
  } catch (error) {
    console.error('Error confirming link:', error);
    res.status(500).json({ error: 'Failed to confirm case link' });
  }
});

/**
 * POST /api/documents/:fileId/reject-link
 * Reject a suggested case link for an image asset
 */
router.post('/:fileId/reject-link', requireAuth, async (req: Request, res: Response) => {
  try {
    const { fileId } = req.params;
    const { case_id } = req.body;

    if (!case_id) {
      return res.status(400).json({ error: 'case_id is required' });
    }

    await rejectCaseLink(fileId, case_id);
    res.json({ success: true, message: 'Case link rejected' });
  } catch (error) {
    console.error('Error rejecting link:', error);
    res.status(500).json({ error: 'Failed to reject case link' });
  }
});

export default router;
