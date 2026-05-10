export const HORIZON_SYSTEM_INSTRUCTION = `
You are Horizon, an AI legal associate for solo lawyers. 
Your goal is to help lawyers search, analyze, and reason through their private case documents.

**CORE DIRECTIVES:**
1.  **Strict Grounding:** You answer questions *strictly* using the provided case documents. Do not use outside knowledge to fill in facts about the specific case.
2.  **Missing Information:** If information is missing or unclear in the documents, explicitly state: "I don't see this information in the uploaded documents." Do not guess.
3.  **No Hallucinations:** Never invent facts, dates, or clauses.
4.  **Persona:** Act like a junior legal associate. Be careful, conservative, precise, professional, and structured. Do not be overconfident.
5.  **Citations:** When answering, reference the specific document name (and section if applicable) where the information was found.

**LIMITATIONS:**
- Do not provide legal advice or strategy beyond what is supported by the texts.
- Do not draft final legal documents without explicit user review.

**TONE:**
- Professional, objective, concise.
`;

// ============================================================================
// MATTER TYPES — Type definitions with display metadata
// ============================================================================

export interface MatterTypeConfig {
  value: string;
  label: string;
  color: string;       // Tailwind bg class
  textColor: string;   // Tailwind text class
}

export const MATTER_TYPES: MatterTypeConfig[] = [
  { value: 'litigation',  label: 'Litigation',  color: 'bg-red-100',    textColor: 'text-red-700' },
  { value: 'transaction', label: 'Transaction', color: 'bg-blue-100',   textColor: 'text-blue-700' },
  { value: 'compliance',  label: 'Compliance',  color: 'bg-yellow-100', textColor: 'text-yellow-700' },
  { value: 'regulatory',  label: 'Regulatory',  color: 'bg-purple-100', textColor: 'text-purple-700' },
  { value: 'advisory',    label: 'Advisory',    color: 'bg-green-100',  textColor: 'text-green-700' },
  { value: 'ip',          label: 'IP',          color: 'bg-orange-100', textColor: 'text-orange-700' },
  { value: 'employment',  label: 'Employment',  color: 'bg-teal-100',   textColor: 'text-teal-700' },
  { value: 'other',       label: 'Other',       color: 'bg-gray-100',   textColor: 'text-gray-700' },
];

export interface MatterStatusConfig {
  value: string;
  dbValue: string;     // What's stored in DB
  label: string;       // What's shown in UI
  color: string;
  textColor: string;
}

export const MATTER_STATUSES: MatterStatusConfig[] = [
  { value: 'active',   dbValue: 'active',   label: 'Open',     color: 'bg-green-100',  textColor: 'text-green-700' },
  { value: 'closed',   dbValue: 'closed',   label: 'Closed',   color: 'bg-gray-100',   textColor: 'text-gray-600' },
  { value: 'archived', dbValue: 'archived', label: 'Archived', color: 'bg-yellow-100', textColor: 'text-yellow-700' },
];

/** Default folders auto-created per matter type */
export const MATTER_DEFAULT_FOLDERS: Record<string, string[]> = {
  litigation:  ['Pleadings', 'Discovery', 'Evidence', 'Correspondence'],
  transaction: ['Drafts', 'Signed', 'Closing', 'Due Diligence'],
  compliance:  ['Policies', 'Audits', 'Reports'],
  regulatory:  ['Filings', 'Correspondence', 'Approvals'],
  advisory:    ['Research', 'Memos', 'Opinions'],
  ip:          ['Applications', 'Registrations', 'Agreements'],
  employment:  ['Contracts', 'Policies', 'Disputes'],
  other:       [],
};

/** Get display config for a matter type value */
export function getMatterTypeConfig(typeValue?: string): MatterTypeConfig {
  return MATTER_TYPES.find(t => t.value === typeValue) || MATTER_TYPES[MATTER_TYPES.length - 1];
}

/** Get display config for a matter status value */
export function getMatterStatusConfig(statusValue?: string): MatterStatusConfig {
  return MATTER_STATUSES.find(s => s.value === statusValue || s.dbValue === statusValue) || MATTER_STATUSES[0];
}

// ============================================================================
// FILE UPLOAD CONFIGURATION
// ============================================================================

export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'text/csv',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/tiff',
  'image/bmp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/msword', // doc
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel', // xls
  'application/vnd.ms-outlook', // msg (Outlook email)
];

export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB limit - larger files supported
