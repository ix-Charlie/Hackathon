/**
 * Types for document processing
 */

// ============================================================================
// VAULT ASSET TYPES — Enterprise asset classification
// ============================================================================

export type VaultAssetType = 'document' | 'image' | 'spreadsheet' | 'unknown';

export interface ProcessDocumentRequest {
  file_id: string;
  tenant_id: string;
  case_id: string;
  folder_id?: string;
  storage_path: string;
  filename: string;
  filetype: string;
}

export interface ProcessDocumentJob extends ProcessDocumentRequest {
  user_id: string;
  created_at: string;
}

export interface ProcessImageJob extends ProcessDocumentRequest {
  user_id: string;
  created_at: string;
  asset_type: 'image';
  /** If this image was extracted from a parent document (PDF/DOCX/XLSX) */
  parent_asset_id?: string;
  /** Page number in the parent document where this image was found */
  source_page?: number;
  /** Index of this image within the parent document */
  image_index?: number;
}

export interface TextChunk {
  content: string;
  metadata: ChunkMetadata;
}

export interface ChunkMetadata {
  filename: string;
  chunk_index: number;
  total_chunks: number;
  start_char: number;
  end_char: number;
  page_number?: number;
  // Layout-aware metadata
  section_name?: string | null;    // Section heading this chunk belongs to (e.g., "THE CHILD(REN)")
  heading_level?: number;          // 1 = top-level heading, 2 = sub-heading
  element_type?: string;           // 'text' | 'table' | 'heading' | 'list' | 'checkbox'
  row_index?: number;              // For table rows: index within the table
  pages_covered?: number[];        // All page numbers this chunk spans
  // Enhanced metadata for legal documents
  document_type?: string;      // 'judgment', 'contract', 'petition', 'fir', 'cv', 'brief'
  court?: string;              // 'Supreme Court', 'High Court', etc.
  jurisdiction?: string;       // 'Pakistan', 'Punjab', etc.
  year?: number;               // Document year
  case_number?: string;        // 'PLD 2021 SC 123', etc.
  sections_referenced?: string[]; // Legal sections: '302 PPC', 'Article 184(3)'
  names_mentioned?: string[];  // Person names found in document
  emails_mentioned?: string[]; // Email addresses found
  phones_mentioned?: string[]; // Phone numbers found
  // Chunk-specific mentions (for granular search)
  chunk_emails?: string[];
  chunk_names?: string[];
}

export interface ProcessingResult {
  success: boolean;
  file_id: string;
  filename: string;
  text_length: number;
  chunks_created: number;
  embeddings_generated: number;
  model: string;
  processing_time_ms: number;
  error?: string;
}

export interface JobStatus {
  job_id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  progress?: number;
  result?: ProcessingResult;
  error?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
}

export interface DocumentFile {
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
}

/** @deprecated Use VaultAsset instead */
export type VaultAsset = DocumentFile;

export interface DocumentProcessingInfo {
  asset_id: string;
  has_images: boolean;
  image_count: number;
  has_ocr_content: boolean;
}

export interface ImageProcessingResult {
  success: boolean;
  file_id: string;
  ocr_text_length: number;
  classification: string;
  confidence_score: number;
  linked_case_id?: string;
  match_score?: number;
  link_status: 'auto' | 'suggested' | 'none';
  processing_time_ms: number;
  error?: string;
}

export interface CaseLinkResult {
  linked_case_id: string | null;
  match_score: number;
  link_status: 'auto' | 'suggested' | 'none';
}

export interface DocumentChunk {
  id?: number;
  tenant_id: string;
  file_id: string;
  case_id?: string;
  folder_id?: string;
  content: string;
  metadata: ChunkMetadata;
  embedding?: number[];
}
