/**
 * Legal Extraction / Matter Intelligence Routes
 * Endpoints for accessing extracted legal intelligence per matter
 */

import { Router, Request, Response } from 'express';
import { verifyToken, supabaseAdmin } from '../config/supabase.js';
import {
  addExtractionJob,
  getExtractionJobByFileId,
  getExtractionQueueStats,
} from '../services/queueService.js';
import { generateMatterSummary, refreshStaleSummary } from '../services/matterSummaryService.js';
import {
  backendCache,
  extractionCacheKey,
  summaryCacheKey,
  CACHE_TTLS,
  extractionTTL,
} from '../services/cacheManager.js';
import {
  getTenantUsageSummary,
  getDailyUsage,
} from '../services/tokenUsageService.js';
import {
  validateUUIDParams,
  validateEnum,
  sanitizeLikePattern,
  isValidUUID,
  isValidISODate,
  clampNumber,
} from '../middleware/security.js';
import { runCanonicalizationPipeline } from '../services/entityCanonicalizer.js';

const router = Router();

/**
 * Middleware to verify authentication and attach user + tenant
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

  (req as any).user = user;
  next();
}

/**
 * Helper: get the user's tenant_id from Supabase
 */
async function getUserTenantId(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('tenant_members')
    .select('tenant_id')
    .eq('user_id', userId)
    .single();

  if (error || !data) return null;
  return data.tenant_id;
}

/**
 * Helper: verify user has access to the given case/matter
 */
async function verifyCaseAccess(tenantId: string, caseId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('cases')
    .select('id')
    .eq('id', caseId)
    .eq('tenant_id', tenantId)
    .single();

  return !error && !!data;
}

/**
 * Helper: check if case is "General Documents"
 * General Documents is not a specific matter and should not have intelligence data
 */
async function isGeneralDocuments(caseId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('cases')
    .select('name')
    .eq('id', caseId)
    .single();

  if (error || !data) return false;
  return data.name === 'General Documents';
}

// ──────────────────────────────────────────────────────────────
// UUID validation for all :caseId routes
// ──────────────────────────────────────────────────────────────
router.param('caseId', (req, res, next, value) => {
  if (!isValidUUID(value)) {
    return res.status(400).json({ error: 'Invalid caseId: must be a valid UUID' });
  }
  next();
});

// Valid enum values for query param validation
const ENTITY_TYPES = ['party', 'court', 'statute', 'defined_term', 'judge', 'jurisdiction', 'regulatory_body', 'witness', 'law_firm', 'government_agency', 'law_enforcement', 'contract', 'evidence', 'location', 'vehicle', 'publication'] as const;
const CLAUSE_TYPES = ['indemnity', 'limitation_of_liability', 'termination', 'governing_law', 'confidentiality', 'non_compete', 'force_majeure', 'assignment', 'warranty', 'dispute_resolution', 'payment', 'insurance', 'intellectual_property', 'representations', 'notice', 'amendment', 'severability', 'entire_agreement', 'waiver', 'other'] as const;
const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
const OBLIGATION_STATUSES = ['pending', 'fulfilled', 'overdue', 'waived'] as const;
const DATE_TYPES = ['effective', 'termination', 'renewal', 'deadline', 'notice_period', 'payment_due', 'filing', 'hearing', 'expiry', 'commencement', 'review', 'milestone'] as const;
const SEVERITY_LEVELS = ['low', 'medium', 'high', 'critical'] as const;

// ──────────────────────────────────────────────────────────────
// ENTITIES
// ──────────────────────────────────────────────────────────────

/**
 * GET /api/matters/:caseId/entities
 * Get all extracted entities for a matter
 */
router.get('/:caseId/entities', requireAuth, async (req: Request, res: Response) => {
  try {
    const { caseId } = req.params;
    const userId = (req as any).user.id;
    const tenantId = await getUserTenantId(userId);

    if (!tenantId) return res.status(403).json({ error: 'No tenant found' });
    if (!(await verifyCaseAccess(tenantId, caseId))) {
      return res.status(403).json({ error: 'Access denied to this matter' });
    }

    // General Documents doesn't have intelligence data
    if (await isGeneralDocuments(caseId)) {
      return res.json({ entities: [], count: 0 });
    }

    const { entity_type } = req.query;
    const validEntityType = validateEnum(entity_type, [...ENTITY_TYPES]);
    const cacheKey = extractionCacheKey(caseId, `entities:${validEntityType || 'all'}`);
    const cached = backendCache.get<any>(cacheKey);
    if (cached) return res.json(cached);

    let query = supabaseAdmin
      .from('matter_entities')
      .select('*')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId)
      .order('confidence', { ascending: false });

    if (validEntityType) {
      query = query.eq('entity_type', validEntityType);
    }

    const { data, error } = await query;

    if (error) throw error;
    const result = { entities: data, count: data?.length || 0 };
    backendCache.set(cacheKey, result, extractionTTL(result.count));
    res.json(result);
  } catch (err: any) {
    console.error('Error fetching entities:', err);
    res.status(500).json({ error: 'Failed to fetch entities' });
  }
});

// ──────────────────────────────────────────────────────────────
// CANONICAL ENTITIES
// ──────────────────────────────────────────────────────────────

/**
 * GET /api/matters/:caseId/canonical-entities
 * Get deduplicated canonical entities for a matter
 */
router.get('/:caseId/canonical-entities', requireAuth, async (req: Request, res: Response) => {
  try {
    const { caseId } = req.params;
    const userId = (req as any).user.id;
    const tenantId = await getUserTenantId(userId);

    if (!tenantId) return res.status(403).json({ error: 'No tenant found' });
    if (!(await verifyCaseAccess(tenantId, caseId))) {
      return res.status(403).json({ error: 'Access denied to this matter' });
    }

    // General Documents doesn't have intelligence data
    if (await isGeneralDocuments(caseId)) {
      return res.json({ canonical_entities: [], count: 0 });
    }

    const { entity_type, verification_status } = req.query;
    const validEntityType = validateEnum(entity_type, [...ENTITY_TYPES]);
    const validVerification = validateEnum(verification_status, ['unverified', 'auto_verified', 'user_verified', 'rejected']);
    const cacheKey = extractionCacheKey(caseId, `canonical:${validEntityType || 'all'}:${validVerification || 'all'}`);
    const cached = backendCache.get<any>(cacheKey);
    if (cached) return res.json(cached);

    let query = supabaseAdmin
      .from('canonical_entities')
      .select('*')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId)
      .order('mention_count', { ascending: false });

    if (validEntityType) {
      query = query.eq('entity_type', validEntityType);
    }
    if (validVerification) {
      query = query.eq('verification_status', validVerification);
    }

    const { data, error } = await query;

    // Gracefully handle table not existing yet (migration not run)
    if (error?.code === 'PGRST205' || error?.message?.includes('canonical_entities')) {
      const result = { canonical_entities: [], count: 0, migration_pending: true };
      backendCache.set(cacheKey, result, 10_000); // short TTL so it refreshes after migration
      return res.json(result);
    }
    if (error) throw error;
    const result = { canonical_entities: data, count: data?.length || 0 };
    backendCache.set(cacheKey, result, extractionTTL(result.count));
    res.json(result);
  } catch (err: any) {
    console.error('Error fetching canonical entities:', err);
    res.status(500).json({ error: 'Failed to fetch canonical entities' });
  }
});

/**
 * POST /api/matters/:caseId/canonicalize
 * Manually trigger entity canonicalization for a matter
 */
router.post('/:caseId/canonicalize', requireAuth, async (req: Request, res: Response) => {
  try {
    const { caseId } = req.params;
    const userId = (req as any).user.id;
    const tenantId = await getUserTenantId(userId);

    if (!tenantId) return res.status(403).json({ error: 'No tenant found' });
    if (!(await verifyCaseAccess(tenantId, caseId))) {
      return res.status(403).json({ error: 'Access denied to this matter' });
    }

    // Invalidate cached entity data
    backendCache.invalidateByPrefix(`extraction:${caseId}`);

    const result = await runCanonicalizationPipeline(caseId, tenantId);

    res.json({
      message: 'Canonicalization complete',
      ...result,
    });
  } catch (err: any) {
    console.error('Error running canonicalization:', err);
    res.status(500).json({ error: 'Failed to run canonicalization' });
  }
});

// ──────────────────────────────────────────────────────────────
// CLAUSES
// ──────────────────────────────────────────────────────────────

/**
 * GET /api/matters/:caseId/clauses
 * Get all extracted clauses for a matter
 */
router.get('/:caseId/clauses', requireAuth, async (req: Request, res: Response) => {
  try {
    const { caseId } = req.params;
    const userId = (req as any).user.id;
    const tenantId = await getUserTenantId(userId);

    if (!tenantId) return res.status(403).json({ error: 'No tenant found' });
    if (!(await verifyCaseAccess(tenantId, caseId))) {
      return res.status(403).json({ error: 'Access denied to this matter' });
    }

    const { clause_type, risk_level } = req.query;
    const validClauseType = validateEnum(clause_type, [...CLAUSE_TYPES]);
    const validRiskLevel = validateEnum(risk_level, [...RISK_LEVELS]);
    const cacheKey = extractionCacheKey(caseId, `clauses:${validClauseType || 'all'}:${validRiskLevel || 'all'}`);
    const cached = backendCache.get<any>(cacheKey);
    if (cached) return res.json(cached);

    let query = supabaseAdmin
      .from('matter_clauses')
      .select('*')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (validClauseType) {
      query = query.eq('clause_type', validClauseType);
    }
    if (validRiskLevel) {
      query = query.eq('risk_level', validRiskLevel);
    }

    const { data, error } = await query;

    if (error) throw error;
    const result = { clauses: data, count: data?.length || 0 };
    backendCache.set(cacheKey, result, extractionTTL(result.count));
    res.json(result);
  } catch (err: any) {
    console.error('Error fetching clauses:', err);
    res.status(500).json({ error: 'Failed to fetch clauses' });
  }
});

// ──────────────────────────────────────────────────────────────
// OBLIGATIONS
// ──────────────────────────────────────────────────────────────

/**
 * GET /api/matters/:caseId/obligations
 * Get all extracted obligations for a matter
 */
router.get('/:caseId/obligations', requireAuth, async (req: Request, res: Response) => {
  try {
    const { caseId } = req.params;
    const userId = (req as any).user.id;
    const tenantId = await getUserTenantId(userId);

    if (!tenantId) return res.status(403).json({ error: 'No tenant found' });
    if (!(await verifyCaseAccess(tenantId, caseId))) {
      return res.status(403).json({ error: 'Access denied to this matter' });
    }

    // General Documents doesn't have intelligence data
    if (await isGeneralDocuments(caseId)) {
      return res.json({ obligations: [], count: 0, overdue_count: 0 });
    }

    const { status, obligor } = req.query;
    const validStatus = validateEnum(status, [...OBLIGATION_STATUSES]);
    const sanitizedObligor = obligor && typeof obligor === 'string'
      ? sanitizeLikePattern(obligor.slice(0, 200))
      : undefined;
    const cacheKey = extractionCacheKey(caseId, `obligations:${validStatus || 'all'}:${sanitizedObligor || 'all'}`);
    const cached = backendCache.get<any>(cacheKey);
    if (cached) return res.json(cached);

    let query = supabaseAdmin
      .from('matter_obligations')
      .select('*')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId)
      .order('due_date', { ascending: true, nullsFirst: false });

    if (validStatus) {
      query = query.eq('status', validStatus);
    }
    if (sanitizedObligor) {
      query = query.ilike('obligor', `%${sanitizedObligor}%`);
    }

    const { data, error } = await query;

    if (error) throw error;

    // Separate overdue obligations
    const now = new Date().toISOString();
    const overdue = (data || []).filter(
      (o: any) => o.due_date && o.due_date < now && o.status !== 'fulfilled'
    );

    const result = {
      obligations: data,
      count: data?.length || 0,
      overdue_count: overdue.length,
    };
    backendCache.set(cacheKey, result, extractionTTL(result.count));
    res.json(result);
  } catch (err: any) {
    console.error('Error fetching obligations:', err);
    res.status(500).json({ error: 'Failed to fetch obligations' });
  }
});

// ──────────────────────────────────────────────────────────────
// KEY DATES / TIMELINE
// ──────────────────────────────────────────────────────────────

/**
 * GET /api/matters/:caseId/dates
 * Get all extracted dates and deadlines for a matter
 */
router.get('/:caseId/dates', requireAuth, async (req: Request, res: Response) => {
  try {
    const { caseId } = req.params;
    const userId = (req as any).user.id;
    const tenantId = await getUserTenantId(userId);

    if (!tenantId) return res.status(403).json({ error: 'No tenant found' });
    if (!(await verifyCaseAccess(tenantId, caseId))) {
      return res.status(403).json({ error: 'Access denied to this matter' });
    }

    // General Documents doesn't have intelligence data
    if (await isGeneralDocuments(caseId)) {
      return res.json({ dates: [], count: 0, upcoming_count: 0 });
    }

    const { date_type, upcoming_only } = req.query;
    const validDateType = validateEnum(date_type, [...DATE_TYPES]);
    const cacheKey = extractionCacheKey(caseId, `dates:${validDateType || 'all'}:${upcoming_only || 'false'}`);
    const cached = backendCache.get<any>(cacheKey);
    if (cached) return res.json(cached);

    let query = supabaseAdmin
      .from('matter_dates')
      .select('*')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId)
      .order('date_value', { ascending: true });

    if (validDateType) {
      query = query.eq('date_type', validDateType);
    }
    if (upcoming_only === 'true') {
      query = query.gte('date_value', new Date().toISOString());
    }

    const { data, error } = await query;

    if (error) throw error;
    const result = { dates: data, count: data?.length || 0 };
    backendCache.set(cacheKey, result, extractionTTL(result.count));
    res.json(result);
  } catch (err: any) {
    console.error('Error fetching dates:', err);
    res.status(500).json({ error: 'Failed to fetch dates' });
  }
});

/**
 * GET /api/matters/:caseId/timeline
 * Get a chronological timeline combining dates, obligations, and key events
 */
router.get('/:caseId/timeline', requireAuth, async (req: Request, res: Response) => {
  try {
    const { caseId } = req.params;
    const userId = (req as any).user.id;
    const tenantId = await getUserTenantId(userId);

    if (!tenantId) return res.status(403).json({ error: 'No tenant found' });
    if (!(await verifyCaseAccess(tenantId, caseId))) {
      return res.status(403).json({ error: 'Access denied to this matter' });
    }

    

    // Fetch dates and obligations in parallel
    const [datesResult, obligationsResult] = await Promise.all([
      supabaseAdmin
        .from('matter_dates')
        .select('id, date_value, date_type, description, file_id, confidence')
        .eq('case_id', caseId)
        .eq('tenant_id', tenantId),
      supabaseAdmin
        .from('matter_obligations')
        .select('id, due_date, obligation_type, obligation_text, status, obligor, file_id, created_at')
        .eq('case_id', caseId)
        .eq('tenant_id', tenantId),
    ]);

    const timeline: Array<{
      date: string;
      type: string;
      category: string;
      description: string;
      source_file_id?: string;
      metadata?: Record<string, any>;
    }> = [];

    // Add dates to timeline
    for (const d of datesResult.data || []) {
      timeline.push({
        date: d.date_value,
        type: 'date',
        category: d.date_type,
        description: d.description,
        source_file_id: d.file_id,
        metadata: { confidence: d.confidence },
      });
    }

    // Add obligation deadlines to timeline
    for (const o of obligationsResult.data || []) {
      timeline.push({
        date: o.due_date || o.created_at || new Date().toISOString(),
        type: 'obligation',
        category: o.obligation_type,
        description: o.obligation_text,
        source_file_id: o.file_id,
        metadata: { status: o.status, obligor: o.obligor, has_due_date: !!o.due_date },
      });
    }

    // Sort chronologically
    timeline.sort((a, b) => a.date.localeCompare(b.date));

    res.json({ timeline, count: timeline.length });
  } catch (err: any) {
    console.error('Error building timeline:', err);
    res.status(500).json({ error: 'Failed to build timeline' });
  }
});

// ──────────────────────────────────────────────────────────────
// RISKS
// ──────────────────────────────────────────────────────────────

/**
 * GET /api/matters/:caseId/risks
 * Get all identified risks for a matter
 */
router.get('/:caseId/risks', requireAuth, async (req: Request, res: Response) => {
  try {
    const { caseId } = req.params;
    const userId = (req as any).user.id;
    const tenantId = await getUserTenantId(userId);

    if (!tenantId) return res.status(403).json({ error: 'No tenant found' });
    if (!(await verifyCaseAccess(tenantId, caseId))) {
      return res.status(403).json({ error: 'Access denied to this matter' });
    }
    // General Documents doesn't have intelligence data
    if (await isGeneralDocuments(caseId)) {
      return res.json({ risks: [], count: 0, severity_summary: {} });
    }
    const { severity, category } = req.query;
    const validSeverity = validateEnum(severity, [...SEVERITY_LEVELS]);
    const validCategory = typeof category === 'string' ? category.slice(0, 100) : undefined;
    const cacheKey = extractionCacheKey(caseId, `risks:${validSeverity || 'all'}:${validCategory || 'all'}`);
    const cached = backendCache.get<any>(cacheKey);
    if (cached) return res.json(cached);

    let query = supabaseAdmin
      .from('matter_risks')
      .select('*')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId)
      .order('severity', { ascending: true }); // critical first

    if (validSeverity) {
      query = query.eq('severity', validSeverity);
    }
    if (validCategory) {
      query = query.eq('risk_type', validCategory);
    }

    const { data, error } = await query;

    if (error) throw error;

    // Build severity summary
    const severityCounts: Record<string, number> = {};
    for (const r of data || []) {
      severityCounts[r.severity] = (severityCounts[r.severity] || 0) + 1;
    }

    const result = {
      risks: data,
      count: data?.length || 0,
      severity_summary: severityCounts,
    };
    backendCache.set(cacheKey, result, extractionTTL(result.count));
    res.json(result);
  } catch (err: any) {
    console.error('Error fetching risks:', err);
    res.status(500).json({ error: 'Failed to fetch risks' });
  }
});

// ──────────────────────────────────────────────────────────────
// MATTER SUMMARY
// ──────────────────────────────────────────────────────────────

/**
 * GET /api/matters/:caseId/summary
 * Get the latest matter summary (or all versions)
 */
router.get('/:caseId/summary', requireAuth, async (req: Request, res: Response) => {
  try {
    const { caseId } = req.params;
    const userId = (req as any).user.id;
    const tenantId = await getUserTenantId(userId);

    if (!tenantId) return res.status(403).json({ error: 'No tenant found' });
    if (!(await verifyCaseAccess(tenantId, caseId))) {
      return res.status(403).json({ error: 'Access denied to this matter' });
    }

    // General Documents doesn't have intelligence data
    if (await isGeneralDocuments(caseId)) {
      return res.json({ summary: null, message: 'General Documents does not have a matter summary' });
    }

    

    const { data, error } = await supabaseAdmin
      .from('matter_summaries')
      .select('*')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId)
      .eq('summary_type', 'executive_brief')
      .single();

    if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows

    if (!data) {
      return res.json({ summary: null, message: 'No summary generated yet' });
    }

    // Map DB schema to frontend expected shape
    res.json({
      summary: {
        id: data.id,
        summary_type: data.summary_type,
        content: data.content || {},
        stale: data.stale,
        generated_at: data.generated_at,
        created_at: data.created_at,
      },
    });
  } catch (err: any) {
    console.error('Error fetching summary:', err);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

// ──────────────────────────────────────────────────────────────
// MATTER OVERVIEW (aggregated)
// ──────────────────────────────────────────────────────────────

/**
 * GET /api/matters/:caseId/overview
 * Get a high-level overview of all extracted intelligence for a matter
 */
router.get('/:caseId/overview', requireAuth, async (req: Request, res: Response) => {
  try {
    const { caseId } = req.params;
    const userId = (req as any).user.id;
    const tenantId = await getUserTenantId(userId);

    if (!tenantId) return res.status(403).json({ error: 'No tenant found' });
    if (!(await verifyCaseAccess(tenantId, caseId))) {
      return res.status(403).json({ error: 'Access denied to this matter' });
    }

    // General Documents doesn't have intelligence data
    if (await isGeneralDocuments(caseId)) {
      return res.json({
        entities_count: 0,
        clauses_count: 0,
        obligations_count: 0,
        risks_count: 0,
        dates_count: 0,
        has_summary: false,
        last_extraction_at: null,
      });
    }

    

    // Fetch counts in parallel
    const [entities, clauses, obligations, dates, risks, jobs, canonicalEntities] = await Promise.all([
      supabaseAdmin.from('matter_entities').select('id', { count: 'exact', head: true }).eq('case_id', caseId).eq('tenant_id', tenantId),
      supabaseAdmin.from('matter_clauses').select('id', { count: 'exact', head: true }).eq('case_id', caseId).eq('tenant_id', tenantId),
      supabaseAdmin.from('matter_obligations').select('id', { count: 'exact', head: true }).eq('case_id', caseId).eq('tenant_id', tenantId),
      supabaseAdmin.from('matter_dates').select('id', { count: 'exact', head: true }).eq('case_id', caseId).eq('tenant_id', tenantId),
      supabaseAdmin.from('matter_risks').select('id', { count: 'exact', head: true }).eq('case_id', caseId).eq('tenant_id', tenantId),
      supabaseAdmin.from('extraction_jobs').select('id, status, created_at').eq('case_id', caseId).eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(5),
      supabaseAdmin.from('canonical_entities').select('id', { count: 'exact', head: true }).eq('case_id', caseId).eq('tenant_id', tenantId),
    ]);

    // High-risk items
    const { data: highRisks } = await supabaseAdmin
      .from('matter_risks')
      .select('id, risk_description, severity, risk_type')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId)
      .in('severity', ['critical', 'high'])
      .limit(5);

    // Upcoming obligations
    const { data: upcomingObligations } = await supabaseAdmin
      .from('matter_obligations')
      .select('id, obligation_text, due_date, status, obligor')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId)
      .gte('due_date', new Date().toISOString())
      .neq('status', 'fulfilled')
      .order('due_date', { ascending: true })
      .limit(5);

    res.json({
      matter_id: caseId,
      intelligence: {
        entity_count: entities.count || 0,
        canonical_entity_count: (canonicalEntities.error ? 0 : canonicalEntities.count) || 0,
        clause_count: clauses.count || 0,
        obligation_count: obligations.count || 0,
        date_count: dates.count || 0,
        risk_count: risks.count || 0,
      },
      alerts: {
        high_risks: highRisks || [],
        upcoming_obligations: upcomingObligations || [],
      },
      recent_extractions: (jobs.data || []).map((job: any) => ({
        ...job,
        // Surface supervisory stats if available
        supervisory: job.results ? {
          entity_candidates: job.results.entity_candidates,
          entities_promoted: job.results.entities_promoted,
          pre_filter_rejected: job.results.entities_pre_filter_rejected,
          supervisor_rejected: job.results.entities_supervisor_rejected,
          refinement_triggered: job.results.refinement_triggered,
          refinement_corrections: job.results.refinement_corrections,
        } : undefined,
      })),
    });
  } catch (err: any) {
    console.error('Error building overview:', err);
    res.status(500).json({ error: 'Failed to build matter overview' });
  }
});

// ──────────────────────────────────────────────────────────────
// REPROCESS / EXTRACTION MANAGEMENT
// ──────────────────────────────────────────────────────────────

/**
 * POST /api/matters/:caseId/reprocess
 * Trigger re-extraction for a specific file or all files in a matter
 */
router.post('/:caseId/reprocess', requireAuth, async (req: Request, res: Response) => {
  try {
    const { caseId } = req.params;
    const userId = (req as any).user.id;
    const tenantId = await getUserTenantId(userId);

    if (!tenantId) return res.status(403).json({ error: 'No tenant found' });
    if (!(await verifyCaseAccess(tenantId, caseId))) {
      return res.status(403).json({ error: 'Access denied to this matter' });
    }

    const { file_id } = req.body;

    // Validate file_id if provided
    if (file_id && !isValidUUID(file_id)) {
      return res.status(400).json({ error: 'Invalid file_id: must be a valid UUID' });
    }

    // Invalidate all cached extraction results for this matter
    backendCache.invalidateByPrefix(`extraction:${caseId}`);
    backendCache.invalidateByPrefix(`analysis:${caseId}`);
    backendCache.invalidate(summaryCacheKey(caseId));

    if (file_id) {
      // Reprocess single file
      const { data: file, error } = await supabaseAdmin
        .from('vault_assets')
        .select('id, filename, filetype, case_id, tenant_id')
        .eq('id', file_id)
        .eq('case_id', caseId)
        .eq('tenant_id', tenantId)
        .single();

      if (error || !file) {
        return res.status(404).json({ error: 'File not found in this matter' });
      }

      const job = await addExtractionJob({
        file_id: file.id,
        case_id: caseId,
        tenant_id: tenantId,
        filename: file.filename,
      });

      return res.status(202).json({
        message: 'Extraction job queued',
        job_id: job.id,
        file_id: file.id,
      });
    }

    // Reprocess all files in the matter
    const { data: files, error } = await supabaseAdmin
      .from('vault_assets')
      .select('id, filename, filetype')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId)
      .eq('status', 'ready');

    if (error) throw error;

    const jobs = [];
    for (const file of files || []) {
      const job = await addExtractionJob({
        file_id: file.id,
        case_id: caseId,
        tenant_id: tenantId,
        filename: file.filename,
      });
      jobs.push({ job_id: job.id, file_id: file.id, filename: file.filename });
    }

    res.status(202).json({
      message: `${jobs.length} extraction jobs queued`,
      jobs,
    });
  } catch (err: any) {
    console.error('Error reprocessing:', err);
    res.status(500).json({ error: 'Failed to queue reprocessing' });
  }
});

/**
 * GET /api/matters/:caseId/extraction-status
 * Get extraction job statuses for a matter
 */
router.get('/:caseId/extraction-status', requireAuth, async (req: Request, res: Response) => {
  try {
    const { caseId } = req.params;
    const userId = (req as any).user.id;
    const tenantId = await getUserTenantId(userId);

    if (!tenantId) return res.status(403).json({ error: 'No tenant found' });
    if (!(await verifyCaseAccess(tenantId, caseId))) {
      return res.status(403).json({ error: 'Access denied to this matter' });
    }

    

    const { data, error } = await supabaseAdmin
      .from('extraction_jobs')
      .select('*')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ extraction_jobs: data, count: data?.length || 0 });
  } catch (err: any) {
    console.error('Error fetching extraction status:', err);
    res.status(500).json({ error: 'Failed to fetch extraction status' });
  }
});

/**
 * GET /api/extraction/queue-stats
 * Get extraction queue statistics (admin/debug)
 */
router.get('/queue-stats', requireAuth, async (_req: Request, res: Response) => {
  try {
    const stats = await getExtractionQueueStats();
    res.json({ queue: 'legal-extraction', ...stats });
  } catch (err: any) {
    console.error('Error fetching queue stats:', err);
    res.status(500).json({ error: 'Failed to fetch queue stats' });
  }
});

/**
 * POST /api/matters/:caseId/generate-summary
 * Generate or regenerate a matter summary
 */
router.post('/:caseId/generate-summary', requireAuth, async (req: Request, res: Response) => {
  try {
    const { caseId } = req.params;
    const userId = (req as any).user.id;
    const tenantId = await getUserTenantId(userId);

    if (!tenantId) return res.status(403).json({ error: 'No tenant found' });
    if (!(await verifyCaseAccess(tenantId, caseId))) {
      return res.status(403).json({ error: 'Access denied to this matter' });
    }

    const { force = true } = req.body; // Default to force generation when called from UI

    let result;
    if (force) {
      result = await generateMatterSummary(caseId, tenantId);
    } else {
      result = await refreshStaleSummary(caseId, tenantId);
      if (!result) {
        return res.json({ message: 'Summary is up to date', refreshed: false });
      }
    }

    res.json({ summary: result, refreshed: true });
  } catch (err: any) {
    console.error('Error generating summary:', err);
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

// ──────────────────────────────────────────────────────────────
// CACHE STATS
// ──────────────────────────────────────────────────────────────

/**
 * GET /api/matters/cache-stats
 * Get backend cache statistics
 */
router.get('/cache-stats', requireAuth, async (_req: Request, res: Response) => {
  try {
    res.json(backendCache.getStats());
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get cache stats' });
  }
});

// ──────────────────────────────────────────────────────────────
// TOKEN USAGE
// ──────────────────────────────────────────────────────────────

/**
 * GET /api/matters/usage-summary
 * Get token usage summary for the current tenant
 */
router.get('/usage-summary', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const tenantId = await getUserTenantId(userId);
    if (!tenantId) return res.status(403).json({ error: 'No tenant found' });

    const { start_date, end_date } = req.query;
    const validStartDate = start_date && typeof start_date === 'string' && isValidISODate(start_date) ? start_date : undefined;
    const validEndDate = end_date && typeof end_date === 'string' && isValidISODate(end_date) ? end_date : undefined;
    const summary = await getTenantUsageSummary(
      tenantId,
      validStartDate,
      validEndDate,
    );
    res.json(summary);
  } catch (err: any) {
    console.error('Error fetching usage summary:', err);
    res.status(500).json({ error: 'Failed to fetch usage summary' });
  }
});

/**
 * GET /api/matters/usage-daily
 * Get daily token usage for charts
 */
router.get('/usage-daily', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const tenantId = await getUserTenantId(userId);
    if (!tenantId) return res.status(403).json({ error: 'No tenant found' });

    const days = clampNumber(parseInt(req.query.days as string) || 30, 1, 365);
    const daily = await getDailyUsage(tenantId, days);
    res.json({ daily, days });
  } catch (err: any) {
    console.error('Error fetching daily usage:', err);
    res.status(500).json({ error: 'Failed to fetch daily usage' });
  }
});

export default router;
