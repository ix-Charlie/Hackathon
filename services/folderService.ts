import { supabase } from './supabaseClient';
import { Folder } from '../types';
import { getUserTenantId } from './tenantUtils';

export { getUserTenantId };

/**
 * Fetch all folders for the current user's tenant
 */
export async function fetchFolders(): Promise<Folder[]> {
  const tenantId = await getUserTenantId();
  
  if (!tenantId) {
    console.error('No tenant found for user');
    return [];
  }

  const { data, error } = await supabase
    .from('folders')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching folders:', error);
    return [];
  }

  return data || [];
}

/**
 * Fetch folders for a specific case
 */
export async function fetchFoldersByCase(caseId: string): Promise<Folder[]> {
  const tenantId = await getUserTenantId();
  
  if (!tenantId) {
    console.error('No tenant found for user');
    return [];
  }

  const { data, error } = await supabase
    .from('folders')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('case_id', caseId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching folders:', error);
    return [];
  }

  return data || [];
}

/**
 * Create a new folder
 */
export async function createFolder(folderData: {
  name: string;
  case_id: string;
  parent_folder_id?: string;
  folder_type?: string;
  description?: string;
}): Promise<Folder | null> {
  const tenantId = await getUserTenantId();
  
  if (!tenantId) {
    console.error('No tenant found for user');
    return null;
  }

  const { data: { user } } = await supabase.auth.getUser();

  console.log('Creating folder with:', {
    tenant_id: tenantId,
    name: folderData.name,
    case_id: folderData.case_id,
    parent_folder_id: folderData.parent_folder_id,
    created_by: user?.id,
  });

  const { data, error } = await supabase
    .from('folders')
    .insert({
      tenant_id: tenantId,
      name: folderData.name,
      case_id: folderData.case_id,
      parent_folder_id: folderData.parent_folder_id || null,
      folder_type: folderData.folder_type || null,
      description: folderData.description || null,
      created_by: user?.id,
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating folder:', error.message, error.details, error.hint, error.code);
    return null;
  }

  console.log('Folder created successfully:', data);
  return data;
}

/**
 * Create multiple folders at once (for bulk folder upload)
 */
export async function createFoldersBulk(foldersData: {
  name: string;
  case_id: string;
  parent_folder_id?: string;
  folder_type?: string;
  description?: string;
  temp_id?: string; // For mapping old IDs to new IDs
}[]): Promise<Map<string, Folder>> {
  const tenantId = await getUserTenantId();
  const resultMap = new Map<string, Folder>();
  
  if (!tenantId) {
    console.error('No tenant found for user');
    return resultMap;
  }

  const { data: { user } } = await supabase.auth.getUser();

  // Create folders one by one to maintain hierarchy
  // (parent folders must exist before children)
  for (const folderData of foldersData) {
    const { data, error } = await supabase
      .from('folders')
      .insert({
        tenant_id: tenantId,
        name: folderData.name,
        case_id: folderData.case_id,
        parent_folder_id: folderData.parent_folder_id || null,
        folder_type: folderData.folder_type || null,
        description: folderData.description || null,
        created_by: user?.id,
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating folder:', error.message);
    } else if (data && folderData.temp_id) {
      resultMap.set(folderData.temp_id, data);
    }
  }

  return resultMap;
}

/**
 * Update a folder
 */
export async function updateFolder(
  folderId: string,
  updates: {
    name?: string;
    folder_type?: string;
    description?: string;
  }
): Promise<Folder | null> {
  const tenantId = await getUserTenantId();
  
  if (!tenantId) {
    console.error('No tenant found for user');
    return null;
  }

  const { data, error } = await supabase
    .from('folders')
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq('id', folderId)
    .eq('tenant_id', tenantId)
    .select()
    .single();

  if (error) {
    console.error('Error updating folder:', error);
    return null;
  }

  return data;
}

/**
 * Delete a folder
 */
export async function deleteFolder(folderId: string): Promise<boolean> {
  const tenantId = await getUserTenantId();
  
  if (!tenantId) {
    console.error('No tenant found for user');
    return false;
  }

  const { data, error } = await supabase
    .from('folders')
    .delete()
    .select('id')
    .eq('id', folderId)
    .eq('tenant_id', tenantId);

  if (error) {
    console.error('Error deleting folder:', error);
    return false;
  }

  if (!data || data.length === 0) {
    console.warn('[folderService.deleteFolder] No folder rows deleted:', { folderId, tenantId });
    return false;
  }

  return true;
}

/**
 * Delete all folders for a case
 */
export async function deleteFoldersByCase(caseId: string): Promise<boolean> {
  const tenantId = await getUserTenantId();
  
  if (!tenantId) {
    console.error('No tenant found for user');
    return false;
  }

  const { error } = await supabase
    .from('folders')
    .delete()
    .eq('case_id', caseId)
    .eq('tenant_id', tenantId);

  if (error) {
    console.error('Error deleting folders:', error);
    return false;
  }

  return true;
}

/**
 * Get a folder by ID
 */
export async function getFolderById(folderId: string): Promise<Folder | null> {
  const tenantId = await getUserTenantId();
  
  if (!tenantId) {
    console.error('No tenant found for user');
    return null;
  }

  const { data, error } = await supabase
    .from('folders')
    .select('*')
    .eq('id', folderId)
    .eq('tenant_id', tenantId)
    .single();

  if (error) {
    console.error('Error fetching folder:', error);
    return null;
  }

  return data;
}
