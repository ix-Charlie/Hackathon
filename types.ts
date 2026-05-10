export enum Role {
  USER = 'user',
  MODEL = 'model'
}

// Source citation from RAG retrieval
export interface SourceCitation {
  filename: string;
  chunk_index?: number;
  similarity: number;
}

// ============================================================================
// CHAT ATTACHMENTS — Unified file/image attachment for chat messages
// ============================================================================

export type ChatAttachmentType = 'file' | 'image';

/** Represents a file or image attached to a chat message */
export interface ChatAttachment {
  id: string;                    // UUID assigned by backend
  filename: string;
  mime_type: string;
  size: number;                  // bytes
  storage_path: string;          // Supabase Storage path (chat-temp/ or documents/)
  type: ChatAttachmentType;      // 'file' or 'image'
  extracted_text?: string;       // Text extracted from documents (set by backend)
  vision_result?: string;        // GPT-4o Vision analysis (set by backend for images)
  promoted_asset_id?: string;    // vault_assets.id if user promoted to vault
  thumbnail_url?: string;        // Signed URL for image preview
}

/** Pending attachment in the UI before sending (local File object) */
export interface PendingAttachment {
  id: string;                    // Local UUID for UI tracking
  file: File;                    // Browser File object
  filename: string;
  mime_type: string;
  size: number;
  type: ChatAttachmentType;
  preview_url?: string;          // Local object URL for image thumbnails
  status: 'pending' | 'uploading' | 'error';
  error?: string;
}

// ── Agent Pipeline Types ───────────────────────────────────────────────────
export type AgentTaskType =
  | 'legal_research'
  | 'document_drafting'
  | 'contract_review'
  | 'case_summary'
  | 'litigation_strategy'
  | 'deposition_analysis'
  | 'document_export'
  | 'general_chat'
  | 'workspace_management';

export type ArtifactDocumentType =
  | 'motion'
  | 'memo'
  | 'brief'
  | 'letter'
  | 'contract_draft'
  | 'discovery_request'
  | 'deposition_outline'
  | 'case_summary'
  | 'legal_analysis'
  | 'compliance_report'
  | 'settlement_agreement'
  | 'other';

/** Lightweight artifact reference stored on ChatMessage (not the full content) */
export interface ArtifactRef {
  id: string;
  title: string;
  document_type: ArtifactDocumentType;
  created_at: string;
}

/** Metadata attached to an artifact (jurisdiction, court, etc.) */
export interface ArtifactMetadata {
  jurisdiction?: string;
  court?: string;
  [key: string]: unknown;
}

/** Full artifact record (used by artifactService) */
export interface Artifact {
  id: string;
  title: string;
  type: ArtifactDocumentType;
  format?: 'markdown' | 'html';
  content: string;
  metadata: ArtifactMetadata;
  session_id?: string;
  case_id?: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  timestamp: number;
  isError?: boolean;
  isRateLimit?: boolean; // True when error is due to rate limit
  sources?: SourceCitation[]; // Sources used for this response
  thinking?: string; // AI's reasoning process before responding (substantive steps only)
  isThinking?: boolean; // Currently in thinking phase
  hasSubstantiveWork?: boolean; // True when RAG, tools, or reasoning tier was used
  isExportReady?: boolean; // True when response contains an exportable document
  exportTitle?: string; // Title extracted from <!-- HORIZON_EXPORT title="..." --> marker
  dbId?: string; // Database primary key (set after DB save)
  attachments?: ChatAttachment[]; // Attached files/images
  agentTask?: AgentTaskType; // Pipeline task type for this message
  artifacts?: ArtifactRef[]; // Artifacts generated during this response
  stateLabel?: string; // Current pipeline state label (e.g. "Creating file...")
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  timestamp: number;
  pinned?: boolean; // Pinned chats appear at top
  messageCount?: number; // Cached count from DB
  lastPreview?: string; // Last user message preview from DB
  case_id?: string; // Linked matter ID for scoped RAG context
}

// ============================================================================
// MATTER TYPES — Enterprise legal matter classification
// ============================================================================

export type MatterType = 'litigation' | 'transaction' | 'compliance' | 'regulatory' | 'advisory' | 'ip' | 'employment' | 'other';

/** DB stores 'active'|'archived'|'closed'; UI displays Open/Archived/Closed */
export type MatterStatus = 'active' | 'archived' | 'closed';

export interface Case {
  id: string;
  tenant_id: string;
  case_number?: string;
  name: string;
  description?: string;
  client_name?: string;
  status: MatterStatus;
  created_by?: string;
  created_at: string;
  updated_at: string;
  archived_at?: string;
  
  // Matter metadata
  matter_type?: MatterType;
  matter_ref?: string; // Auto-generated: MAT-000001
  
  // Computed fields (from frontend aggregation)
  folder_count?: number;
  file_count?: number;
}

/** UI-level alias — use 'Matter' in frontend components, 'Case' in backend/service layer */
export type Matter = Case;

export interface Folder {
  id: string;
  tenant_id: string;
  case_id: string;
  parent_folder_id?: string;
  name: string;
  description?: string;
  folder_type?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
  
  // Computed
  file_count?: number;
}

export type VaultAssetType = 'document' | 'image' | 'spreadsheet' | 'unknown';

export interface UploadedFile {
  id: string;
  name: string;
  mimeType: string;
  data: string; // Base64 string for PDFs/Images or raw text for CSV/TXT
  size: number;
  tokenCount?: number; // Estimated
  
  // Organization
  case_id?: string;
  folder_id?: string;
  tenant_id?: string;
  uploaded_by?: string;
  created_at?: string;
  status?: 'uploaded' | 'processing' | 'ready' | 'failed';
  processing_stage?: string | null;
  asset_type?: VaultAssetType;
  
  // For display
  case_name?: string;
  folder_name?: string;
  
  // Image asset fields
  ocr_text?: string;
  vision_summary?: string;
  classification?: 'legal_document' | 'evidence' | 'photo' | 'other';
  confidence_score?: number;
  thumbnail_url?: string;
  normalized_url?: string;
  entities?: string[];
  linked_case_id?: string;
  match_score?: number;
  link_status?: 'auto' | 'suggested' | 'none';
}

export interface DocumentImage {
  id: string;
  filename: string;
  storagePath: string;
  pageNumber?: number;
  imageIndex: number;
  width?: number;
  height?: number;
  mimeType: string;
  fileSize: number;
  ocrText?: string;
  ocrConfidence?: number;
  url?: string;
}

export interface FileProcessingState {
  isProcessing: boolean;
  error?: string;
}

export enum AppView {
  UPLOAD = 'UPLOAD',
  CHAT = 'CHAT',
  VAULT = 'VAULT',
  INTELLIGENCE = 'INTELLIGENCE',
  SETTINGS = 'SETTINGS',
  PRICING = 'PRICING',
}

// ============================================================================
// HORIZON MODES — Structured legal workflow modes
// ============================================================================

export type HorizonMode = 'general' | 'legal_research' | 'contract_review' | 'multi_document' | 'summary' | 'drafting';

export interface ModeSubOption {
  id: string;
  label: string; // 1-3 word toggle label
  effect: string; // One-sentence description of what this toggle changes
  defaultOn: boolean;
  exclusiveWith?: string[]; // IDs of options that auto-deselect when this is selected
}

export interface ModeDisplayConfig {
  label: string;
  shortLabel: string; // Compact label for tab bar
  description: string;
  icon: string; // emoji
  subOptions?: ModeSubOption[]; // Functional toggles that modify output behavior
}

export const HORIZON_MODES: Record<HorizonMode, ModeDisplayConfig> = {
  general: {
    label: 'Auto Detect',
    shortLabel: 'Auto',
    description: 'Automatically selects the best mode for your query',
    icon: '',
  },
  legal_research: {
    label: 'Legal Research',
    shortLabel: 'Research',
    description: 'Structured IRAC analysis with case law citations',
    icon: '',
    subOptions: [
      { id: 'irac_structure', label: 'IRAC Structure', effect: 'Outputs Issue → Rule → Application → Conclusion format', defaultOn: true },
      { id: 'case_citations', label: 'Case Citations', effect: 'Includes statute and precedent citations with source attribution', defaultOn: true },
      { id: 'deep_analysis', label: 'Deep Analysis', effect: 'Expands reasoning with counterarguments and risk weighting', defaultOn: false },
      { id: 'jurisdiction_notes', label: 'Jurisdiction Notes', effect: 'Appends jurisdiction-specific caveats and cross-jurisdictional differences', defaultOn: false },
      { id: 'argument_mapping', label: 'Argument Mapping', effect: 'Structures arguments with facts, authority, strength, and counter-arguments in a table', defaultOn: false },
      { id: 'strategy_matrix', label: 'Strategy Matrix', effect: 'Produces a decision matrix with probability, impact, cost, and weakness exploitation', defaultOn: false },
    ],
  },
  contract_review: {
    label: 'Contract Review',
    shortLabel: 'Contracts',
    description: 'Clause-by-clause risk analysis with amendments',
    icon: '',
    subOptions: [
      { id: 'risk_flags', label: 'Risk Flags', effect: 'Adds severity-rated risk assessment for each clause', defaultOn: true },
      { id: 'clause_breakdown', label: 'Clause Breakdown', effect: 'Outputs clause-by-clause analysis with exact text quotation', defaultOn: true },
      { id: 'market_benchmark', label: 'Market Benchmark', effect: 'Compares flagged clauses against standard market terms', defaultOn: false },
      { id: 'redline_suggestions', label: 'Redline Suggestions', effect: 'Generates proposed alternative language for flagged clauses', defaultOn: false },
    ],
  },
  multi_document: {
    label: 'Multi-Document Compare',
    shortLabel: 'Compare',
    description: 'Cross-reference and compare across multiple files',
    icon: '',
    subOptions: [
      { id: 'side_by_side', label: 'Side-by-Side', effect: 'Outputs a comparison matrix table with per-document columns', defaultOn: true },
      { id: 'conflicts', label: 'Conflicts', effect: 'Highlights contradictions and material inconsistencies between documents', defaultOn: true },
      { id: 'term_variations', label: 'Term Variations', effect: 'Extracts differences in defined terms and conditions across documents', defaultOn: false },
      { id: 'chronology', label: 'Chronology', effect: 'Builds a merged timeline of events across all documents', defaultOn: false },
    ],
  },
  summary: {
    label: 'Document Summary',
    shortLabel: 'Summary',
    description: 'Extract key facts, dates, parties, and obligations',
    icon: '',
    subOptions: [
      { id: 'key_facts', label: 'Key Facts', effect: 'Extracts material facts ranked by legal relevance with source citations', defaultOn: true },
      { id: 'deadlines', label: 'Deadlines', effect: 'Isolates all dates, deadlines, and time-sensitive obligations', defaultOn: false },
      { id: 'obligations', label: 'Obligations', effect: 'Extracts outstanding duties, action items, and responsible parties', defaultOn: false },
      { id: 'executive_brief', label: 'Executive Brief', effect: 'Adds a 3-5 sentence summary suitable for senior stakeholder review', defaultOn: true },
    ],
  },
  drafting: {
    label: 'Legal Drafting',
    shortLabel: 'Drafting',
    description: 'Generate motions, memos, letters, and contracts',
    icon: '',
    subOptions: [
      { id: 'formal_tone', label: 'Formal Tone', effect: 'Uses formal, courtroom-appropriate language and numbered sections', defaultOn: true, exclusiveWith: ['plain_language'] },
      { id: 'plain_language', label: 'Plain Language', effect: 'Uses clear, client-facing language avoiding unnecessary legalese', defaultOn: false, exclusiveWith: ['formal_tone'] },
      { id: 'with_authorities', label: 'With Authorities', effect: 'Includes supporting legal authorities, statutes, and precedent references', defaultOn: false },
      { id: 'jurisdiction_align', label: 'Jurisdiction Align', effect: 'Adds jurisdiction-specific conventions and local practice notes', defaultOn: false },
    ],
  },
};

/** Returns the default-on sub-option IDs for a given mode */
export function getDefaultSubOptions(mode: HorizonMode): string[] {
  const config = HORIZON_MODES[mode];
  if (!config.subOptions) return [];
  return config.subOptions.filter(o => o.defaultOn).map(o => o.id);
}

/** Returns default sub-options for all modes */
export function getAllDefaultSubOptions(): Record<HorizonMode, string[]> {
  const modes = Object.keys(HORIZON_MODES) as HorizonMode[];
  const result: Partial<Record<HorizonMode, string[]>> = {};
  for (const m of modes) {
    result[m] = getDefaultSubOptions(m);
  }
  return result as Record<HorizonMode, string[]>;
}

// ============================================================================
// LEGAL ACTION FLAGS — Execution modifiers sent alongside each message
// ============================================================================

export const JURISDICTIONS = [
  'US-Federal',
  'US-State',
  'UK',
  'EU',
  'Canada',
  'Australia',
  'Custom',
] as const;

export type Jurisdiction = (typeof JURISDICTIONS)[number];

export interface LegalActionFlags {
  web_search_enabled: boolean;
  jurisdiction: Jurisdiction | null;
  deep_analysis: boolean;
  strict_citations: boolean;
  privilege_review: boolean;
  fast_mode: boolean;
}

export const DEFAULT_LEGAL_ACTION_FLAGS: LegalActionFlags = {
  web_search_enabled: false,
  jurisdiction: null,
  deep_analysis: false,
  strict_citations: false,
  privilege_review: false,
  fast_mode: false,
};

// ============================================================================
// SUBSCRIPTION & BILLING TYPES
// ============================================================================

export type PlanName = 'starter' | 'team' | 'firm' | 'enterprise';

export interface PlanInfo {
  id: string;
  name: PlanName;
  display_name: string;
  description: string | null;
  price_monthly: number;
  monthly_credits: number;
  max_documents: number;
  max_file_size_mb: number;
  max_users_per_tenant: number;
  max_storage_mb: number;
  enable_multi_stage_reasoning: boolean;
  multi_stage_level: 'none' | 'limited' | 'full';
  response_priority: 'standard' | 'fast' | 'priority';
  allowed_modes: string[];
  per_seat_price_monthly: number;
  enable_structured_export: boolean;
  enable_admin_dashboard: boolean;
  enable_usage_dashboard: boolean;
  enable_api_access: boolean;
  enable_shared_knowledge_base: boolean;
  features: Record<string, any>;
}

export interface CreditCheck {
  allowed: boolean;
  used: number;
  limit: number;
  percent: number;
  warning: boolean;
  remaining: number;
  resetDate: string;
}

export interface FeatureFlags {
  planName: string;
  planDisplayName: string;
  enableMultiStage: boolean;
  multiStageLevel: 'none' | 'limited' | 'full';
  monthlyCredits: number;
  maxDocuments: number;
  maxFileSizeMb: number;
  maxStorageMb: number;
  maxSeats: number;
  responsePriority: 'standard' | 'fast' | 'priority';
  allowedModes: string[];
  perSeatPriceMonthly: number;
  enableStructuredExport: boolean;
  enableAdminDashboard: boolean;
  enableUsageDashboard: boolean;
  enableApiAccess: boolean;
  enableSharedKnowledgeBase: boolean;
  supportLevel: string;
}

export interface BillingStatus {
  hasSubscription: boolean;
  status: string;
  plan: {
    name: string;
    displayName: string;
    priceMonthly: number;
  } | null;
  billing: {
    cycle: string;
    currentPeriodEnd: string;
    canceledAt: string | null;
    hasStripeSubscription: boolean;
  } | null;
  credits: CreditCheck | null;
  features: FeatureFlags | null;
  usage: {
    members: number;
    maxMembers: number;
    documents: number;
    maxDocuments: number;
  } | null;
}
