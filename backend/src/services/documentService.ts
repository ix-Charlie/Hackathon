/**
 * Document Processing Service
 * Orchestrates the full document processing pipeline
 */

import { supabaseAdmin } from '../config/supabase.js';
import { extractDocument } from './extractors/index.js';
import { chunkTextWithMetadata, extractDocumentMetadata } from './chunkService.js';
import { generateEmbeddings } from './embeddingService.js';
import { ProcessDocumentJob, ProcessingResult, DocumentChunk } from '../types/index.js';
import { config } from '../config/index.js';
import { processAndStoreImages, ExtractedImage } from './imageService.js';
import { extractPdfImages, isPdfScanned } from './extractors/pdfImages.js';
import { extractDocxImages } from './extractors/docxImages.js';
import { extractXlsxImages } from './extractors/xlsxImages.js';
import { performOcr } from './ocrService.js';
import { addExtractionJob } from './queueService.js';
import { processCsvIntelligence, storeCsvDataset } from './csvIntelligenceService.js';
import { extractPdfLayout } from './extractors/pdfLayout.js';
import { chunkByLayout } from './layoutChunkService.js';
import { extractDocxLayout } from './extractors/docxLayout.js';

/**
 * Process a document: extract text, chunk, generate embeddings, store in DB
 * Now also extracts images and performs OCR on scanned documents
 */
export async function processDocument(
  job: ProcessDocumentJob,
  onProgress?: (progress: number, message: string) => void
): Promise<ProcessingResult> {
  const startTime = Date.now();
  const { file_id, tenant_id, case_id, folder_id, storage_path, filename, filetype } = job;

  console.log(`\n📄 Processing document: ${filename} (${file_id})`);

  try {
    // 1. Update status to processing
    onProgress?.(5, 'Starting processing...');
    await updateFileStatus(file_id, 'processing', 'downloading');

    // 2. Download file from Supabase Storage
    onProgress?.(10, 'Downloading file...');
    const fileBuffer = await downloadFile(storage_path);
    console.log(`📥 Downloaded ${fileBuffer.length} bytes`);

    // 3. Extract text
    onProgress?.(20, 'Extracting text...');
    await updateProcessingStage(file_id, 'extracting_text');
    const { text, metadata } = await extractDocument(
      fileBuffer,
      filename,
      filetype,
      (progress) => onProgress?.(20 + progress * 0.2, 'Extracting text...')
    );

    console.log(`📄 Extracted ${text.length} characters`);

    // 4. Extract images from PDFs and DOCX files
    onProgress?.(40, 'Extracting images...');
    await updateProcessingStage(file_id, 'extracting_images');
    let extractedImages: ExtractedImage[] = [];
    let needsOcr = false;
    
    if (filetype === 'application/pdf') {
      const pdfImageResult = await extractPdfImages(fileBuffer);
      // Merge metadata into images (surrounding text, captions)
      extractedImages = pdfImageResult.images.map((img, i) => {
        const meta = pdfImageResult.metadata[i];
        return {
          ...img,
          surroundingText: meta?.surroundingText,
          caption: meta?.caption,
        };
      });
      needsOcr = pdfImageResult.needsOcr;
    } else if (filetype.includes('word') || filetype.includes('document') || filename.endsWith('.docx')) {
      const docxImageResult = await extractDocxImages(fileBuffer);
      extractedImages = docxImageResult.images;
    } else if (isCsvExcelFile(filename, filetype) && (filename.endsWith('.xlsx') || filename.endsWith('.xls'))) {
      // Extract embedded images from Excel files (pasted screenshots, charts, etc.)
      try {
        const xlsxImageResult = await extractXlsxImages(fileBuffer);
        extractedImages = xlsxImageResult.images;
        if (extractedImages.length > 0) {
          console.log(`📸 Found ${extractedImages.length} embedded images in Excel file`);
        }
      } catch (xlsxImgErr) {
        console.warn('⚠️ XLSX image extraction failed (non-fatal):', xlsxImgErr);
      }
    }
    
    // 5. Store extracted images and perform OCR
    let ocrText = '';
    if (extractedImages.length > 0) {
      onProgress?.(45, `Processing ${extractedImages.length} images...`);
      
      const storedImages = await processAndStoreImages(
        extractedImages,
        file_id,
        tenant_id,
        needsOcr, // Only OCR if the PDF appears scanned
        (current, total) => onProgress?.(45 + (current / total) * 10, `Processing image ${current}/${total}...`)
      );
      
      // Collect OCR text from images
      const ocrTexts = storedImages
        .filter(img => img.ocrText && img.ocrText.length > 20)
        .map(img => `[Page ${img.pageNumber || img.imageIndex + 1}]\n${img.ocrText}`);
      
      if (ocrTexts.length > 0) {
        ocrText = '\n\n--- OCR Extracted Text ---\n' + ocrTexts.join('\n\n');
        console.log(`🔤 OCR extracted ${ocrText.length} chars from ${ocrTexts.length} images`);
      }
    }
    
    // Combine regular text with OCR text
    const combinedText = text + ocrText;

    if (!combinedText || combinedText.length < 10) {
      console.warn('⚠️ No extractable text found');
      await updateFileStatus(file_id, 'ready');
      return {
        success: true,
        file_id,
        filename,
        text_length: 0,
        chunks_created: 0,
        embeddings_generated: 0,
        model: config.openai.embeddingModel,
        processing_time_ms: Date.now() - startTime,
      };
    }

    // 6. Chunk text — Layout-aware for PDF/DOCX, structured for CSV, fallback for others
    onProgress?.(55, 'Chunking text with layout analysis...');
    await updateProcessingStage(file_id, 'chunking');
    const isCsvOrExcel = isCsvExcelFile(filename, filetype);
    const isPdf = filetype === 'application/pdf';
    const isDocx = filetype.includes('word') || filetype.includes('document') || filename.endsWith('.docx');
    let chunks: { content: string; metadata: DocumentChunk['metadata'] }[];

    if (isPdf) {
      // ── Layout-Aware PDF Pipeline ──
      console.log(`📐 PDF detected — running layout-aware extraction pipeline`);
      onProgress?.(55, 'Analyzing PDF layout...');
      try {
        const layoutResult = await extractPdfLayout(fileBuffer);
        if (layoutResult.elements.length > 0) {
          const layoutChunks = chunkByLayout(layoutResult.elements, filename);
          // Enrich with legal metadata from the full text
          const docMeta = extractDocumentMetadata(combinedText, filename);
          chunks = layoutChunks.map(lc => ({
            content: lc.content,
            metadata: {
              ...lc.metadata,
              document_type: docMeta.document_type,
              court: docMeta.court,
              jurisdiction: docMeta.jurisdiction,
              year: docMeta.year,
              case_number: docMeta.case_number,
              sections_referenced: docMeta.sections_referenced,
              names_mentioned: docMeta.names_mentioned,
              emails_mentioned: docMeta.emails_mentioned,
              phones_mentioned: docMeta.phones_mentioned,
            },
          }));
          console.log(`📐 Layout-aware: ${chunks.length} chunks, ${layoutResult.sectionNames.length} sections detected`);
        } else {
          // Fallback: layout extraction found nothing (scanned PDF), use standard chunking
          console.log(`⚠️ Layout extraction found no elements, falling back to standard chunking`);
          chunks = chunkTextWithMetadata(combinedText, { filename });
        }
      } catch (layoutErr) {
        console.warn(`⚠️ Layout extraction failed, falling back to standard chunking:`, layoutErr);
        chunks = chunkTextWithMetadata(combinedText, { filename });
      }
    } else if (isDocx) {
      // ── Layout-Aware DOCX Pipeline ──
      console.log(`📐 DOCX detected — running layout-aware extraction pipeline`);
      onProgress?.(55, 'Analyzing DOCX layout...');
      try {
        const docxLayout = await extractDocxLayout(fileBuffer);
        if (docxLayout.elements.length > 0) {
          const layoutChunks = chunkByLayout(docxLayout.elements, filename);
          const docMeta = extractDocumentMetadata(combinedText, filename);
          chunks = layoutChunks.map(lc => ({
            content: lc.content,
            metadata: {
              ...lc.metadata,
              document_type: docMeta.document_type,
              court: docMeta.court,
              jurisdiction: docMeta.jurisdiction,
              year: docMeta.year,
              case_number: docMeta.case_number,
              sections_referenced: docMeta.sections_referenced,
              names_mentioned: docMeta.names_mentioned,
              emails_mentioned: docMeta.emails_mentioned,
              phones_mentioned: docMeta.phones_mentioned,
            },
          }));
          console.log(`📐 DOCX layout-aware: ${chunks.length} chunks, ${docxLayout.sectionNames.length} sections`);
        } else {
          chunks = chunkTextWithMetadata(combinedText, { filename });
        }
      } catch (docxLayoutErr) {
        console.warn(`⚠️ DOCX layout extraction failed, falling back to standard chunking:`, docxLayoutErr);
        chunks = chunkTextWithMetadata(combinedText, { filename });
      }
    } else if (isCsvOrExcel) {
      // ── CSV Intelligence Pipeline ──
      console.log(`📊 CSV/Excel detected — running structured intelligence pipeline`);
      onProgress?.(55, 'Parsing structured data...');

      const csvResult = processCsvIntelligence(fileBuffer, filename);

      if (csvResult.datasets.length > 0) {
        // Store each dataset to csv_datasets table for deterministic queries
        for (const dataset of csvResult.datasets) {
          await storeCsvDataset(dataset, file_id, tenant_id, case_id, filename);
        }
        console.log(`📊 Stored ${csvResult.datasets.length} structured dataset(s)`);

        // Store entity candidates from CSV categorical columns into matter_entities
        if (csvResult.entityCandidates.length > 0 && case_id) {
          try {
            const entityRecords = csvResult.entityCandidates.map(ec => ({
              tenant_id,
              case_id,
              file_id,
              entity_type: ec.entityType,
              entity_value: ec.value,
              normalized_value: ec.value.toLowerCase(),
              confidence: Math.min(0.7 + (ec.occurrences / csvResult.datasets[0].rowCount) * 0.3, 0.95),
              source: 'csv_extraction',
              extraction_method: 'csv_categorical_column',
              context_snippet: `From column "${ec.columnName}" (${ec.occurrences} occurrences)`,
            }));
            const BATCH = 50;
            for (let i = 0; i < entityRecords.length; i += BATCH) {
              await supabaseAdmin.from('matter_entities').insert(entityRecords.slice(i, i + BATCH));
            }
            console.log(`👤 Stored ${entityRecords.length} entity candidates from CSV columns`);
          } catch (entityErr) {
            console.warn('⚠️ Failed to store CSV entities (non-fatal):', entityErr);
          }
        }

        // Use smart RAG chunks (header-aware row groups + summary chunk)
        chunks = csvResult.ragChunks.map((content, index) => ({
          content,
          metadata: {
            filename,
            chunk_index: index,
            total_chunks: csvResult.ragChunks.length,
            start_char: 0,
            end_char: content.length,
            document_type: 'spreadsheet',
          },
        }));
        console.log(`📦 Created ${chunks.length} smart CSV chunks (header-aware)`);
      } else {
        // Fallback: treat as regular text if parsing failed
        console.warn(`⚠️ CSV parsing produced no datasets, falling back to text chunking`);
        chunks = chunkTextWithMetadata(combinedText, { filename });
      }
    } else {
      chunks = chunkTextWithMetadata(combinedText, { filename });
    }
    console.log(`📦 Created ${chunks.length} chunks with rich metadata`);

    if (chunks.length === 0) {
      await updateFileStatus(file_id, 'ready');
      return {
        success: true,
        file_id,
        filename,
        text_length: combinedText.length,
        chunks_created: 0,
        embeddings_generated: 0,
        model: config.openai.embeddingModel,
        processing_time_ms: Date.now() - startTime,
      };
    }

    // 7. Generate embeddings
    onProgress?.(60, 'Generating embeddings...');
    await updateProcessingStage(file_id, 'generating_embeddings');
    const chunkTexts = chunks.map(c => c.content);
    const embeddings = await generateEmbeddings(
      chunkTexts,
      (completed, total) => onProgress?.(60 + (completed / total) * 30, 'Generating embeddings...')
    );
    console.log(`🧠 Generated ${embeddings.length} embeddings`);

    // 8. Save to database
    onProgress?.(90, 'Saving to database...');
    await updateProcessingStage(file_id, 'saving');
    await saveChunks({
      chunks,
      embeddings,
      file_id,
      tenant_id,
      case_id,
      folder_id,
    });

    // 9. Update status to ready
    await updateFileStatus(file_id, 'ready');
    onProgress?.(100, 'Complete!');

    // 10. Queue legal extraction (runs asynchronously in background)
    // Skip extraction for General Documents - it's just a workspace dump, not a specific matter
    let shouldExtract = true;
    if (case_id) {
      try {
        const { data: caseData } = await supabaseAdmin
          .from('cases')
          .select('name')
          .eq('id', case_id)
          .single();
        
        if (caseData?.name === 'General Documents') {
          shouldExtract = false;
          console.log(`⏭️  Skipping extraction for General Documents (${filename})`);
        }
      } catch (caseCheckError) {
        console.warn(`⚠️ Failed to check case name for extraction decision:`, caseCheckError);
        // Default to extracting if check fails
      }
    }

    if (shouldExtract) {
      try {
        await addExtractionJob({
          file_id,
          tenant_id,
          case_id,
          filename,
        });
        console.log(`🧠 Legal extraction queued for ${filename}`);
      } catch (extractionError) {
        // Don't fail the upload if extraction queueing fails
        console.warn(`⚠️ Failed to queue legal extraction for ${filename}:`, extractionError);
      }
    }

    const result: ProcessingResult = {
      success: true,
      file_id,
      filename,
      text_length: combinedText.length,
      chunks_created: chunks.length,
      embeddings_generated: embeddings.length,
      model: config.openai.embeddingModel,
      processing_time_ms: Date.now() - startTime,
    };

    console.log(`✅ Document processed in ${result.processing_time_ms}ms`);
    return result;

  } catch (error) {
    console.error(`❌ Document processing failed:`, error);

    await updateFileStatus(file_id, 'failed');

    return {
      success: false,
      file_id,
      filename,
      text_length: 0,
      chunks_created: 0,
      embeddings_generated: 0,
      model: config.openai.embeddingModel,
      processing_time_ms: Date.now() - startTime,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Download file from Supabase Storage
 */
async function downloadFile(storagePath: string): Promise<Buffer> {
  console.log(`📥 Downloading from path: ${storagePath}`);
  
  const { data, error } = await supabaseAdmin.storage
    .from('documents')
    .download(storagePath);

  if (error || !data) {
    console.error('❌ Storage download error:', JSON.stringify(error, null, 2));
    throw new Error(`Failed to download file: ${JSON.stringify(error) || 'No data returned'}`);
  }

  // Convert Blob to Buffer
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Update file status and processing stage in database
 */
async function updateFileStatus(
  fileId: string,
  status: 'processing' | 'ready' | 'failed',
  processing_stage?: string | null
): Promise<void> {
  const updateData: Record<string, any> = { status };
  
  // Set processing_stage: clear it when file is done (ready/failed)
  if (status === 'ready' || status === 'failed') {
    updateData.processing_stage = null;
  } else if (processing_stage !== undefined) {
    updateData.processing_stage = processing_stage;
  }

  const { error } = await supabaseAdmin
    .from('vault_assets')
    .update(updateData)
    .eq('id', fileId);

  if (error) {
    console.error(`Failed to update file status:`, error);
  }
}

/**
 * Update just the processing stage (without changing status)
 */
async function updateProcessingStage(fileId: string, stage: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('vault_assets')
    .update({ processing_stage: stage })
    .eq('id', fileId);

  if (error) {
    console.error(`Failed to update processing stage:`, error);
  }
}

/**
 * Save chunks with embeddings to database
 */
async function saveChunks(params: {
  chunks: { content: string; metadata: DocumentChunk['metadata'] }[];
  embeddings: number[][];
  file_id: string;
  tenant_id: string;
  case_id?: string;
  folder_id?: string;
}): Promise<void> {
  const { chunks, embeddings, file_id, tenant_id, case_id, folder_id } = params;

  // Delete existing chunks for this file (in case of reprocessing)
  const { error: deleteError } = await supabaseAdmin
    .from('document_chunks')
    .delete()
    .eq('file_id', file_id);

  if (deleteError) {
    console.warn(`Warning: Could not delete existing chunks:`, deleteError);
  }

  // Prepare chunk records
  const chunkRecords = chunks.map((chunk, index) => ({
    tenant_id,
    file_id,
    case_id: case_id || null,
    folder_id: folder_id || null,
    content: chunk.content,
    metadata: chunk.metadata,
    embedding: embeddings[index],
  }));

  // Insert in batches
  const BATCH_SIZE = 50;
  for (let i = 0; i < chunkRecords.length; i += BATCH_SIZE) {
    const batch = chunkRecords.slice(i, i + BATCH_SIZE);

    const { error } = await supabaseAdmin
      .from('document_chunks')
      .insert(batch);

    if (error) {
      throw new Error(`Failed to save chunks: ${error.message}`);
    }

    console.log(`💾 Saved chunks ${i + 1}-${Math.min(i + BATCH_SIZE, chunkRecords.length)}`);
  }
}

/**
 * Detect if a file is CSV or Excel based on filename/MIME type
 */
function isCsvExcelFile(filename: string, filetype: string): boolean {
  const ext = filename.toLowerCase();
  if (ext.endsWith('.csv') || ext.endsWith('.xlsx') || ext.endsWith('.xls')) return true;
  if (filetype === 'text/csv' || filetype === 'application/csv') return true;
  if (filetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return true;
  if (filetype === 'application/vnd.ms-excel') return true;
  return false;
}
