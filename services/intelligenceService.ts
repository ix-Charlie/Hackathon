/**
 * Intelligence Service — Frontend API client for Matter Intelligence endpoints
 * 
 * Communicates with:
 *   /api/matters/:caseId/*  (extraction routes)
 *   /api/analysis/:caseId/* (analytical engine routes)
 */

import { supabase } from './supabaseClient';

const API_BASE = '/api';

// ─── Helpers ──────────────────────────────────────────────────

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Not authenticated');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.access_token}`,
  };
}

async function apiFetch<T>(path: string): Promise<T> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error ${res.status}`);
  }
  return res.json();
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new Error(b.error || `API error ${res.status}`);
  }
  return res.json();
}

// ─── Types ────────────────────────────────────────────────────

export interface MatterOverview {
  matter_id: string;
  intelligence: {
    entity_count: number;
    canonical_entity_count: number;
    clause_count: number;
    obligation_count: number;
    date_count: number;
    risk_count: number;
  };
  alerts: {
    high_risks: RiskItem[];
    upcoming_obligations: ObligationItem[];
  };
  recent_extractions: ExtractionJob[];
}

export interface EntityItem {
  id: string;
  entity_type: string;
  entity_value: string;
  normalized_value?: string;
  context_snippet?: string;
  file_id?: string;
  confidence?: number;
  canonical_entity_id?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface CanonicalEntityItem {
  id: string;
  entity_type: string;
  canonical_name: string;
  aliases: string[];
  confidence: number;
  mention_count: number;
  verification_status: 'unverified' | 'auto_verified' | 'user_verified' | 'rejected';
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ClauseItem {
  id: string;
  clause_type: string;
  clause_text: string;
  section_ref?: string;
  summary?: string;
  risk_level?: string;
  risk_reason?: string;
  file_id?: string;
  confidence?: number;
  created_at: string;
}

export interface ObligationItem {
  id: string;
  obligation_text: string;
  obligation_type: string;
  obligor: string;
  obligee: string;
  due_date?: string;
  status: string;
  recurring?: boolean;
  recurrence_rule?: string;
  condition?: string;
  file_id?: string;
  confidence?: number;
  created_at: string;
}

export interface DateItem {
  id: string;
  date_type: string;
  date_value: string;
  description: string;
  is_recurring?: boolean;
  recurrence_rule?: string;
  source_text?: string;
  file_id?: string;
  confidence?: number;
  created_at: string;
}

export interface RiskItem {
  id: string;
  risk_description: string;
  severity: string;
  risk_type?: string;
  recommendation?: string;
  file_id?: string;
  confidence?: number;
  created_at: string;
}

export interface TimelineEntry {
  date: string;
  type: string;
  category: string;
  description: string;
  source_file_id?: string;
  metadata?: Record<string, unknown>;
}

export interface ExtractionJob {
  id: string;
  status: string;
  created_at: string;
  file_id?: string;
}

export interface MatterSummary {
  id: string;
  summary_type: string;
  content: {
    summary_text?: string;
    key_findings?: string[];
    risk_summary?: string;
    [key: string]: unknown;
  };
  stale: boolean;
  generated_at: string;
  created_at: string;
}

export interface ConflictResult {
  conflicts: Array<{
    type: string;
    description: string;
    items: Array<{ id: string; text: string; source?: string }>;
    severity: string;
  }>;
  total: number;
}

export interface ComplianceResult {
  obligations: Array<{
    id: string;
    description: string;
    due_date?: string;
    status: string;
    responsible_party?: string;
    is_overdue: boolean;
    days_until_due?: number;
  }>;
  summary: {
    total: number;
    completed: number;
    pending: number;
    overdue: number;
    compliance_rate: number;
  };
}

export interface RiskMatrixResult {
  matrix: Record<string, RiskItem[]>;
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
  };
}

export interface TimelineAnalysis {
  events: TimelineEntry[];
  clusters: Array<{
    period: string;
    count: number;
    items: TimelineEntry[];
  }>;
}

export interface FullReport {
  overview: MatterOverview;
  conflicts: ConflictResult;
  compliance: ComplianceResult;
  riskMatrix: RiskMatrixResult;
  timeline: TimelineAnalysis;
}

// Wrapped response types from backend
interface EntitiesResponse { entities: EntityItem[]; count: number }
interface CanonicalEntitiesResponse { canonical_entities: CanonicalEntityItem[]; count: number }
interface ClausesResponse { clauses: ClauseItem[]; count: number }
interface ObligationsResponse { obligations: ObligationItem[]; count: number; overdue_count: number }
interface DatesResponse { dates: DateItem[]; count: number }
interface RisksResponse { risks: RiskItem[]; count: number; severity_summary: Record<string, number> }
interface TimelineResponse { timeline: TimelineEntry[]; count: number }
interface SummaryResponse { summary: MatterSummary | null; message?: string }
interface ExtractionStatusResponse { extraction_jobs: ExtractionJob[]; count: number }

// ─── API Functions ────────────────────────────────────────────

// Matter Intelligence (extraction routes)
export const getOverview = (caseId: string) =>
  apiFetch<MatterOverview>(`/matters/${caseId}/overview`);

export const getEntities = async (caseId: string, type?: string): Promise<EntityItem[]> => {
  const res = await apiFetch<EntitiesResponse>(`/matters/${caseId}/entities${type ? `?entity_type=${type}` : ''}`);
  return res.entities || [];
};

export const getCanonicalEntities = async (caseId: string, type?: string): Promise<CanonicalEntityItem[]> => {
  const res = await apiFetch<CanonicalEntitiesResponse>(`/matters/${caseId}/canonical-entities${type ? `?entity_type=${type}` : ''}`);
  return res.canonical_entities || [];
};

export const canonicalizeMatter = (caseId: string) =>
  apiPost<{ message: string; canonical_entities_created: number; raw_entities_linked: number }>(`/matters/${caseId}/canonicalize`);

export const getClauses = async (caseId: string, type?: string): Promise<ClauseItem[]> => {
  const res = await apiFetch<ClausesResponse>(`/matters/${caseId}/clauses${type ? `?clause_type=${type}` : ''}`);
  return res.clauses || [];
};

export const getObligations = async (caseId: string, status?: string): Promise<ObligationItem[]> => {
  const res = await apiFetch<ObligationsResponse>(`/matters/${caseId}/obligations${status ? `?status=${status}` : ''}`);
  return res.obligations || [];
};

export const getDates = async (caseId: string, type?: string): Promise<DateItem[]> => {
  const res = await apiFetch<DatesResponse>(`/matters/${caseId}/dates${type ? `?date_type=${type}` : ''}`);
  return res.dates || [];
};

export const getRisks = async (caseId: string, severity?: string): Promise<RiskItem[]> => {
  const res = await apiFetch<RisksResponse>(`/matters/${caseId}/risks${severity ? `?severity=${severity}` : ''}`);
  return res.risks || [];
};

export const getTimeline = async (caseId: string): Promise<TimelineEntry[]> => {
  const res = await apiFetch<TimelineResponse>(`/matters/${caseId}/timeline`);
  return res.timeline || [];
};

export const getSummary = async (caseId: string): Promise<MatterSummary | null> => {
  const res = await apiFetch<SummaryResponse>(`/matters/${caseId}/summary`);
  return res.summary || null;
};

export const getExtractionStatus = async (caseId: string): Promise<ExtractionJob[]> => {
  const res = await apiFetch<ExtractionStatusResponse>(`/matters/${caseId}/extraction-status`);
  return res.extraction_jobs || [];
};

// Actions
export const reprocessMatter = (caseId: string, fileId?: string) =>
  apiPost<{ message: string; jobId?: string }>(`/matters/${caseId}/reprocess`, fileId ? { file_id: fileId } : {});

export const generateSummary = (caseId: string) =>
  apiPost<{ message: string }>(`/matters/${caseId}/generate-summary`);

// Analytical Engines (analysis routes)
export const getConflicts = (caseId: string) =>
  apiFetch<ConflictResult>(`/analysis/${caseId}/conflicts`);

export const getCompliance = (caseId: string) =>
  apiFetch<ComplianceResult>(`/analysis/${caseId}/compliance`);

export const getRiskMatrix = (caseId: string) =>
  apiFetch<RiskMatrixResult>(`/analysis/${caseId}/risk-matrix`);

export const getTimelineAnalysis = (caseId: string) =>
  apiFetch<TimelineAnalysis>(`/analysis/${caseId}/timeline`);

export const getFullReport = (caseId: string) =>
  apiFetch<FullReport>(`/analysis/${caseId}/full-report`);

// ─── Cross-References ─────────────────────────────────────────

export interface CrossReference {
  id: string;
  reference_type: string;
  source_file_id: string;
  target_file_id: string;
  source_file_name: string;
  target_file_name: string;
  description: string;
  confidence: number;
  created_at: string;
}

interface CrossReferencesResponse { cross_references: CrossReference[]; count: number }

export const getCrossReferences = async (caseId: string): Promise<CrossReference[]> => {
  const res = await apiFetch<CrossReferencesResponse>(`/analysis/${caseId}/cross-references`);
  return res.cross_references || [];
};
