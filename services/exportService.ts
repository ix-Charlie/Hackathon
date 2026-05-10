/**
 * Frontend Export Service — triggers Word/PDF downloads via the backend export API
 */

import { BACKEND_API_URL } from './config';
import { supabase } from './supabaseClient';

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Not authenticated');
  return {
    'Authorization': `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  };
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Export a chat response (markdown) as Word or PDF.
 */
export async function exportChat(
  markdown: string,
  format: 'word' | 'pdf',
  options?: { title?: string; matter?: string; caseNumber?: string }
): Promise<void> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BACKEND_API_URL}/api/export/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      markdown,
      format,
      title: options?.title || 'Chat Export',
      matter: options?.matter,
      caseNumber: options?.caseNumber,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Export failed' }));
    throw new Error(err.error || 'Export failed');
  }

  const blob = await res.blob();
  const ext = format === 'word' ? 'docx' : 'pdf';
  const filename = `${(options?.title || 'Chat Export').replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 60)}.${ext}`;
  triggerDownload(blob, filename);
}

/**
 * Export intelligence dashboard data for a case as Word or PDF.
 */
export async function exportIntelligence(
  caseId: string,
  format: 'word' | 'pdf'
): Promise<void> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BACKEND_API_URL}/api/export/intelligence/${encodeURIComponent(caseId)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ format }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Export failed' }));
    throw new Error(err.error || 'Export failed');
  }

  const blob = await res.blob();
  const ext = format === 'word' ? 'docx' : 'pdf';
  triggerDownload(blob, `Intelligence Report.${ext}`);
}

/**
 * Export a generic ExportPayload as Word or PDF.
 */
export async function exportDocument(
  payload: {
    title: string;
    subtitle?: string;
    sections: Array<{ heading?: string; content: string; type: 'text' | 'table' | 'list' | 'heading' }>;
    metadata: { matter?: string; date: string; author?: string; caseNumber?: string };
  },
  format: 'word' | 'pdf'
): Promise<void> {
  const headers = await getAuthHeaders();
  const endpoint = format === 'word' ? 'word' : 'pdf';
  const res = await fetch(`${BACKEND_API_URL}/api/export/${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Export failed' }));
    throw new Error(err.error || 'Export failed');
  }

  const blob = await res.blob();
  const ext = format === 'word' ? 'docx' : 'pdf';
  const filename = `${payload.title.replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 60)}.${ext}`;
  triggerDownload(blob, filename);
}
