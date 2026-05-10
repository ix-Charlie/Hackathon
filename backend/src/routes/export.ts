/**
 * Export Routes — Word (DOCX) and PDF document generation endpoints
 */

import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { isValidUUID } from '../middleware/security.js';
import {
  generateWordDocument,
  generatePdfDocument,
  parseMarkdownToSections,
  ExportPayload,
} from '../services/exportService.js';

const router = Router();

// UUID validation
router.param('caseId', (req, res, next, value) => {
  if (!isValidUUID(value)) {
    return res.status(400).json({ error: 'Invalid caseId: must be a valid UUID' });
  }
  next();
});

/**
 * Auth is handled by the outer middleware (subRequireAuth in app.ts).
 * These routes have access to (req as any).user and (req as any).tenantId.
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

// ── POST /api/export/word — Generic Word export from ExportPayload ──

router.post('/word', async (req: Request, res: Response) => {
  try {
    const payload: ExportPayload = req.body;
    if (!payload?.title || !payload?.sections) {
      return res.status(400).json({ error: 'Missing title or sections in payload' });
    }
    if (!payload.metadata?.date) {
      payload.metadata = { ...payload.metadata, date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) };
    }

    const buffer = await generateWordDocument(payload);
    const filename = `${payload.title.replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 60)}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('Word export error:', err);
    res.status(500).json({ error: 'Failed to generate Word document' });
  }
});

// ── POST /api/export/pdf — Generic PDF export from ExportPayload ──

router.post('/pdf', async (req: Request, res: Response) => {
  try {
    const payload: ExportPayload = req.body;
    if (!payload?.title || !payload?.sections) {
      return res.status(400).json({ error: 'Missing title or sections in payload' });
    }
    if (!payload.metadata?.date) {
      payload.metadata = { ...payload.metadata, date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) };
    }

    const buffer = await generatePdfDocument(payload);
    const filename = `${payload.title.replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 60)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('PDF export error:', err);
    res.status(500).json({ error: 'Failed to generate PDF document' });
  }
});

// ── POST /api/export/chat — Export chat markdown as Word or PDF ──

router.post('/chat', async (req: Request, res: Response) => {
  try {
    const { markdown, format, title, matter, caseNumber } = req.body;
    if (!markdown || !format) {
      return res.status(400).json({ error: 'Missing markdown or format (word | pdf)' });
    }
    if (format !== 'word' && format !== 'pdf') {
      return res.status(400).json({ error: 'format must be "word" or "pdf"' });
    }

    const sections = parseMarkdownToSections(markdown);
    const payload: ExportPayload = {
      title: title || 'Chat Export',
      sections,
      metadata: {
        matter: matter || undefined,
        caseNumber: caseNumber || undefined,
        date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      },
    };

    if (format === 'word') {
      const buffer = await generateWordDocument(payload);
      const filename = `${(title || 'Chat Export').replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 60)}.docx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(buffer);
    }

    const buffer = await generatePdfDocument(payload);
    const filename = `${(title || 'Chat Export').replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 60)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('Chat export error:', err);
    res.status(500).json({ error: 'Failed to export chat' });
  }
});

// ── POST /api/export/intelligence/:caseId — Export intelligence dashboard data ──

router.post('/intelligence/:caseId', async (req: Request, res: Response) => {
  try {
    const { caseId } = req.params;
    const tenantId = (req as any).tenantId;
    const { format } = req.body;

    if (!format || (format !== 'word' && format !== 'pdf')) {
      return res.status(400).json({ error: 'format must be "word" or "pdf"' });
    }
    if (!(await verifyCaseAccess(tenantId, caseId))) {
      return res.status(403).json({ error: 'Access denied to this matter' });
    }

    // Fetch case info
    const { data: caseData } = await supabaseAdmin
      .from('cases')
      .select('name, client_name, case_number, description')
      .eq('id', caseId)
      .single();

    // Fetch intelligence data
    const [entitiesRes, obligationsRes, risksRes, datesRes] = await Promise.all([
      supabaseAdmin.from('matter_entities').select('*').eq('case_id', caseId).order('confidence', { ascending: false }),
      supabaseAdmin.from('matter_obligations').select('*').eq('case_id', caseId).order('due_date', { ascending: true }),
      supabaseAdmin.from('matter_risks').select('*').eq('case_id', caseId).order('severity', { ascending: false }),
      supabaseAdmin.from('matter_dates').select('*').eq('case_id', caseId).order('date', { ascending: true }),
    ]);

    const sections: ExportPayload['sections'] = [];

    // Entities section
    if (entitiesRes.data?.length) {
      sections.push({ heading: 'Key Entities', content: '', type: 'heading' });
      const header = '| Name | Type | Role | Confidence | Source |';
      const rows = entitiesRes.data.map(e =>
        `| ${e.name || '—'} | ${e.entity_type || '—'} | ${e.role || '—'} | ${e.confidence || '—'} | ${e.source_document || '—'} |`
      );
      sections.push({ content: [header, ...rows].join('\n'), type: 'table' });
    }

    // Obligations section
    if (obligationsRes.data?.length) {
      sections.push({ heading: 'Obligations', content: '', type: 'heading' });
      const header = '| Obligation | Responsible Party | Due Date | Status | Source |';
      const rows = obligationsRes.data.map(o =>
        `| ${o.description || '—'} | ${o.responsible_party || '—'} | ${o.due_date || '—'} | ${o.status || '—'} | ${o.source_document || '—'} |`
      );
      sections.push({ content: [header, ...rows].join('\n'), type: 'table' });
    }

    // Risks section
    if (risksRes.data?.length) {
      sections.push({ heading: 'Risk Assessment', content: '', type: 'heading' });
      const header = '| Risk | Category | Severity | Mitigation | Source |';
      const rows = risksRes.data.map(r =>
        `| ${r.description || '—'} | ${r.category || '—'} | ${r.severity || '—'} | ${r.mitigation || '—'} | ${r.source_document || '—'} |`
      );
      sections.push({ content: [header, ...rows].join('\n'), type: 'table' });
    }

    // Dates section
    if (datesRes.data?.length) {
      sections.push({ heading: 'Key Dates & Deadlines', content: '', type: 'heading' });
      const header = '| Date | Event | Type | Source |';
      const rows = datesRes.data.map(d =>
        `| ${d.date || '—'} | ${d.description || '—'} | ${d.date_type || '—'} | ${d.source_document || '—'} |`
      );
      sections.push({ content: [header, ...rows].join('\n'), type: 'table' });
    }

    if (sections.length === 0) {
      sections.push({ content: 'No intelligence data available for this matter.', type: 'text' });
    }

    const payload: ExportPayload = {
      title: `Intelligence Report: ${caseData?.name || 'Unknown Matter'}`,
      subtitle: caseData?.description || undefined,
      sections,
      metadata: {
        matter: caseData?.name,
        caseNumber: caseData?.case_number || undefined,
        date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      },
    };

    if (format === 'word') {
      const buffer = await generateWordDocument(payload);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="Intelligence Report.docx"`);
      return res.send(buffer);
    }

    const buffer = await generatePdfDocument(payload);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Intelligence Report.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('Intelligence export error:', err);
    res.status(500).json({ error: 'Failed to export intelligence report' });
  }
});

export default router;
