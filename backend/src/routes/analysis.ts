/**
 * Analytical Engine Routes
 * Endpoints for running specialized legal analysis on matter data
 */

import { Router, Request, Response } from 'express';
import { verifyToken, supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/index.js';
import {
  detectConflicts,
  analyzeObligationCompliance,
  buildRiskMatrix,
  analyzeTimeline,
} from '../services/analyticalEngines.js';
import {
  backendCache,
  analysisCacheKey,
  CACHE_TTLS,
} from '../services/cacheManager.js';
import { isValidUUID } from '../middleware/security.js';

const router = Router();

// UUID validation for all :caseId routes
router.param('caseId', (req, res, next, value) => {
  if (!isValidUUID(value)) {
    return res.status(400).json({ error: 'Invalid caseId: must be a valid UUID' });
  }
  next();
});

/**
 * Middleware to verify authentication and extract tenant
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

async function getUserTenantId(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('tenant_members')
    .select('tenant_id')
    .eq('user_id', userId)
    .single();
  if (error || !data) return null;
  return data.tenant_id;
}

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
 * GET /api/analysis/:caseId/conflicts
 * Run conflict detection across all documents in a matter
 */
router.get('/:caseId/conflicts', requireAuth, async (req: Request, res: Response) => {
  try {
    const { caseId } = req.params;
    const userId = (req as any).user.id;
    const tenantId = await getUserTenantId(userId);

    if (!tenantId) return res.status(403).json({ error: 'No tenant found' });
    if (!(await verifyCaseAccess(tenantId, caseId))) {
      return res.status(403).json({ error: 'Access denied to this matter' });
    }

    const openaiApiKey = config.openai.apiKey;
    if (!openaiApiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const cacheKey = analysisCacheKey(caseId, 'conflicts');
    const cached = backendCache.get<any>(cacheKey);
    if (cached) return res.json(cached);

    const result = await detectConflicts(caseId, tenantId, openaiApiKey);
    backendCache.set(cacheKey, result, CACHE_TTLS.ANALYTICAL_ENGINE);

    // Log to audit_logs
    await supabaseAdmin.from('audit_logs').insert({
      tenant_id: tenantId,
      user_id: userId,
      action: 'conflict_detection',
      resource_type: 'case',
      resource_id: caseId,
      details: { conflicts_found: result.conflicts.length },
    });

    res.json(result);
  } catch (err: any) {
    console.error('Conflict detection error:', err);
    res.status(500).json({ error: 'Conflict detection failed' });
  }
});

/**
 * GET /api/analysis/:caseId/compliance
 * Analyze obligation compliance status
 */
router.get('/:caseId/compliance', requireAuth, async (req: Request, res: Response) => {
  try {
    const { caseId } = req.params;
    const userId = (req as any).user.id;
    const tenantId = await getUserTenantId(userId);

    if (!tenantId) return res.status(403).json({ error: 'No tenant found' });
    if (!(await verifyCaseAccess(tenantId, caseId))) {
      return res.status(403).json({ error: 'Access denied to this matter' });
    }

    const complianceCacheKey = analysisCacheKey(caseId, 'compliance');
    const cached = backendCache.get<any>(complianceCacheKey);
    if (cached) return res.json(cached);

    const result = await analyzeObligationCompliance(caseId, tenantId);
    backendCache.set(complianceCacheKey, result, CACHE_TTLS.ANALYTICAL_ENGINE);
    res.json(result);
  } catch (err: any) {
    console.error('Compliance analysis error:', err);
    res.status(500).json({ error: 'Compliance analysis failed' });
  }
});

/**
 * GET /api/analysis/:caseId/risk-matrix
 * Build risk assessment matrix
 */
router.get('/:caseId/risk-matrix', requireAuth, async (req: Request, res: Response) => {
  try {
    const { caseId } = req.params;
    const userId = (req as any).user.id;
    const tenantId = await getUserTenantId(userId);

    if (!tenantId) return res.status(403).json({ error: 'No tenant found' });
    if (!(await verifyCaseAccess(tenantId, caseId))) {
      return res.status(403).json({ error: 'Access denied to this matter' });
    }

    const riskCacheKey = analysisCacheKey(caseId, 'risk-matrix');
    const cached = backendCache.get<any>(riskCacheKey);
    if (cached) return res.json(cached);

    const result = await buildRiskMatrix(caseId, tenantId);
    backendCache.set(riskCacheKey, result, CACHE_TTLS.ANALYTICAL_ENGINE);
    res.json(result);
  } catch (err: any) {
    console.error('Risk matrix error:', err);
    res.status(500).json({ error: 'Risk matrix analysis failed' });
  }
});

/**
 * GET /api/analysis/:caseId/timeline
 * Run timeline analysis with gap detection
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

    const timelineCacheKey = analysisCacheKey(caseId, 'timeline');
    const cached = backendCache.get<any>(timelineCacheKey);
    if (cached) return res.json(cached);

    const result = await analyzeTimeline(caseId, tenantId);
    backendCache.set(timelineCacheKey, result, CACHE_TTLS.ANALYTICAL_ENGINE);
    res.json(result);
  } catch (err: any) {
    console.error('Timeline analysis error:', err);
    res.status(500).json({ error: 'Timeline analysis failed' });
  }
});

/**
 * GET /api/analysis/:caseId/full-report
 * Run all analytical engines and return a comprehensive matter report
 */
router.get('/:caseId/full-report', requireAuth, async (req: Request, res: Response) => {
  try {
    const { caseId } = req.params;
    const userId = (req as any).user.id;
    const tenantId = await getUserTenantId(userId);

    if (!tenantId) return res.status(403).json({ error: 'No tenant found' });
    if (!(await verifyCaseAccess(tenantId, caseId))) {
      return res.status(403).json({ error: 'Access denied to this matter' });
    }

    const openaiApiKey = config.openai.apiKey;

    const fullReportCacheKey = analysisCacheKey(caseId, 'full-report');
    const cachedReport = backendCache.get<any>(fullReportCacheKey);
    if (cachedReport) return res.json(cachedReport);

    // Run all engines in parallel
    const [compliance, riskMatrix, timeline, conflicts] = await Promise.all([
      analyzeObligationCompliance(caseId, tenantId),
      buildRiskMatrix(caseId, tenantId),
      analyzeTimeline(caseId, tenantId),
      openaiApiKey ? detectConflicts(caseId, tenantId, openaiApiKey) : null,
    ]);

    // Log audit
    await supabaseAdmin.from('audit_logs').insert({
      tenant_id: tenantId,
      user_id: userId,
      action: 'full_analysis_report',
      resource_type: 'case',
      resource_id: caseId,
      details: {
        risk_score: riskMatrix.risk_score,
        total_risks: riskMatrix.total_risks,
        overdue_obligations: compliance.summary.overdue,
        conflicts_found: conflicts?.conflicts.length || 0,
        timeline_events: timeline.events.length,
      },
    });

    const fullReport = {
      matter_id: caseId,
      generated_at: new Date().toISOString(),
      compliance,
      risk_matrix: riskMatrix,
      timeline,
      conflicts: conflicts || { conflicts: [], total_documents_analyzed: 0, analysis_timestamp: new Date().toISOString() },
    };
    backendCache.set(fullReportCacheKey, fullReport, CACHE_TTLS.ANALYTICAL_ENGINE);
    res.json(fullReport);
  } catch (err: any) {
    console.error('Full report error:', err);
    res.status(500).json({ error: 'Full report generation failed' });
  }
});

/**
 * GET /api/analysis/:caseId/cross-references
 * Fetch cross-document references for a matter
 */
router.get('/:caseId/cross-references', requireAuth, async (req: Request, res: Response) => {
  try {
    const { caseId } = req.params;
    const userId = (req as any).user.id;
    const tenantId = await getUserTenantId(userId);

    if (!tenantId) return res.status(403).json({ error: 'No tenant found' });
    if (!(await verifyCaseAccess(tenantId, caseId))) {
      return res.status(403).json({ error: 'No access to this matter' });
    }

    const { data, error } = await supabaseAdmin
      .from('matter_cross_references')
      .select('id, reference_type, source_file_id, target_file_id, description, confidence, created_at')
      .eq('case_id', caseId)
      .eq('tenant_id', tenantId)
      .order('confidence', { ascending: false })
      .limit(50);

    if (error) throw error;

    // Collect unique file IDs for name resolution
    const fileIds = new Set<string>();
    for (const ref of data || []) {
      if (ref.source_file_id) fileIds.add(ref.source_file_id);
      if (ref.target_file_id) fileIds.add(ref.target_file_id);
    }

    let fileNameMap: Record<string, string> = {};
    if (fileIds.size > 0) {
      const { data: files } = await supabaseAdmin
        .from('case_files')
        .select('id, file_name')
        .in('id', [...fileIds]);
      if (files) {
        fileNameMap = Object.fromEntries(files.map(f => [f.id, f.file_name]));
      }
    }

    const enriched = (data || []).map(ref => ({
      ...ref,
      source_file_name: fileNameMap[ref.source_file_id] || ref.source_file_id,
      target_file_name: fileNameMap[ref.target_file_id] || ref.target_file_id,
    }));

    res.json({ cross_references: enriched, count: enriched.length });
  } catch (err: any) {
    console.error('Cross-references error:', err);
    res.status(500).json({ error: 'Failed to fetch cross-references' });
  }
});

export default router;
