import { supabase } from './supabaseClient';
import { Case, MatterType } from '../types';
import { getUserTenantId } from './tenantUtils';

export { getUserTenantId };

/**
 * Fetch all cases for the current user's tenant
 */
export async function fetchCases(): Promise<Case[]> {
  const tenantId = await getUserTenantId();
  
  if (!tenantId) {
    console.error('No tenant found for user');
    return [];
  }

  const { data, error } = await supabase
    .from('cases')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching cases:', error);
    return [];
  }

  return data || [];
}

/**
 * Create a new case (Matter in UI)
 */
export async function createCase(caseData: {
  name: string;
  case_number?: string;
  client_name?: string;
  description?: string;
  matter_type?: MatterType;
}): Promise<Case | null> {
  const tenantId = await getUserTenantId();
  
  if (!tenantId) {
    console.error('No tenant found for user');
    return null;
  }

  const { data: { user } } = await supabase.auth.getUser();

  console.log('Creating case with:', {
    tenant_id: tenantId,
    name: caseData.name,
    matter_type: caseData.matter_type,
    created_by: user?.id,
  });

  const { data, error } = await supabase
    .from('cases')
    .insert({
      tenant_id: tenantId,
      name: caseData.name,
      case_number: caseData.case_number || null,
      client_name: caseData.client_name || null,
      description: caseData.description || null,
      matter_type: caseData.matter_type || 'other',
      status: 'active',
      created_by: user?.id,
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating case:', error.message, error.details, error.hint, error.code);
    return null;
  }

  console.log('Case created successfully:', data);
  return data;
}

/**
 * Update a case/matter (e.g., rename, change type/status)
 */
export async function updateCase(
  caseId: string,
  updates: Partial<Pick<Case, 'name' | 'case_number' | 'client_name' | 'description' | 'status' | 'matter_type' | 'archived_at'>>
): Promise<Case | null> {
  const tenantId = await getUserTenantId();
  
  if (!tenantId) {
    console.error('No tenant found for user');
    return null;
  }

  const { data, error } = await supabase
    .from('cases')
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq('id', caseId)
    .eq('tenant_id', tenantId) // Security: ensure user owns this case
    .select()
    .single();

  if (error) {
    console.error('Error updating case:', error);
    return null;
  }

  return data;
}

/**
 * Delete a case (also deletes all folders and files inside via cascade or manual)
 */
export async function deleteCase(caseId: string): Promise<boolean> {
  const tenantId = await getUserTenantId();
  
  if (!tenantId) {
    console.error('No tenant found for user');
    return false;
  }

  const { data, error } = await supabase
    .from('cases')
    .delete()
    .select('id')
    .eq('id', caseId)
    .eq('tenant_id', tenantId); // Security: ensure user owns this case

  if (error) {
    console.error('Error deleting case:', error);
    return false;
  }

  if (!data || data.length === 0) {
    console.warn('[caseService.deleteCase] No case rows deleted:', { caseId, tenantId });
    return false;
  }

  return true;
}

/**
 * Get a single case by ID
 */
export async function getCaseById(caseId: string): Promise<Case | null> {
  const tenantId = await getUserTenantId();
  
  if (!tenantId) {
    console.error('No tenant found for user');
    return null;
  }

  const { data, error } = await supabase
    .from('cases')
    .select('*')
    .eq('id', caseId)
    .eq('tenant_id', tenantId)
    .single();

  if (error) {
    console.error('Error fetching case:', error);
    return null;
  }

  return data;
}

/**
 * Close a matter (sets status to 'closed', makes it read-only for uploads/edits)
 */
export async function closeCase(caseId: string): Promise<Case | null> {
  return updateCase(caseId, { status: 'closed' });
}

/**
 * Archive a matter (sets status to 'archived' and archived_at timestamp)
 */
export async function archiveCase(caseId: string): Promise<Case | null> {
  const tenantId = await getUserTenantId();
  if (!tenantId) return null;

  const { data, error } = await supabase
    .from('cases')
    .update({
      status: 'archived',
      archived_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', caseId)
    .eq('tenant_id', tenantId)
    .select()
    .single();

  if (error) {
    console.error('Error archiving case:', error);
    return null;
  }
  return data;
}

/**
 * Reopen a matter (sets status back to 'active', clears archived_at)
 */
export async function reopenCase(caseId: string): Promise<Case | null> {
  const tenantId = await getUserTenantId();
  if (!tenantId) return null;

  const { data, error } = await supabase
    .from('cases')
    .update({
      status: 'active',
      archived_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', caseId)
    .eq('tenant_id', tenantId)
    .select()
    .single();

  if (error) {
    console.error('Error reopening case:', error);
    return null;
  }
  return data;
}
