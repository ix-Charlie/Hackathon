/**
 * Frontend Artifact Service — CRUD operations for legal work products
 */

import { BACKEND_API_URL } from './config';
import { supabase } from './supabaseClient';
import type { Artifact, ArtifactDocumentType, ArtifactMetadata } from '../types';

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
 * List artifacts, optionally filtered by session or case.
 */
export async function listArtifacts(options?: {
  session_id?: string;
  case_id?: string;
  limit?: number;
}): Promise<Artifact[]> {
  const headers = await getAuthHeaders();
  const params = new URLSearchParams();
  if (options?.session_id) params.set('session_id', options.session_id);
  if (options?.case_id) params.set('case_id', options.case_id);
  if (options?.limit) params.set('limit', String(options.limit));

  const res = await fetch(`${BACKEND_API_URL}/api/artifacts?${params}`, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to list artifacts');
  }
  const data = await res.json();
  return data.artifacts.map(mapDbArtifact);
}

/**
 * Get a single artifact by ID with full content.
 */
export async function getArtifact(artifactId: string): Promise<Artifact> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BACKEND_API_URL}/api/artifacts/${artifactId}`, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Artifact not found');
  }
  const data = await res.json();
  return mapDbArtifact(data.artifact);
}

/**
 * Create a new artifact.
 */
export async function createArtifact(params: {
  title: string;
  document_type: ArtifactDocumentType;
  content: string;
  format?: 'markdown' | 'html';
  metadata?: ArtifactMetadata;
  session_id?: string;
  case_id?: string;
  message_id?: string;
}): Promise<Artifact> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BACKEND_API_URL}/api/artifacts`, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to create artifact');
  }
  const data = await res.json();
  return mapDbArtifact(data.artifact);
}

/**
 * Update an existing artifact.
 */
export async function updateArtifact(
  artifactId: string,
  updates: { title?: string; content?: string; metadata?: ArtifactMetadata }
): Promise<Artifact> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BACKEND_API_URL}/api/artifacts/${artifactId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to update artifact');
  }
  const data = await res.json();
  return mapDbArtifact(data.artifact);
}

/**
 * Delete an artifact.
 */
export async function deleteArtifact(artifactId: string): Promise<void> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BACKEND_API_URL}/api/artifacts/${artifactId}`, {
    method: 'DELETE',
    headers,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to delete artifact');
  }
}

/**
 * Export an artifact as Word or PDF. This exports the artifact content,
 * NOT chat messages — ensuring professional legal document output.
 */
export async function exportArtifact(
  artifactId: string,
  format: 'word' | 'pdf'
): Promise<void> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BACKEND_API_URL}/api/artifacts/${artifactId}/export`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ format }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to export artifact');
  }

  const blob = await res.blob();
  const ext = format === 'word' ? 'docx' : 'pdf';
  // Extract filename from Content-Disposition header if available
  const disposition = res.headers.get('Content-Disposition');
  let filename = `Document.${ext}`;
  if (disposition) {
    const match = disposition.match(/filename="([^"]+)"/);
    if (match) filename = match[1];
  }
  triggerDownload(blob, filename);
}

/** Map DB row to frontend Artifact type */
function mapDbArtifact(row: any): Artifact {
  return {
    id: row.id,
    title: row.title,
    type: row.document_type,
    format: row.format,
    content: row.content || '',
    metadata: row.metadata || {},
    session_id: row.session_id || undefined,
    case_id: row.case_id || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
