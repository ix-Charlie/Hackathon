import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Case, Folder, UploadedFile, MatterType } from '../types';
import { supabase } from '../services/supabaseClient';
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES, MATTER_TYPES, MATTER_STATUSES, MATTER_DEFAULT_FOLDERS, getMatterTypeConfig, getMatterStatusConfig } from '../constants';
import * as caseService from '../services/caseService';
import * as folderService from '../services/folderService';
import * as fileService from '../services/fileService';
import { cleanupCaseIntelligence } from '../services/fileService';
import { useData } from '../contexts/DataContext';
import { useMatter } from '../contexts/MatterContext';
import EditMatterDrawer from './EditMatterDrawer';

interface VaultProps {
  files: UploadedFile[];
  onFilesSelected: (files: File[], caseId?: string, folderId?: string) => void;
  onRemoveFile: (id: string) => void;
  isProcessing: boolean;
  onNavigateToChat?: () => void;
}

type VaultView = 'cases' | 'folders' | 'files';

const Vault: React.FC<VaultProps> = ({ files, onFilesSelected, onRemoveFile, isProcessing, onNavigateToChat }) => {
  // Matter context for setting active matter from cards
  const { setActiveMatter } = useMatter();

  // Get data from global context (cached + background refreshed)
  const { 
    cases, 
    folders, 
    files: dbFiles,
    isLoadingCases,
    isLoadingFolders,
    isLoadingFiles,
    isInitialLoad,
    isSyncingCases,
    isSyncingFolders,
    isSyncingFiles,
    refreshCases,
    refreshFolders,
    refreshFiles,
    addCase,
    updateCase,
    removeCase: removeCaseFromContext,
    addFolder,
    updateFolder,
    removeFolder: removeFolderFromContext,
    addFile,
    removeFile: removeFileFromContext,
  } = useData();

  // Navigation state with persistence
  const [currentView, setCurrentView] = useState<VaultView>(() => {
    const saved = localStorage.getItem('vault_current_view');
    return (saved as VaultView) || 'cases';
  });
  const [homeTab, setHomeTab] = useState<'matters' | 'files'>(() => {
    const saved = localStorage.getItem('vault_home_tab');
    return (saved as 'matters' | 'files') || 'matters';
  });
  const [contentTab, setContentTab] = useState<'folders' | 'files'>(() => {
    const saved = localStorage.getItem('vault_content_tab');
    return (saved as 'folders' | 'files') || 'folders';
  });
  const [currentMatter, setCurrentMatter] = useState<Case | null>(() => {
    const saved = localStorage.getItem('vault_current_matter_id');
    if (!saved) return null;
    // Will be resolved after cases load
    return { id: saved } as Case;
  });
  const [currentFolder, setCurrentFolder] = useState<Folder | null>(() => {
    const saved = localStorage.getItem('vault_current_folder_id');
    if (!saved) return null;
    // Will be resolved after folders load
    return { id: saved } as Folder;
  });
  const [slideDirection, setSlideDirection] = useState<'left' | 'right'>('left');
  const [navKey, setNavKey] = useState(0);

  // Derive loading states from context
  const isLoading = isLoadingCases;
  const isLoadingFilesState = isLoadingFiles;
  const isSyncingFilesState = isSyncingFiles;
  
  // Overall syncing indicator
  const isSyncing = isSyncingCases || isSyncingFolders || isSyncingFiles;
  
  // Handle manual sync
  const handleSync = async () => {
    await Promise.all([
      refreshCases(true),
      refreshFolders(true),
      refreshFiles(true),
    ]);
  };
  
  // Auto-sync on mount (check cache, refresh if stale)
  useEffect(() => {
    refreshCases(false);
    refreshFolders(false);
    refreshFiles(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Read-only enforcement for closed/archived matters
  const matterIsReadOnly = currentMatter?.status === 'closed' || currentMatter?.status === 'archived';

  // Modal state
  const [showCreateMatterModal, setShowCreateMatterModal] = useState(false);
  const [showCreateFolderModal, setShowCreateFolderModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showEditDrawer, setShowEditDrawer] = useState(false);

  // Form state for matter creation
  const [newMatterName, setNewMatterName] = useState('');
  const [newMatterClientName, setNewMatterClientName] = useState('');
  const [newMatterType, setNewMatterType] = useState<MatterType | ''>('');
  const [newMatterDescription, setNewMatterDescription] = useState('');
  const [matterFormErrors, setMatterFormErrors] = useState<{ name?: string; type?: string }>({});
  const [duplicateNameWarning, setDuplicateNameWarning] = useState(false);

  // Form state for folder creation
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderType, setNewFolderType] = useState('');
  const [newFolderDescription, setNewFolderDescription] = useState('');

  // Upload state
  const [selectedMatter, setSelectedMatter] = useState<string>('');
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [showInlineMatterCreate, setShowInlineMatterCreate] = useState(false);
  const [showInlineFolderCreate, setShowInlineFolderCreate] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Edit state
  const [editingMatterId, setEditingMatterId] = useState<string | null>(null);
  const [editingMatterName, setEditingMatterName] = useState('');
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingFolderName, setEditingFolderName] = useState('');

  // Folder menu state
  const [openFolderMenuId, setOpenFolderMenuId] = useState<string | null>(null);

  // Delete confirmation state
  const [deleteConfirmMatter, setDeleteConfirmMatter] = useState<Case | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  // Multi-select and move state
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set());
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [moveTargetMatterId, setMoveTargetMatterId] = useState<string>('');
  const [moveTargetFolderId, setMoveTargetFolderId] = useState<string | null>(null);
  const [expandedMoveMatters, setExpandedMoveMatters] = useState<Set<string>>(new Set());
  const [isMoving, setIsMoving] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);

  // Filter state for Matters page
  const [filterType, setFilterType] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [expandedMobileFileIds, setExpandedMobileFileIds] = useState<Set<string>>(new Set());

  // Upload/Delete progress state (Optimistic UI)
  const [uploadingFolderIds, setUploadingFolderIds] = useState<Set<string>>(new Set());
  const [isUploading, setIsUploading] = useState(false);
  const [isCreatingMatter, setIsCreatingMatter] = useState(false);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  
  // Auto-upload trigger for folder uploads
  const [shouldAutoUpload, setShouldAutoUpload] = useState(false);
  const [deletingFolderIds, setDeletingFolderIds] = useState<Set<string>>(new Set());
  const [deletingMatterIds, setDeletingMatterIds] = useState<Set<string>>(new Set());
  
  // Toast notifications
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  const [error, setError] = useState<string | null>(null);

  // Auto-hide toast after 3 seconds
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // Auto-upload folders when files are selected and flag is set
  useEffect(() => {
    if (shouldAutoUpload && uploadFiles.length > 0 && selectedMatter && !isUploading) {
      setShouldAutoUpload(false); // Reset flag
      handleUploadSubmit();
    }
  }, [shouldAutoUpload, uploadFiles, selectedMatter, isUploading]);

  // Persist navigation state to localStorage
  useEffect(() => {
    localStorage.setItem('vault_current_view', currentView);
  }, [currentView]);

  useEffect(() => {
    localStorage.setItem('vault_home_tab', homeTab);
  }, [homeTab]);

  useEffect(() => {
    localStorage.setItem('vault_content_tab', contentTab);
  }, [contentTab]);

  useEffect(() => {
    if (currentMatter) {
      localStorage.setItem('vault_current_matter_id', currentMatter.id);
    } else {
      localStorage.removeItem('vault_current_matter_id');
    }
  }, [currentMatter]);

  useEffect(() => {
    if (currentFolder) {
      localStorage.setItem('vault_current_folder_id', currentFolder.id);
    } else {
      localStorage.removeItem('vault_current_folder_id');
    }
  }, [currentFolder]);

  // Resolve currentMatter and currentFolder from IDs once data loads
  useEffect(() => {
    // Skip if no data loaded yet, or if currentMatter is already resolved
    if (isLoadingCases || !currentMatter || currentMatter.name) return;
    
    const matter = cases.find(c => c.id === currentMatter.id);
    if (matter) {
      setCurrentMatter(matter);
    } else if (cases.length > 0) {
      // Data is loaded but matter not found - clear it
      setCurrentMatter(null);
      setCurrentView('cases');
    }
  }, [cases, isLoadingCases, currentMatter]);

  useEffect(() => {
    // Skip if no data loaded yet, or if currentFolder is already resolved
    if (isLoadingFolders || !currentFolder || currentFolder.name) return;
    
    const folder = folders.find(f => f.id === currentFolder.id);
    if (folder) {
      setCurrentFolder(folder);
    } else if (folders.length > 0) {
      // Data is loaded but folder not found - clear it
      setCurrentFolder(null);
    }
  }, [folders, isLoadingFolders, currentFolder]);

  // Data is now loaded via DataContext - no need for local loading logic

  const handleMatterClick = (caseItem: Case) => {
    setSlideDirection('left');
    setNavKey(k => k + 1);
    setCurrentMatter(caseItem);
    setCurrentFolder(null);
    setContentTab('folders');
    setCurrentView('files');
  };

  const handleFolderClick = (folder: Folder) => {
    setSlideDirection('left');
    setNavKey(k => k + 1);
    setCurrentFolder(folder);
    setContentTab('folders');
    setCurrentView('files');
  };

  const handleBackClick = () => {
    setSlideDirection('right');
    setNavKey(k => k + 1);
    if (currentView === 'files' && currentFolder) {
      setCurrentFolder(null);
    } else if (currentView === 'files' && currentMatter) {
      setCurrentMatter(null);
      setCurrentView('cases');
    } else {
      setCurrentMatter(null);
      setCurrentFolder(null);
      setCurrentView('cases');
    }
  };

  const handleBreadcrumbClick = (level: 'home' | 'case') => {
    setSlideDirection('right');
    setNavKey(k => k + 1);
    if (level === 'home') {
      setCurrentMatter(null);
      setCurrentFolder(null);
      setCurrentView('cases');
    } else if (level === 'case' && currentMatter) {
      setCurrentFolder(null);
    }
  };

  const handleCreateMatter = async () => {
    // Validate required fields
    const errors: { name?: string; type?: string } = {};
    if (!newMatterName.trim()) errors.name = 'Matter name is required';
    if (!newMatterType) errors.type = 'Matter type is required';
    if (Object.keys(errors).length > 0) {
      setMatterFormErrors(errors);
      return;
    }
    setMatterFormErrors({});

    // Prevent duplicate clicks
    if (isCreatingMatter) return;

    setIsCreatingMatter(true);
    
    // Capture values before clearing
    const matterName = newMatterName;
    const clientName = newMatterClientName;
    const matterType = newMatterType as MatterType;
    const description = newMatterDescription;
    const wasInlineCreate = showInlineMatterCreate;
    
    // Close modal immediately for better UX
    setNewMatterName('');
    setNewMatterClientName('');
    setNewMatterType('');
    setNewMatterDescription('');
    setMatterFormErrors({});
    setDuplicateNameWarning(false);
    setShowCreateMatterModal(false);
    setShowInlineMatterCreate(false);
    
    setToast({ message: 'Creating matter...', type: 'info' });

    try {
      const newMatter = await caseService.createCase({
        name: matterName,
        client_name: clientName || undefined,
        description: description || undefined,
        matter_type: matterType,
      });

      if (newMatter) {
        // Optimistically add to context (also triggers background refresh)
        addCase(newMatter);
        setToast({ message: 'Matter created successfully', type: 'success' });

        // If creating inline (from upload modal), select the new matter
        if (wasInlineCreate) {
          setSelectedMatter(newMatter.id);
        } else {
          // Navigate into the new matter
          setSlideDirection('left');
          setNavKey(k => k + 1);
          setCurrentMatter(newMatter);
          setCurrentFolder(null);
          setContentTab('folders');
          setCurrentView('files');
        }

        // Auto-create default folders for this matter type
        const defaultFolders = MATTER_DEFAULT_FOLDERS[matterType] || [];
        for (const folderName of defaultFolders) {
          try {
            const folder = await folderService.createFolder({
              name: folderName,
              case_id: newMatter.id,
            });
            if (folder) addFolder(folder);
          } catch {
            // Non-critical — don't block on default folder creation
          }
        }
      } else {
        setToast({ message: 'Failed to create matter', type: 'error' });
      }
    } catch (err) {
      console.error('Error creating matter:', err);
      setToast({ message: 'Failed to create matter', type: 'error' });
    } finally {
      setIsCreatingMatter(false);
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) {
      setError('Folder name is required');
      return;
    }

    if (!currentMatter && !selectedMatter) {
      setError('Please select a matter first');
      return;
    }

    // Prevent duplicate clicks
    if (isCreatingFolder) {
      return;
    }

    const caseId = currentMatter?.id || selectedMatter;
    const folderName = newFolderName;
    const folderType = newFolderType;
    const folderDescription = newFolderDescription;
    const wasInlineCreate = showInlineFolderCreate;

    setIsCreatingFolder(true);
    
    // Close modal immediately
    setNewFolderName('');
    setNewFolderType('');
    setNewFolderDescription('');
    setShowCreateFolderModal(false);
    setShowInlineFolderCreate(false);
    
    setToast({ message: 'Creating folder...', type: 'info' });

    try {
      const newFolder = await folderService.createFolder({
        name: folderName,
        case_id: caseId,
        parent_folder_id: currentFolder?.id || undefined,
        folder_type: folderType || undefined,
        description: folderDescription || undefined,
      });

      if (newFolder) {
        // Optimistically add folder to context
        addFolder(newFolder);
        setToast({ message: 'Folder created successfully', type: 'success' });

        // If creating inline, select the new folder
        if (wasInlineCreate) {
          setSelectedFolder(newFolder.id);
        }
      } else {
        setToast({ message: 'Failed to create folder', type: 'error' });
      }
    } catch (err) {
      console.error('Error creating folder:', err);
      setToast({ message: 'Failed to create folder', type: 'error' });
    } finally {
      setIsCreatingFolder(false);
    }
  };

  const handleDeleteMatter = async (caseId: string, caseName: string) => {
    // Prevent deletion of General Documents case
    if (caseName === 'General Documents') {
      setError('Cannot delete the General Documents matter. It is required for uncategorized files.');
      return;
    }

    // Find the case and show confirmation dialog
    const caseToDelete = cases.find(c => c.id === caseId);
    if (caseToDelete) {
      setDeleteConfirmMatter(caseToDelete);
      setDeleteConfirmText('');
    }
  };

  const confirmDeleteMatter = async () => {
    if (!deleteConfirmMatter) return;
    
    if (deleteConfirmText !== 'DELETE') {
      setError('Please type DELETE to confirm');
      return;
    }

    const caseToDelete = deleteConfirmMatter;
    const caseFoldersToDelete = folders.filter(f => f.case_id === caseToDelete.id);
    
    // Optimistic UI: Remove from view immediately via context
    removeCaseFromContext(caseToDelete.id);
    caseFoldersToDelete.forEach(f => removeFolderFromContext(f.id));
    setDeletingMatterIds(prev => new Set([...prev, caseToDelete.id]));
    setDeleteConfirmMatter(null);
    setDeleteConfirmText('');
    setToast({ message: 'Deleting matter...', type: 'info' });

    try {
      // Delete files for this case first (also cleans per-file intelligence)
      const filesDeleted = await fileService.deleteFilesByCase(caseToDelete.id);
      if (!filesDeleted) {
        throw new Error('Failed to delete files for matter');
      }
      
      // Clean up case-level intelligence (canonical entities, summaries)
      await cleanupCaseIntelligence(caseToDelete.id);

      // Delete folders for this case
      const foldersDeleted = await folderService.deleteFoldersByCase(caseToDelete.id);
      if (!foldersDeleted) {
        throw new Error('Failed to delete folders for matter');
      }
      
      // Delete the case
      const success = await caseService.deleteCase(caseToDelete.id);
      
      if (success) {
        setToast({ message: 'Matter deleted', type: 'success' });
      } else {
        // Restore on failure
        addCase(caseToDelete);
        caseFoldersToDelete.forEach(f => addFolder(f));
        setToast({ message: 'Failed to delete matter', type: 'error' });
      }
    } catch (err) {
      console.error('Error deleting matter:', err);
      // Restore on error
      addCase(caseToDelete);
      caseFoldersToDelete.forEach(f => addFolder(f));
      setToast({ message: 'Failed to delete matter', type: 'error' });
    } finally {
      setDeletingMatterIds(prev => {
        const next = new Set(prev);
        next.delete(caseToDelete.id);
        return next;
      });
    }
  };

  const handleDeleteFolder = async (folderId: string) => {
    if (!confirm('Delete this folder? All files inside will be removed.')) return;

    // Optimistic UI: Remove from view immediately via context
    const folderToDelete = folders.find(f => f.id === folderId);
    removeFolderFromContext(folderId);
    setDeletingFolderIds(prev => new Set([...prev, folderId]));
    setToast({ message: 'Deleting folder...', type: 'info' });

    try {
      // Delete files in folder first
      await fileService.deleteFilesByFolder(folderId);
      
      // Delete the folder
      const success = await folderService.deleteFolder(folderId);
      if (success) {
        setToast({ message: 'Folder deleted', type: 'success' });
        // Refresh files to reflect deleted files
        refreshFiles(true);
      } else {
        // Restore folder on failure
        if (folderToDelete) {
          addFolder(folderToDelete);
        }
        setToast({ message: 'Failed to delete folder', type: 'error' });
      }
    } catch (err) {
      console.error('Error deleting folder:', err);
      // Restore folder on error
      if (folderToDelete) {
        addFolder(folderToDelete);
      }
      setToast({ message: 'Failed to delete folder', type: 'error' });
    } finally {
      setDeletingFolderIds(prev => {
        const next = new Set(prev);
        next.delete(folderId);
        return next;
      });
    }
  };

  // Unified file delete handler for all views
  const handleDeleteFileUnified = async (fileId: string) => {
    if (!confirm('Delete this file?')) return;

    // Optimistic UI: Remove from view immediately via context
    const fileToDelete = dbFiles.find(f => f.id === fileId);
    removeFileFromContext(fileId);
    setToast({ message: 'Deleting file...', type: 'info' });

    try {
      const success = await fileService.deleteFile(fileId);
      if (success) {
        setToast({ message: 'File deleted', type: 'success' });
        // Also remove from prop files (legacy)
        onRemoveFile(fileId);
      } else {
        // Restore file on failure
        if (fileToDelete) {
          addFile(fileToDelete);
        }
        setToast({ message: 'Failed to delete file', type: 'error' });
      }
    } catch (err) {
      console.error('Error deleting file:', err);
      // Restore file on error
      if (fileToDelete) {
        addFile(fileToDelete);
      }
      setToast({ message: 'Failed to delete file', type: 'error' });
    }
  };

  // Multi-select handlers
  const toggleFileSelection = (fileId: string) => {
    setSelectedFileIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(fileId)) {
        newSet.delete(fileId);
      } else {
        newSet.add(fileId);
      }
      return newSet;
    });
  };

  const toggleFolderSelection = (folderId: string) => {
    setSelectedFolderIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(folderId)) {
        newSet.delete(folderId);
      } else {
        newSet.add(folderId);
      }
      return newSet;
    });
  };

  const clearSelection = () => {
    setSelectedFileIds(new Set());
    setSelectedFolderIds(new Set());
    setSelectionMode(false);
  };

  // Move single file or folder — opens modal pre-seeded
  const openMoveForFile = (fileId: string) => {
    setSelectedFileIds(new Set([fileId]));
    setSelectedFolderIds(new Set());
    setMoveTargetMatterId('');
    setMoveTargetFolderId(null);
    setExpandedMoveMatters(new Set());
    setShowMoveModal(true);
  };

  const openMoveForFolder = (folderId: string) => {
    setSelectedFolderIds(new Set([folderId]));
    setSelectedFileIds(new Set());
    setMoveTargetMatterId('');
    setMoveTargetFolderId(null);
    setExpandedMoveMatters(new Set());
    setShowMoveModal(true);
  };

  const openMoveForSelection = () => {
    setMoveTargetMatterId('');
    setMoveTargetFolderId(null);
    setExpandedMoveMatters(new Set());
    setShowMoveModal(true);
  };

  const handleMoveItems = async () => {
    if (!moveTargetMatterId) {
      setError('Please select a destination');
      return;
    }

    if (selectedFileIds.size === 0 && selectedFolderIds.size === 0) {
      setError('No items selected');
      return;
    }

    setIsMoving(true);
    setError(null);

    try {
      const result = await fileService.moveItems({
        file_ids: Array.from(selectedFileIds),
        folder_ids: Array.from(selectedFolderIds),
        target_case_id: moveTargetMatterId,
        target_folder_id: moveTargetFolderId || undefined,
      });

      setToast({ 
        message: `Moved ${result.moved.folders} folder(s) and ${result.moved.files} file(s) successfully. Intelligence will be extracted for the target matter.`, 
        type: 'success' 
      });

      // Clear selection and close modal
      clearSelection();
      setShowMoveModal(false);
      setMoveTargetMatterId('');
      setMoveTargetFolderId(null);

      // Refresh data to show updated state
      await Promise.all([refreshFolders(), refreshFiles()]);
    } catch (err: any) {
      console.error('Error moving items:', err);
      setError(err.message || 'Failed to move items');
    } finally {
      setIsMoving(false);
    }
  };

  const handleEditMatter = (caseItem: Case, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingMatterId(caseItem.id);
    setEditingMatterName(caseItem.name);
  };

  const handleSaveMatterName = async (caseId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!editingMatterName.trim()) {
      setError('Matter name cannot be empty');
      return;
    }
    
    try {
      const updated = await caseService.updateCase(caseId, { name: editingMatterName });
      if (updated) {
        // Optimistically update in context
        updateCase(caseId, { name: editingMatterName });
      } else {
        setError('Failed to update matter name');
      }
    } catch (err) {
      console.error('Error updating matter:', err);
      setError('Failed to update matter name');
    }
    
    setEditingMatterId(null);
    setEditingMatterName('');
  };

  const handleCancelMatterEdit = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    setEditingMatterId(null);
    setEditingMatterName('');
  };

  const handleEditFolder = (folder: Folder, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingFolderId(folder.id);
    setEditingFolderName(folder.name);
  };

  const handleSaveFolderName = async (folderId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!editingFolderName.trim()) {
      setError('Folder name cannot be empty');
      return;
    }
    
    try {
      const updated = await folderService.updateFolder(folderId, { name: editingFolderName });
      if (updated) {
        // Optimistically update in context
        updateFolder(folderId, { name: editingFolderName });
      } else {
        setError('Failed to update folder name');
      }
    } catch (err) {
      console.error('Error updating folder:', err);
      setError('Failed to update folder name');
    }
    
    setEditingFolderId(null);
    setEditingFolderName('');
  };

  const handleCancelFolderEdit = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    setEditingFolderId(null);
    setEditingFolderName('');
  };

  const handleUploadModalOpen = () => {
    setShowUploadModal(true);
    
    // Auto-select based on current context
    if (currentMatter) {
      setSelectedMatter(currentMatter.id);
      if (currentFolder) {
        setSelectedFolder(currentFolder.id);
      } else {
        setSelectedFolder('');
      }
    } else {
      // Default to General Documents when on cases view
      const generalDocsCase = cases.find(c => c.name === 'General Documents');
      setSelectedMatter(generalDocsCase?.id || '');
      setSelectedFolder('');
    }
    
    setUploadFiles([]);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      // Filter out system files like .DS_Store, Thumbs.db, etc.
      const filteredFiles = Array.from(e.target.files).filter(file => {
        const fileName = file.name.toLowerCase();
        const systemFiles = ['.ds_store', 'thumbs.db', 'desktop.ini', '.localized'];
        return !systemFiles.includes(fileName);
      });
      setUploadFiles(filteredFiles);
      
      // Detect folder upload by checking if files have webkitRelativePath
      const isFolderUpload = filteredFiles.some(file => {
        const path = (file as any).webkitRelativePath || '';
        return path && path.includes('/');
      });
      
      // Set flag to trigger auto-upload for folders
      if (isFolderUpload && selectedMatter) {
        setShouldAutoUpload(true);
      }
    }
  };

  const handleUploadSubmit = async () => {
    if (!selectedMatter) {
      setError('Please select a matter');
      return;
    }
    if (uploadFiles.length === 0) {
      setError('Please select files to upload');
      return;
    }
    
    // Prevent duplicate clicks
    if (isUploading) {
      return;
    }

    setIsUploading(true);
    setUploadProgress({ current: 0, total: uploadFiles.length });
    
    // Close modal immediately for better UX
    setShowUploadModal(false);
    setToast({ message: `Uploading ${uploadFiles.length} file(s)...`, type: 'info' });

    // Automatically switch to files view to show upload progress
    if (!currentMatter) {
      // In home view - switch homeTab to files
      setHomeTab('files');
    } else {
      // In matter view - switch contentTab to files
      setContentTab('files');
    }

    // Check if this is a folder upload by examining webkitRelativePath
    const hasFolderStructure = uploadFiles.some(file => {
      const path = (file as any).webkitRelativePath || '';
      return path && path.includes('/');
    });

    try {
      if (hasFolderStructure) {
        // Process folder structure and create nested folders in database
        const folderMap = new Map<string, string>(); // path -> database folder ID
        
        // Extract root folder name from first file's path
        const firstPath = (uploadFiles[0] as any).webkitRelativePath || '';
        const rootFolderName = firstPath.split('/')[0];
        
        // Create root folder in database
        const rootFolder = await folderService.createFolder({
          name: rootFolderName,
          case_id: selectedMatter,
          parent_folder_id: selectedFolder || undefined,
        });
        
        if (!rootFolder) {
          setToast({ message: 'Failed to create folder', type: 'error' });
          setIsUploading(false);
          setUploadProgress(null);
          return;
        }
        
        // Add to uploading folders (shows spinner)
        setUploadingFolderIds(prev => new Set([...prev, rootFolder.id]));
        folderMap.set(rootFolderName, rootFolder.id);
        
        // Add folder to context immediately
        addFolder(rootFolder);
        
        // Collect all unique folder paths
        const folderPaths = new Set<string>();
        uploadFiles.forEach((file) => {
          const relativePath = (file as any).webkitRelativePath || file.name;
          const pathParts = relativePath.split('/');
          
          // Add all intermediate folder paths
          for (let i = 1; i < pathParts.length - 1; i++) {
            const folderPath = pathParts.slice(0, i + 1).join('/');
            folderPaths.add(folderPath);
          }
        });
        
        // Sort paths by depth so parents are created before children
        const sortedPaths = Array.from(folderPaths).sort((a, b) => 
          a.split('/').length - b.split('/').length
        );
        
        // Create each subfolder in database
        for (const folderPath of sortedPaths) {
          const pathParts = folderPath.split('/');
          const folderName = pathParts[pathParts.length - 1];
          const parentPath = pathParts.slice(0, pathParts.length - 1).join('/');
          const parentId = folderMap.get(parentPath);
          
          if (!folderMap.has(folderPath)) {
            const subfolder = await folderService.createFolder({
              name: folderName,
              case_id: selectedMatter,
              parent_folder_id: parentId,
            });
            
            if (subfolder) {
              folderMap.set(folderPath, subfolder.id);
              setUploadingFolderIds(prev => new Set([...prev, subfolder.id]));
              // Add subfolder to context
              addFolder(subfolder);
            }
          }
        }
        
        // Now upload each file to its correct folder
        let uploadedCount = 0;
        for (const file of uploadFiles) {
          const relativePath = (file as any).webkitRelativePath || file.name;
          const pathParts = relativePath.split('/');
          
          // Determine which folder this file belongs to
          let targetFolderId: string;
          
          if (pathParts.length === 2) {
            // File is directly in root folder
            targetFolderId = rootFolder.id;
          } else {
            // File is in a subfolder
            const folderPath = pathParts.slice(0, pathParts.length - 1).join('/');
            targetFolderId = folderMap.get(folderPath) || rootFolder.id;
          }
          
          // Upload file to database and storage
          const result = await fileService.uploadFile(file, selectedMatter, targetFolderId);
          if (result) {
            uploadedCount++;
            setUploadProgress({ current: uploadedCount, total: uploadFiles.length });
            // Add file to context for immediate UI update
            addFile(result as any);
          }
        }
        
        // Also call onFilesSelected for frontend state (legacy compatibility)
        uploadFiles.forEach((file) => {
          const relativePath = (file as any).webkitRelativePath || file.name;
          const pathParts = relativePath.split('/');
          let targetFolderId: string;
          
          if (pathParts.length === 2) {
            targetFolderId = rootFolder.id;
          } else {
            const folderPath = pathParts.slice(0, pathParts.length - 1).join('/');
            targetFolderId = folderMap.get(folderPath) || rootFolder.id;
          }
          
          onFilesSelected([file], selectedMatter, targetFolderId);
        });
        
        // Clear uploading state for all folders
        setUploadingFolderIds(new Set());
        
        // Show success message
        setToast({ message: `${uploadedCount} file(s) uploaded successfully! Processing...`, type: 'success' });
        
        // DataContext handles polling automatically for processing files
        
      } else {
        // Regular file upload without folder structure
        let uploadedCount = 0;
        let failedFiles: string[] = [];
        
        for (const file of uploadFiles) {
          try {
            const result = await fileService.uploadFile(file, selectedMatter, selectedFolder || undefined);
            if (result) {
              uploadedCount++;
              setUploadProgress({ current: uploadedCount, total: uploadFiles.length });
              // Add file to context for immediate UI update
              addFile(result as any);
            } else {
              failedFiles.push(file.name);
            }
          } catch (uploadErr) {
            console.error(`Failed to upload ${file.name}:`, uploadErr);
            failedFiles.push(file.name);
          }
        }
        
        // Also call onFilesSelected for frontend state (legacy compatibility)
        onFilesSelected(uploadFiles, selectedMatter, selectedFolder || undefined);
        
        // Show appropriate message
        if (failedFiles.length === 0) {
          setToast({ message: `${uploadedCount} file(s) uploaded successfully! Processing...`, type: 'success' });
        } else if (uploadedCount > 0) {
          setToast({ message: `${uploadedCount} uploaded, ${failedFiles.length} failed: ${failedFiles.join(', ')}`, type: 'error' });
        } else {
          setToast({ message: `Upload failed for: ${failedFiles.join(', ')}`, type: 'error' });
        }
      }
      
      // Start polling for status updates if we have processing files
      // (DataContext handles polling automatically for processing files)
      
      // Trigger a background refresh to sync with database
      refreshFiles(true);
      
    } catch (err) {
      console.error('Error uploading files:', err);
      setToast({ message: `Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`, type: 'error' });
      // Clear any uploading folder states
      setUploadingFolderIds(new Set());
    } finally {
      setIsUploading(false);
      setUploadProgress(null);
      setUploadFiles([]);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return new Date(dateString).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const getFileIcon = (mimeType?: string) => {
    if (!mimeType) return '📄';
    if (mimeType.includes('pdf')) {
      return '📄';
    } else if (mimeType.includes('image')) {
      return '🖼️';
    } else if (mimeType.includes('word') || mimeType.includes('document')) {
      return '📝';
    } else if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('csv')) {
      return '📊';
    } else if (mimeType.includes('outlook') || mimeType.includes('msg')) {
      return '📧';
    }
    return '📄';
  };

  // Map processing_stage DB values to user-friendly labels
  const getProcessingStageLabel = (stage?: string | null): string => {
    switch (stage) {
      case 'downloading': return 'Downloading';
      case 'extracting_text': return 'Extracting text';
      case 'extracting_images': return 'Extracting images';
      case 'chunking': return 'Analyzing content';
      case 'generating_embeddings': return 'Generating embeddings';
      case 'saving': return 'Saving results';
      // Image pipeline stages
      case 'normalizing': return 'Normalizing image';
      case 'ocr': return 'Running OCR';
      case 'classifying': return 'Classifying image';
      case 'linking': return 'Linking to case';
      default: return 'Processing';
    }
  };

  // Get classification display badge for images
  const getClassificationBadge = (classification?: string | null) => {
    if (!classification) return null;
    const labels: Record<string, { label: string; color: string }> = {
      exhibit_photo:     { label: 'Exhibit',    color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' },
      scanned_document:  { label: 'Scan',       color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
      identity_document: { label: 'ID Doc',     color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
      legal_notice:      { label: 'Notice',     color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
      receipt_invoice:   { label: 'Receipt',    color: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400' },
      map_diagram:       { label: 'Diagram',    color: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400' },
      medical_record:    { label: 'Medical',    color: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400' },
      signature_page:    { label: 'Signature',  color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' },
      handwritten_note:  { label: 'Handwritten', color: 'bg-lime-100 text-lime-700 dark:bg-lime-900/30 dark:text-lime-400' },
      other:             { label: 'Image',      color: 'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400' },
    };
    const cfg = labels[classification] || labels.other;
    return (
      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${cfg!.color}`}>
        {cfg!.label}
      </span>
    );
  };

  // Get link status indicator for images
  const getLinkStatusIndicator = (linkStatus?: string | null, matchScore?: number | null) => {
    if (!linkStatus || linkStatus === 'none') return null;
    if (linkStatus === 'auto') {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" title={`Match: ${((matchScore ?? 0) * 100).toFixed(0)}%`}>
          🔗 Linked
        </span>
      );
    }
    if (linkStatus === 'suggested') {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400" title={`Match: ${((matchScore ?? 0) * 100).toFixed(0)}%`}>
          💡 Suggested
        </span>
      );
    }
    return null;
  };

  // Get file status display
  const getStatusBadge = (status?: string, processingStage?: string | null) => {
    switch (status) {
      case 'processing':
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400">
            <svg className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <span className="transition-all duration-300">{getProcessingStageLabel(processingStage)}</span>
          </span>
        );
      case 'ready':
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            Ready
          </span>
        );
      case 'failed':
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            Failed
          </span>
        );
      case 'uploaded':
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
            </svg>
            Pending
          </span>
        );
    }
  };

  // Get all folder IDs in a hierarchy (for hierarchical file display)
  const getAllChildFolderIds = (parentFolderId: string | null, caseId: string): string[] => {
    const result: string[] = [];
    const queue = parentFolderId ? [parentFolderId] : folders.filter(f => f.case_id === caseId && !f.parent_folder_id).map(f => f.id);
    
    while (queue.length > 0) {
      const folderId = queue.shift()!;
      result.push(folderId);
      // Find children of this folder
      const children = folders.filter(f => f.parent_folder_id === folderId);
      queue.push(...children.map(c => c.id));
    }
    
    return result;
  };

  // Use database files instead of prop files for display
  const filteredFiles = dbFiles.filter(file => {
    // Home view with "Files" tab selected - show ALL files
    if (currentView === 'cases' && homeTab === 'files') {
      return true;
    }
    
    // Only show files in the files view (inside a case)
    if (currentView !== 'files') return false;
    
    // If no case selected, show all files (backward compatibility)
    if (!currentMatter) return true;
    
    // contentTab === 'files' means show ALL files in current scope (hierarchical)
    if (contentTab === 'files') {
      if (currentFolder) {
        // Show all files in this folder and any subfolders
        const allFolderIds = getAllChildFolderIds(currentFolder.id, currentMatter.id);
        return allFolderIds.includes(file.folder_id || '');
      } else {
        // Show all files in the entire case
        return file.case_id === currentMatter.id || !file.case_id;
      }
    }
    
    // contentTab === 'folders' means show only files at current level
    if (currentFolder) {
      return file.folder_id === currentFolder.id;
    } else {
      // Case root: show files with matching case_id and no folder_id
      return (file.case_id === currentMatter.id && !file.folder_id) || !file.case_id;
    }
  });

  // Filter matters based on search, type, and status filters
  const filteredMatters = cases.filter(matter => {
    if (searchQuery && !matter.name.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !(matter.client_name || '').toLowerCase().includes(searchQuery.toLowerCase()) &&
        !(matter.case_number || '').toLowerCase().includes(searchQuery.toLowerCase()) &&
        !(matter.matter_ref || '').toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    if (filterType && matter.matter_type !== filterType) return false;
    const matterStatus = matter.archived_at ? 'archived' : (matter.status === 'closed' ? 'closed' : 'active');
    if (filterStatus) {
      if (filterStatus !== matterStatus) return false;
    } else {
      // By default, hide archived matters (user can select "Archived" to see them)
      if (matterStatus === 'archived') return false;
    }
    return true;
  }).sort((a, b) => {
    // General Documents always comes first
    if (a.name === 'General Documents') return -1;
    if (b.name === 'General Documents') return 1;
    // Sort rest by created_at descending (newest first)
    const dateA = new Date(a.created_at || 0).getTime();
    const dateB = new Date(b.created_at || 0).getTime();
    return dateB - dateA;
  });

  // Get matter name for a file (used in all-files view)
  const getMatterNameForFile = (file: UploadedFile): string => {
    if (file.case_name) return file.case_name;
    if (file.case_id) {
      const fileCase = cases.find(c => c.id === file.case_id);
      return fileCase?.name || 'Unknown Matter';
    }
    return 'No Matter';
  };

  const normalizedFileSearch = fileSearchQuery.trim().toLowerCase();
  const allFilesVisible = normalizedFileSearch
    ? filteredFiles.filter(file => {
        const fileName = (file.name || (file as { filename?: string }).filename || '').toLowerCase();
        const matterName = getMatterNameForFile(file).toLowerCase();
        return fileName.includes(normalizedFileSearch) || matterName.includes(normalizedFileSearch);
      })
    : filteredFiles;

  // Check if a file's matter is read-only (used in all-files view)
  const isFileMatterReadOnly = (file: UploadedFile): boolean => {
    if (file.case_id) {
      const fileCase = cases.find(c => c.id === file.case_id);
      return fileCase?.status === 'closed' || fileCase?.status === 'archived';
    }
    return false;
  };

  // Get matter status for a file (used in all-files view)
  const getMatterStatusForFile = (file: UploadedFile): string => {
    if (file.case_id) {
      const fileCase = cases.find(c => c.id === file.case_id);
      return fileCase?.status || 'active';
    }
    return 'active';
  };

  // Render breadcrumb
  const renderBreadcrumb = () => (
    <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 mb-4">
      <button onClick={() => handleBreadcrumbClick('home')} className="hover:text-blue-600 font-medium">
        Home
      </button>
      {currentMatter && (
        <>
          <span>/</span>
          <button onClick={() => handleBreadcrumbClick('case')} className="hover:text-blue-600 font-medium">
            {currentMatter.name}
          </button>
        </>
      )}
      {currentFolder && (
        <>
          <span>/</span>
          <span className="text-gray-900 dark:text-white font-medium">{currentFolder.name}</span>
        </>
      )}
      {currentView === 'files' && !currentFolder && currentMatter && (
        <>
          <span>/</span>
          <span className="text-gray-900 dark:text-white font-medium">📂 Matter Files</span>
        </>
      )}
    </div>
  );

  return (
    <>
    <div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-900 relative">
      {/* Toast Notification */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg flex items-center gap-2 animate-toast-in ${
          toast.type === 'success' ? 'bg-green-500 text-white' :
          toast.type === 'error' ? 'bg-red-500 text-white' :
          'bg-blue-500 text-white'
        }`}>
          {toast.type === 'success' && (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          )}
          {toast.type === 'error' && (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          )}
          {toast.type === 'info' && (
            <svg className="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          )}
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)} className="ml-2 hover:opacity-70">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Upload Progress Bar */}
      {isUploading && uploadProgress && (
        <div className="fixed top-0 left-0 right-0 z-40">
          <div className="h-1 bg-gray-200 dark:bg-gray-700">
            <div 
              className="h-1 bg-blue-500 transition-all duration-300"
              style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }}
            />
          </div>
          <div className="bg-blue-50 dark:bg-blue-900/20 border-b border-blue-100 dark:border-blue-800 px-4 py-2 text-sm text-blue-700 dark:text-blue-400 flex items-center gap-2">
            <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Uploading files... ({uploadProgress.current}/{uploadProgress.total})
          </div>
        </div>
      )}

      <div className="max-w-7xl mx-auto p-6 bg-gray-50 dark:bg-gray-900 min-h-screen">
        {/* Header */}
        <div className="mb-8 flex flex-col sm:flex-row sm:items-center gap-4 sm:justify-between">
          <div className="flex items-center gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white tracking-tight">Matters</h1>
                {isSyncing && (
                  <div className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400">
                    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    <span>Syncing...</span>
                  </div>
                )}
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Organize matters, folders, and documents</p>
            </div>
            {/* Matters/Files Toggle - Only show at home view */}
            {currentView === 'cases' && (
              <div className="ml-6 hidden md:flex bg-white dark:bg-gray-800 rounded-lg p-1 border border-gray-200 dark:border-gray-700">
                <button
                  onClick={() => setHomeTab('matters')}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
                    homeTab === 'matters'
                      ? 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                    All Matters
                  </span>
                </button>
                <button
                  onClick={() => setHomeTab('files')}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
                    homeTab === 'files'
                      ? 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    All Files
                  </span>
                </button>
              </div>
            )}

          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleSync}
              disabled={isSyncing}
              className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
              title="Refresh all data"
            >
              <svg className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span className="hidden sm:inline">{isSyncing ? 'Syncing...' : 'Sync'}</span>
            </button>
            {currentView !== 'cases' && (
              <button
                onClick={handleBackClick}
                className="px-4 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-900 dark:text-white rounded-lg transition-colors flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Back
              </button>
            )}
            {currentView === 'cases' && (
              <>
                <button
                  onClick={handleUploadModalOpen}
                  disabled={isUploading}
                  className={`flex-1 sm:flex-initial px-4 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 border whitespace-nowrap ${
                    isUploading 
                      ? 'bg-gray-100 dark:bg-gray-700 cursor-not-allowed text-gray-400 dark:text-gray-500 border-gray-200 dark:border-gray-700' 
                      : 'bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700 shadow-sm'
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  {isUploading ? 'Uploading...' : 'Upload Files'}
                </button>
                <button
                  onClick={() => setShowCreateMatterModal(true)}
                  className="flex-1 sm:flex-initial px-4 py-2.5 bg-gray-900 dark:bg-white hover:bg-gray-800 dark:hover:bg-gray-100 text-white dark:text-gray-900 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 shadow-sm whitespace-nowrap"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  New Matter
                </button>
              </>
            )}
            {currentView === 'files' && !matterIsReadOnly && (
              <>
                <button
                  onClick={() => setShowCreateFolderModal(true)}
                  className="flex-1 sm:flex-initial px-4 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-900 dark:text-white rounded-lg transition-colors flex items-center justify-center gap-2 border border-gray-200 dark:border-gray-600 whitespace-nowrap"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  New Folder
                </button>
                <button
                  onClick={handleUploadModalOpen}
                  className="flex-1 sm:flex-initial px-4 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-900 dark:text-white rounded-lg transition-colors flex items-center justify-center gap-2 border border-gray-200 dark:border-gray-600 whitespace-nowrap"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  Upload Files
                </button>
                <div className="border-l border-gray-300 dark:border-gray-600 h-8 mx-1" />
                <button
                  onClick={() => {
                    if (selectionMode) {
                      clearSelection();
                    } else {
                      setSelectionMode(true);
                    }
                  }}
                  className={`px-3 py-2 rounded-lg transition-colors flex items-center gap-2 text-sm font-medium ${
                    selectionMode
                      ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-700'
                      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 border border-transparent'
                  }`}
                  title={selectionMode ? 'Exit selection' : 'Select items to move'}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                  {selectionMode ? 'Cancel' : 'Select'}
                </button>
              </>
            )}
            {selectionMode && (selectedFileIds.size > 0 || selectedFolderIds.size > 0) && (
              <button
                onClick={openMoveForSelection}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors flex items-center gap-2 font-medium text-sm animate-fade-in"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
                Move {selectedFileIds.size + selectedFolderIds.size} item(s)
              </button>
            )}
          </div>

          {currentView === 'cases' && (
            <div className="md:hidden mt-1 flex bg-white dark:bg-gray-800 rounded-lg p-1 border border-gray-200 dark:border-gray-700 w-full">
              <button
                onClick={() => setHomeTab('matters')}
                className={`flex-1 px-4 py-2 rounded-md text-sm font-medium transition-all ${
                  homeTab === 'matters'
                    ? 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                }`}
              >
                <span className="flex items-center justify-center gap-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  All Matters
                </span>
              </button>
              <button
                onClick={() => setHomeTab('files')}
                className={`flex-1 px-4 py-2 rounded-md text-sm font-medium transition-all ${
                  homeTab === 'files'
                    ? 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                }`}
              >
                <span className="flex items-center justify-center gap-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  All Files
                </span>
              </button>
            </div>
          )}
        </div>

        {/* Breadcrumb */}
        {currentView !== 'cases' && renderBreadcrumb()}

        <div key={navKey} className={slideDirection === 'left' ? 'animate-page-slide-left' : 'animate-page-slide-right'}>

        {/* Error Display */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
            <button onClick={() => setError(null)} className="text-xs text-red-600 dark:text-red-400 underline mt-1">Dismiss</button>
          </div>
        )}

        {/* Matters View */}
        {currentView === 'cases' && (
          <>
            {/* Matters Tab - Show matter grid */}
            {homeTab === 'matters' && (
              <>
              {/* Filter Bar */}
              <div className="mb-5 flex flex-wrap items-center gap-3">
                <div className="relative flex-1 min-w-[200px] max-w-sm">
                  <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <input
                    type="text"
                    placeholder="Search matters..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-3 py-2 border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded-lg text-sm focus:ring-2 focus:ring-gray-900/10 dark:focus:ring-white/20 focus:border-gray-300 dark:focus:border-gray-600 transition-colors"
                  />
                </div>
                <div className="relative">
                  <select
                    value={filterType}
                    onChange={(e) => setFilterType(e.target.value)}
                    className="appearance-none px-3 py-2 pr-8 border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-gray-900/10 dark:focus:ring-white/20 focus:border-gray-300 dark:focus:border-gray-600 transition-colors"
                  >
                    <option value="">All Types</option>
                    {MATTER_TYPES.map(t => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                  <svg className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
                <div className="relative">
                  <select
                    value={filterStatus}
                    onChange={(e) => setFilterStatus(e.target.value)}
                    className="appearance-none px-3 py-2 pr-8 border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-gray-900/10 dark:focus:ring-white/20 focus:border-gray-300 dark:focus:border-gray-600 transition-colors"
                  >
                    <option value="">Open & Closed</option>
                    {MATTER_STATUSES.map(s => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                  <svg className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
                {(searchQuery || filterType || filterStatus) && (
                  <button
                    onClick={() => { setSearchQuery(''); setFilterType(''); setFilterStatus(''); }}
                    className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                  >
                    Clear filters
                  </button>
                )}
                <span className="ml-auto text-xs text-gray-400 dark:text-gray-500 hidden sm:inline">
                  {filteredMatters.length} {filteredMatters.length === 1 ? 'matter' : 'matters'}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                {/* Skeleton Loaders - Show when initial load with no cached data */}
                {isInitialLoad && cases.length === 0 && (
                  <>
                    {[1, 2, 3, 4, 5, 6].map((i) => (
                      <div
                        key={`skeleton-${i}`}
                        className="relative bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 animate-pulse"
                      >
                        <div className="absolute top-4 right-4">
                          <div className="w-12 h-5 bg-gray-200 dark:bg-gray-700 rounded-full"></div>
                        </div>
                        <div className="w-10 h-10 bg-gray-100 dark:bg-gray-700 rounded-lg mb-4"></div>
                        <div className="h-5 bg-gray-200 dark:bg-gray-700 rounded w-3/4 mb-2"></div>
                        <div className="h-3 bg-gray-100 dark:bg-gray-700/50 rounded w-1/3 mb-3"></div>
                        <div className="h-3 bg-gray-100 dark:bg-gray-700/50 rounded w-1/2 mb-4"></div>
                        <div className="border-t border-gray-100 dark:border-gray-700 pt-3 mt-3 flex justify-between">
                          <div className="w-16 h-5 bg-gray-100 dark:bg-gray-700/50 rounded-full"></div>
                          <div className="w-24 h-3 bg-gray-100 dark:bg-gray-700/50 rounded"></div>
                        </div>
                      </div>
                    ))}
                  </>
                )}
                
                {/* Actual Matter Cards */}
                {filteredMatters.map((caseItem, idx) => {
                  const typeConfig = caseItem.matter_type ? getMatterTypeConfig(caseItem.matter_type) : null;
                  const statusValue = caseItem.archived_at ? 'archived' : (caseItem.status === 'closed' ? 'closed' : 'active');
                  const statusConfig = getMatterStatusConfig(statusValue);
                  const isGeneralDocs = caseItem.name === 'General Documents';
                  return (
                  <div
                    key={caseItem.id}
                    className="relative bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 hover:shadow-lg hover:border-gray-300 dark:hover:border-gray-600 transition-all duration-200 cursor-pointer group animate-card-in opacity-0"
                    style={{ animationDelay: `${Math.min(idx, 11) * 50}ms` }}
                    onClick={() => handleMatterClick(caseItem)}
                  >
                    {/* Top-right: Hover actions + Status badge (status always pinned right) */}
                    <div className="absolute top-4 right-4 flex items-center gap-1.5">
                      {!isGeneralDocs && (
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                          {onNavigateToChat && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setActiveMatter(caseItem);
                                onNavigateToChat();
                              }}
                              className="p-1.5 rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/30 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                              title="Open chat for this matter"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                              </svg>
                            </button>
                          )}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteMatter(caseItem.id, caseItem.name);
                            }}
                            className="p-1.5 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                            title="Delete matter"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      )}
                      {statusConfig && (
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusConfig.color} ${statusConfig.textColor}`}>
                          {statusConfig.label}
                        </span>
                      )}
                    </div>

                    {/* Folder icon */}
                    <div className="w-10 h-10 rounded-lg bg-gray-50 dark:bg-gray-700/50 flex items-center justify-center mb-4">
                      <svg className="w-5 h-5 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                      </svg>
                    </div>

                    {/* Matter name */}
                    <h3 className="font-semibold text-base text-gray-900 dark:text-white mb-1 pr-16 truncate" title={caseItem.name}>
                      {caseItem.name}
                    </h3>

                    {/* Reference code */}
                    {caseItem.matter_ref && (
                      <p className="text-xs text-gray-400 dark:text-gray-500 mb-1 font-mono">{caseItem.matter_ref}</p>
                    )}

                    {/* Client name */}
                    {caseItem.client_name && !isGeneralDocs && (
                      <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">Client: {caseItem.client_name}</p>
                    )}

                    {/* Case reference */}
                    {caseItem.case_number && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Ref: {caseItem.case_number}</p>
                    )}

                    {/* Footer: Type badge + Date */}
                    <div className="flex items-center justify-between mt-4 pt-3 border-t border-gray-100 dark:border-gray-700/50">
                      <div>
                        {typeConfig && !isGeneralDocs ? (
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${typeConfig.color} ${typeConfig.textColor}`}>
                            {typeConfig.label}
                          </span>
                        ) : (
                          <span />
                        )}
                      </div>
                      <p className="text-xs text-gray-400 dark:text-gray-500">{formatDate(caseItem.created_at)}</p>
                    </div>
                  </div>
                  );
                })}
            
            {/* Empty State - Show when no cases and not loading */}
            {!isInitialLoad && cases.length === 0 && (
              <div className="col-span-full flex flex-col items-center justify-center py-16 text-center">
                <div className="text-6xl mb-4">📂</div>
                <h3 className="text-xl font-semibold text-gray-700 dark:text-gray-300 mb-2">No matters yet</h3>
                <p className="text-gray-500 dark:text-gray-400 mb-6">Create your first matter to start organizing your legal documents</p>
                <button
                  onClick={() => setShowCreateMatterModal(true)}
                  className="px-6 py-3 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-900 dark:text-white rounded-lg transition-colors flex items-center gap-2 border border-gray-200 dark:border-gray-600"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Create Your First Matter
                </button>
              </div>
            )}

            {/* Filtered Empty State */}
            {!isInitialLoad && cases.length > 0 && filteredMatters.length === 0 && (
              <div className="col-span-full flex flex-col items-center justify-center py-12 text-center">
                <div className="text-5xl mb-4">🔍</div>
                <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">No matters match your filters</h3>
                <p className="text-gray-500 dark:text-gray-400 mb-4">Try adjusting your search or filter criteria</p>
                <button
                  onClick={() => { setSearchQuery(''); setFilterType(''); setFilterStatus(''); }}
                  className="px-4 py-2 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
                >
                  Clear all filters
                </button>
              </div>
            )}
              </div>
              </>
            )}

            {/* All Files Tab - Show all files across all cases */}
            {homeTab === 'files' && (
              <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                {/* Loading Skeleton for Files */}
                {isLoadingFiles && filteredFiles.length === 0 && (
                  <div className="p-4 space-y-3">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <div key={`file-skeleton-${i}`} className="flex items-center gap-4 p-3 animate-pulse">
                        <div className="w-10 h-10 bg-gray-200 rounded"></div>
                        <div className="flex-1">
                          <div className="h-4 bg-gray-200 rounded w-1/3 mb-2"></div>
                          <div className="h-3 bg-gray-100 rounded w-1/4"></div>
                        </div>
                        <div className="w-20 h-6 bg-gray-100 rounded"></div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Search Bar */}
                {!isLoadingFiles && (
                  <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800">
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="relative flex-1 min-w-[200px]">
                        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                        <input
                          type="text"
                          placeholder="Search files..."
                          value={fileSearchQuery}
                          onChange={(e) => setFileSearchQuery(e.target.value)}
                          className="w-full pl-10 pr-3 py-2 border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded-lg text-sm focus:ring-2 focus:ring-gray-900/10 dark:focus:ring-white/20 focus:border-gray-300 dark:focus:border-gray-600 transition-colors"
                        />
                      </div>
                      {fileSearchQuery && (
                        <button
                          onClick={() => setFileSearchQuery('')}
                          className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                        >
                          Clear
                        </button>
                      )}
                      <span className="text-xs text-gray-400 dark:text-gray-500">
                        {allFilesVisible.length} of {filteredFiles.length} files
                      </span>
                    </div>
                  </div>
                )}



                {/* Files Table */}
                {!isLoadingFiles && allFilesVisible.length === 0 ? (
                  <div className="p-12 text-center">
                    {fileSearchQuery ? (
                      <>
                        <div className="text-5xl mb-4">🔍</div>
                        <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">No files match your search</h3>
                        <p className="text-gray-500 dark:text-gray-400 mb-4">Try a different filename or matter</p>
                        <button
                          onClick={() => setFileSearchQuery('')}
                          className="px-4 py-2 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
                        >
                          Clear search
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="text-5xl mb-4">📄</div>
                        <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">No files uploaded yet</h3>
                        <p className="text-gray-500 dark:text-gray-400 mb-4">
                          {matterIsReadOnly ? 'This matter is read-only.' : 'Upload your first document to get started'}
                        </p>
                        {!matterIsReadOnly && (
                          <button
                            onClick={handleUploadModalOpen}
                            className="px-4 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-900 dark:text-white rounded-lg transition-colors inline-flex items-center gap-2 border border-gray-200 dark:border-gray-600"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                            </svg>
                            Upload Files
                          </button>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  <>
                  <div className="md:hidden divide-y divide-gray-100 dark:divide-gray-700">
                    {allFilesVisible.map((file) => {
                      const isExpanded = expandedMobileFileIds.has(file.id);
                      const matterStatus = getMatterStatusForFile(file);
                      const statusConfig = getMatterStatusConfig(matterStatus);

                      return (
                        <div key={`mobile-${file.id}`} className="p-3">
                          <button
                            onClick={() => {
                              setExpandedMobileFileIds(prev => {
                                const next = new Set(prev);
                                if (next.has(file.id)) {
                                  next.delete(file.id);
                                } else {
                                  next.add(file.id);
                                }
                                return next;
                              });
                            }}
                            className="w-full text-left"
                          >
                            <div className="flex items-center gap-3">
                              <span className="text-2xl">{getFileIcon(file.name)}</span>
                              <div className="min-w-0 flex-1">
                                <p className="font-medium text-gray-900 dark:text-white truncate" title={file.name}>{file.name}</p>
                                <p className="text-xs text-gray-500 dark:text-gray-400">{formatFileSize(file.size)}</p>
                              </div>
                              <svg className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </div>
                          </button>

                          <div className={`transition-all duration-300 ease-out overflow-hidden ${isExpanded ? 'max-h-[500px] opacity-100 mt-3' : 'max-h-0 opacity-0 mt-0'}`}> 
                            <div className="pt-3 border-t border-gray-100 dark:border-gray-700 space-y-3">
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-xs text-gray-500 dark:text-gray-400">Matter</span>
                                <span className="text-sm text-gray-700 dark:text-gray-300 text-right">{getMatterNameForFile(file)}</span>
                              </div>
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-xs text-gray-500 dark:text-gray-400">Matter Status</span>
                                <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${statusConfig.color} ${statusConfig.textColor}`}>
                                  {statusConfig.label}
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-xs text-gray-500 dark:text-gray-400">File Status</span>
                                <div className="flex items-center gap-1.5 flex-wrap justify-end">
                                  {getStatusBadge(file.status, file.processing_stage)}
                                  {getClassificationBadge(file.classification)}
                                  {getLinkStatusIndicator(file.link_status, file.match_score)}
                                </div>
                              </div>
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-xs text-gray-500 dark:text-gray-400">Uploaded</span>
                                <span className="text-sm text-gray-500 dark:text-gray-400">{formatDate(file.created_at)}</span>
                              </div>

                              <div className="flex items-center gap-2 pt-1">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (!isFileMatterReadOnly(file)) {
                                      openMoveForFile(file.id);
                                    }
                                  }}
                                  disabled={isFileMatterReadOnly(file)}
                                  className={`flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                                    isFileMatterReadOnly(file)
                                      ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 cursor-not-allowed'
                                      : 'bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200'
                                  }`}
                                  title={isFileMatterReadOnly(file) ? 'Cannot move files from closed/archived matters' : 'Move to...'}
                                >
                                  Move
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (!isFileMatterReadOnly(file)) {
                                      handleDeleteFileUnified(file.id);
                                    }
                                  }}
                                  disabled={isFileMatterReadOnly(file)}
                                  className={`flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                                    isFileMatterReadOnly(file)
                                      ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 cursor-not-allowed'
                                      : 'bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400'
                                  }`}
                                  title={isFileMatterReadOnly(file) ? 'Cannot delete files from closed/archived matters' : 'Delete file'}
                                >
                                  Delete
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <table className="hidden md:table w-full">
                    <thead className="bg-gray-50 dark:bg-gray-700 border-b border-gray-200 dark:border-gray-600">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wider">File</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wider">Matter</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wider">Matter Status</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wider">File Status</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wider">Uploaded</th>
                        <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wider">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      {allFilesVisible.map((file) => (
                        <tr key={file.id} className="hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <span className="text-2xl">{getFileIcon(file.name)}</span>
                              <div>
                                <p className="font-medium text-gray-900 dark:text-white truncate max-w-xs" title={file.name}>{file.name}</p>
                                <p className="text-xs text-gray-500 dark:text-gray-400">{formatFileSize(file.size)}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span className="text-sm text-gray-600 dark:text-gray-400">{getMatterNameForFile(file)}</span>
                          </td>
                          <td className="px-4 py-3">
                            {(() => {
                              const matterStatus = getMatterStatusForFile(file);
                              const statusConfig = getMatterStatusConfig(matterStatus);
                              return (
                                <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${statusConfig.color} ${statusConfig.textColor}`}>
                                  {statusConfig.label}
                                </span>
                              );
                            })()}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {getStatusBadge(file.status, file.processing_stage)}
                              {getClassificationBadge(file.classification)}
                              {getLinkStatusIndicator(file.link_status, file.match_score)}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span className="text-sm text-gray-500 dark:text-gray-400">{formatDate(file.created_at)}</span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <button
                                onClick={(e) => { 
                                  if (!isFileMatterReadOnly(file)) {
                                    e.stopPropagation(); 
                                    openMoveForFile(file.id);
                                  }
                                }}
                                disabled={isFileMatterReadOnly(file)}
                                className={`p-1.5 rounded-md transition-colors ${
                                  isFileMatterReadOnly(file)
                                    ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                                    : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400'
                                }`}
                                title={isFileMatterReadOnly(file) ? 'Cannot move files from closed/archived matters' : 'Move to...'}
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                                </svg>
                              </button>
                              <button
                                onClick={() => {
                                  if (!isFileMatterReadOnly(file)) {
                                    handleDeleteFileUnified(file.id);
                                  }
                                }}
                                disabled={isFileMatterReadOnly(file)}
                                className={`p-1.5 rounded transition-colors ${
                                  isFileMatterReadOnly(file)
                                    ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                                    : 'hover:bg-red-50 dark:hover:bg-gray-700 text-red-600 dark:text-red-400'
                                }`}
                                title={isFileMatterReadOnly(file) ? 'Cannot delete files from closed/archived matters' : 'Delete file'}
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </>
                )}
              </div>
            )}
          </>
        )}

        {/* Files View - Inside a Matter or Folder */}
        {currentView === 'files' && currentMatter && (
          <div>
            {/* Matter Metadata Header */}
            {!currentFolder && (() => {
              const typeConfig = getMatterTypeConfig(currentMatter.matter_type);
              const statusConfig = getMatterStatusConfig(currentMatter.status);
              const matterIsReadOnly = currentMatter.status === 'closed' || currentMatter.status === 'archived';

              return (
                <div className="mb-6 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
                  {/* Read-only banner */}
                  {matterIsReadOnly && (
                    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg mb-4 text-sm ${
                      currentMatter.status === 'closed'
                        ? 'bg-gray-50 dark:bg-gray-900 text-gray-600 dark:text-gray-400'
                        : 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400'
                    }`}>
                      <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                      This matter is {currentMatter.status} — {currentMatter.status === 'closed' ? 'no new uploads or edits' : 'hidden from default views'}
                    </div>
                  )}

                  {/* Row 1: Title + Actions */}
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-3 flex-wrap">
                        <h1 className="text-xl font-bold text-gray-900 dark:text-white truncate">
                          {currentMatter.name}
                        </h1>
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${typeConfig.color} ${typeConfig.textColor}`}>
                          {typeConfig.label}
                        </span>
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusConfig.color} ${statusConfig.textColor}`}>
                          {statusConfig.label}
                        </span>
                      </div>
                      {/* Row 2: Metadata line */}
                      <div className="flex items-center gap-4 mt-2 text-sm text-gray-500 dark:text-gray-400 flex-wrap">
                        <span className="font-mono text-xs bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded">
                          {currentMatter.matter_ref || currentMatter.case_number || currentMatter.id.slice(0, 8)}
                        </span>
                        {currentMatter.client_name && (
                          <span className="flex items-center gap-1">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                            </svg>
                            {currentMatter.client_name}
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                          {new Date(currentMatter.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      </div>
                      {currentMatter.description && (
                        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
                          {currentMatter.description}
                        </p>
                      )}
                    </div>
                    {/* Action Buttons */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {onNavigateToChat && (
                        <button
                          onClick={() => {
                            setActiveMatter(currentMatter);
                            onNavigateToChat();
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/40 rounded-lg transition-colors"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                          </svg>
                          Chat
                        </button>
                      )}
                      <button
                        onClick={() => setShowEditDrawer(true)}
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                        Edit
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Content Toggle - Folders/Files */}
            <div className="mb-4 flex items-center gap-4">
              <div className="flex bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                <button
                  onClick={() => setContentTab('folders')}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
                    contentTab === 'folders'
                      ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-sm'
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                    {currentFolder ? 'Subfolders' : 'Folders'}
                  </span>
                </button>
                <button
                  onClick={() => setContentTab('files')}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
                    contentTab === 'files'
                      ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-sm'
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    All Files
                  </span>
                </button>
              </div>
              <span className="text-sm text-gray-500">
                {contentTab === 'files' 
                  ? currentFolder 
                    ? 'Showing all files in this folder and subfolders'
                    : 'Showing all files in this matter'
                  : currentFolder
                    ? 'Showing subfolders and files at this level'
                    : 'Showing folders and files at root level'}
              </span>
            </div>

            {/* Folders Section - Only show when contentTab is 'folders' */}
            {contentTab === 'folders' && (() => {
              // Filter folders: show only those in current case and current folder level
              const currentLevelFolders = folders.filter(f => {
                if (f.case_id !== currentMatter.id) return false;
                // If we're in a folder, show its children; otherwise show root folders
                return currentFolder 
                  ? f.parent_folder_id === currentFolder.id 
                  : !f.parent_folder_id;
              });
              
              return currentLevelFolders.length > 0 && (
                <div className="mb-6">
                  <h2 className="text-lg font-semibold text-charcoal dark:text-white mb-3">Folders</h2>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                    {currentLevelFolders.map(folder => {
                      const isUploadingFolder = uploadingFolderIds.has(folder.id);
                      
                      return (
                      <div
                        key={folder.id}
                        className={`relative bg-white dark:bg-gray-800 rounded-lg border ${
                          selectionMode && selectedFolderIds.has(folder.id) ? 'border-blue-500 ring-2 ring-blue-200' : 'border-gray-200 dark:border-gray-700'
                        } p-3 transition-all duration-200 group ${
                          isUploadingFolder ? 'opacity-70' : 'hover:shadow-md'
                        }`}
                        onClick={() => {
                          if (selectionMode && !isUploadingFolder) {
                            toggleFolderSelection(folder.id);
                          }
                        }}
                      >
                        {/* Selection indicator in selection mode */}
                        {selectionMode && !isUploadingFolder && (
                          <div className={`absolute top-2 left-2 z-20 w-5 h-5 flex items-center justify-center rounded-full border-2 transition-all duration-150 ${
                            selectedFolderIds.has(folder.id) 
                              ? 'bg-blue-600 border-blue-600' 
                              : 'bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600'
                          }`}>
                            {selectedFolderIds.has(folder.id) && (
                              <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                              </svg>
                            )}
                          </div>
                        )}
                        
                        {/* Uploading Overlay */}
                        {isUploadingFolder && (
                          <div className="absolute inset-0 bg-white/50 dark:bg-gray-800/50 rounded-lg flex items-center justify-center z-10">
                            <div className="flex flex-col items-center gap-1">
                              <svg className="w-6 h-6 text-blue-500 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              </svg>
                              <span className="text-xs text-blue-600 font-medium">Uploading...</span>
                            </div>
                          </div>
                        )}
                        
                        {editingFolderId === folder.id ? (
                          <div onClick={(e) => e.stopPropagation()}>
                            <input
                              type="text"
                              value={editingFolderName}
                              onChange={(e) => setEditingFolderName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSaveFolderName(folder.id);
                                if (e.key === 'Escape') handleCancelFolderEdit(e);
                              }}
                              onBlur={() => handleCancelFolderEdit({ stopPropagation: () => {} } as any)}
                              className="w-full px-2 py-1 border border-blue-500 rounded text-sm font-medium bg-white dark:bg-gray-700 text-charcoal dark:text-white"
                              autoFocus
                            />
                          </div>
                        ) : (
                          <>
                            <div 
                              className={isUploadingFolder ? 'pointer-events-none' : 'cursor-pointer'}
                              onClick={() => !isUploadingFolder && handleFolderClick(folder)}
                            >
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-2xl">📁</span>
                                {!isUploadingFolder && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenFolderMenuId(openFolderMenuId === folder.id ? null : folder.id);
                                  }}
                                  className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-opacity"
                                >
                                  <svg className="w-4 h-4 text-gray-600 dark:text-gray-400" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
                                  </svg>
                                </button>
                                )}
                              </div>
                              <p className="text-sm font-medium text-charcoal dark:text-gray-200 truncate" title={folder.name}>
                                {folder.name}
                              </p>
                            </div>

                            {/* Dropdown Menu */}
                            {openFolderMenuId === folder.id && (
                              <>
                                <div 
                                  className="fixed inset-0 z-10" 
                                  onClick={() => setOpenFolderMenuId(null)}
                                />
                                <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-20">
                                  {!matterIsReadOnly && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleEditFolder(folder, e);
                                        setOpenFolderMenuId(null);
                                      }}
                                      className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2"
                                    >
                                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                      </svg>
                                      Rename
                                    </button>
                                  )}
                                  <div className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400 border-t border-gray-100 dark:border-gray-700">
                                    {folder.folder_type && (
                                      <div>Type: {folder.folder_type}</div>
                                    )}
                                    <div>Created: {formatDate(folder.created_at)}</div>
                                  </div>
                                  {!matterIsReadOnly && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setOpenFolderMenuId(null);
                                        openMoveForFolder(folder.id);
                                      }}
                                      className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2"
                                    >
                                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                                      </svg>
                                      Move to...
                                    </button>
                                  )}
                                  {!matterIsReadOnly && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setOpenFolderMenuId(null);
                                        handleDeleteFolder(folder.id);
                                      }}
                                      className="w-full px-4 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2 border-t border-gray-100 dark:border-gray-700"
                                    >
                                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                      </svg>
                                      Delete
                                    </button>
                                  )}
                                </div>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Files Section */}
            <h2 className="text-lg font-semibold text-charcoal mb-3">
              {contentTab === 'files' 
                ? (currentFolder ? 'All Files in Folder & Subfolders' : 'All Files in Matter')
                : (currentFolder ? 'Files in Folder' : 'Files')}
            </h2>
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
            {/* Loading Skeleton for Files in Matter View */}
            {isLoadingFiles && filteredFiles.length === 0 && (
              <div className="p-4 space-y-3">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={`case-file-skeleton-${i}`} className="flex items-center gap-4 p-3 animate-pulse">
                    <div className="w-6 h-6 bg-gray-200 dark:bg-gray-700 rounded"></div>
                    <div className="flex-1">
                      <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/3 mb-2"></div>
                      <div className="h-3 bg-gray-100 dark:bg-gray-600 rounded w-1/4"></div>
                    </div>
                    <div className="w-16 h-6 bg-gray-100 dark:bg-gray-600 rounded"></div>
                    <div className="w-24 h-6 bg-gray-100 dark:bg-gray-600 rounded"></div>
                  </div>
                ))}
              </div>
            )}
            

            
            <div className="overflow-x-auto">
              {!isLoadingFiles && filteredFiles.length === 0 ? (
                <div className="text-center py-16">
                  <svg className="mx-auto h-12 w-12 text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                  <p className="text-charcoal-muted font-medium">No files uploaded yet</p>
                  <p className="text-sm text-charcoal-muted mt-1">Click Upload Files to add documents</p>
                </div>
              ) : (
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead className="bg-gray-50 dark:bg-gray-800">
                    <tr>
                      {selectionMode && (
                        <th className="px-3 py-3 w-10"></th>
                      )}
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider w-12">#</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">File Name</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider w-32">Matter</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider w-24">Size</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider w-32">Status</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider w-24">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                    {filteredFiles.map((file, index) => (
                      <tr 
                        key={file.id} 
                        className={`hover:bg-gray-50 dark:hover:bg-gray-700 transition-all duration-150 ${
                          selectionMode && selectedFileIds.has(file.id) ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                        }`}
                        onClick={() => selectionMode && toggleFileSelection(file.id)}
                      >
                        {selectionMode && (
                          <td className="px-3 py-4">
                            <div className={`w-5 h-5 flex items-center justify-center rounded-full border-2 transition-all duration-150 ${
                              selectedFileIds.has(file.id)
                                ? 'bg-blue-600 border-blue-600'
                                : 'bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600'
                            }`}>
                              {selectedFileIds.has(file.id) && (
                                <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                </svg>
                              )}
                            </div>
                          </td>
                        )}
                        <td className="px-4 py-4 text-sm text-gray-500 dark:text-gray-400">{index + 1}</td>
                        <td className="px-4 py-4">
                          <div className="flex items-center gap-3">
                            <span className="text-2xl">{getFileIcon(file.mimeType)}</span>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-charcoal dark:text-gray-200 truncate" title={file.name}>
                                {file.name}
                              </p>
                              <p className="text-xs text-gray-500 dark:text-gray-400">ID: {file.id.substring(0, 8)}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-4 text-sm text-gray-600 dark:text-gray-400">
                          {currentMatter?.name || file.case_name || '-'}
                        </td>
                        <td className="px-4 py-4 text-sm text-gray-500 dark:text-gray-400">{formatFileSize(file.size)}</td>
                        <td className="px-4 py-4">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {getStatusBadge(file.status, file.processing_stage)}
                            {getClassificationBadge(file.classification)}
                            {getLinkStatusIndicator(file.link_status, file.match_score)}
                          </div>
                        </td>
                        <td className="px-4 py-4 text-right">
                          {!matterIsReadOnly && (
                            <div className="flex items-center justify-end gap-1">
                              <button
                                onClick={(e) => { e.stopPropagation(); openMoveForFile(file.id); }}
                                className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 transition-colors"
                                title="Move to..."
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                                </svg>
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDeleteFileUnified(file.id); }}
                                className="p-1.5 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400 transition-colors"
                                title="Delete file"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            </div>
          </div>
        )}

        </div>{/* end slide animation wrapper */}

        {/* Create Matter Modal */}
        {showCreateMatterModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 animate-backdrop-in">
            <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-md animate-scale-in">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-gray-900 dark:text-white">Create New Matter</h2>
                <button onClick={() => { setShowCreateMatterModal(false); setMatterFormErrors({}); setDuplicateNameWarning(false); }} className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Matter Name *</label>
                  <input
                    type="text"
                    value={newMatterName}
                    onChange={(e) => {
                      setNewMatterName(e.target.value);
                      setMatterFormErrors(prev => ({ ...prev, name: undefined }));
                      // Check for duplicate name
                      const exists = cases.some(c => c.name.toLowerCase() === e.target.value.trim().toLowerCase());
                      setDuplicateNameWarning(exists);
                    }}
                    className={`w-full px-3 py-2 border ${matterFormErrors.name ? 'border-red-500' : 'border-gray-300 dark:border-gray-600'} bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent`}
                    placeholder="e.g., Smith v. Jones"
                  />
                  {matterFormErrors.name && (
                    <p className="text-xs text-red-500 mt-1">{matterFormErrors.name}</p>
                  )}
                  {duplicateNameWarning && !matterFormErrors.name && (
                    <p className="text-xs text-yellow-600 dark:text-yellow-400 mt-1 flex items-center gap-1">
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
                      A matter with this name already exists. You can still create it.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Matter Type *</label>
                  <div className="relative">
                    <select
                      value={newMatterType}
                      onChange={(e) => {
                        setNewMatterType(e.target.value as MatterType | '');
                        setMatterFormErrors(prev => ({ ...prev, type: undefined }));
                      }}
                      className={`w-full appearance-none px-3 py-2 pr-8 border ${matterFormErrors.type ? 'border-red-500' : 'border-gray-300 dark:border-gray-600'} bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent`}
                    >
                      <option value="">Select matter type</option>
                      {MATTER_TYPES.map(t => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                    <svg className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                  {matterFormErrors.type && (
                    <p className="text-xs text-red-500 mt-1">{matterFormErrors.type}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Client Name</label>
                  <input
                    type="text"
                    value={newMatterClientName}
                    onChange={(e) => setNewMatterClientName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="Client name (optional)"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
                  <textarea
                    value={newMatterDescription}
                    onChange={(e) => setNewMatterDescription(e.target.value)}
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="Brief description (optional)"
                  />
                </div>
              </div>
              <div className="flex gap-3 mt-6">
                <button
                  onClick={() => { setShowCreateMatterModal(false); setMatterFormErrors({}); setDuplicateNameWarning(false); }}
                  disabled={isCreatingMatter}
                  className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateMatter}
                  disabled={isCreatingMatter}
                  className={`flex-1 px-4 py-2 rounded-lg transition-colors flex items-center justify-center gap-2 ${
                    isCreatingMatter
                      ? 'bg-gray-400 cursor-not-allowed text-gray-200'
                      : 'bg-gray-700 dark:bg-gray-600 text-white hover:bg-gray-800 dark:hover:bg-gray-500'
                  }`}
                >
                  {isCreatingMatter ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      Creating...
                    </>
                  ) : 'Create Matter'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Create Folder Modal */}
        {showCreateFolderModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 animate-backdrop-in">
            <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-md animate-scale-in">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-gray-900 dark:text-white">Create Folder</h2>
                <button onClick={() => setShowCreateFolderModal(false)} className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {currentMatter && (
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">in {currentMatter.name}</p>
              )}
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Folder Name *</label>
                  <input
                    type="text"
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="e.g., Discovery"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Folder Type</label>
                  <select
                    value={newFolderType}
                    onChange={(e) => setNewFolderType(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="">Select type</option>
                    <option value="Discovery">Discovery</option>
                    <option value="Pleadings">Pleadings</option>
                    <option value="Evidence">Evidence</option>
                    <option value="Correspondence">Correspondence</option>
                    <option value="Contracts">Contracts</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
                  <textarea
                    value={newFolderDescription}
                    onChange={(e) => setNewFolderDescription(e.target.value)}
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="Brief folder description"
                  />
                </div>
              </div>
              <div className="flex gap-3 mt-6">
                <button
                  onClick={() => setShowCreateFolderModal(false)}
                  disabled={isCreatingFolder}
                  className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateFolder}
                  disabled={isCreatingFolder || !newFolderName.trim()}
                  className={`flex-1 px-4 py-2 rounded-lg transition-colors flex items-center justify-center gap-2 ${
                    isCreatingFolder || !newFolderName.trim()
                      ? 'bg-gray-400 cursor-not-allowed text-gray-200'
                      : 'bg-gray-700 dark:bg-gray-600 text-white hover:bg-gray-800 dark:hover:bg-gray-500'
                  }`}
                >
                  {isCreatingFolder ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      Creating...
                    </>
                  ) : 'Create Folder'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Move Items Modal — Enterprise Tree Picker */}
        {showMoveModal && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 animate-backdrop-in">
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-lg animate-scale-in border border-gray-200 dark:border-gray-700">
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Move to</h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {selectedFolderIds.size > 0 && selectedFileIds.size > 0
                      ? `${selectedFolderIds.size} folder(s), ${selectedFileIds.size} file(s)`
                      : selectedFolderIds.size > 0
                        ? `${selectedFolderIds.size} folder(s) and all contents`
                        : `${selectedFileIds.size} file(s)`}
                  </p>
                </div>
                <button onClick={() => { setShowMoveModal(false); setMoveTargetMatterId(''); setMoveTargetFolderId(null); }} className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Tree Body */}
              <div className="max-h-[400px] overflow-y-auto px-3 py-3">
                {cases.filter(c => c.status !== 'archived').map(matter => {
                  const isExpanded = expandedMoveMatters.has(matter.id);
                  const matterFolders = folders.filter(f => f.case_id === matter.id && !f.parent_folder_id);
                  const isSelectedMatter = moveTargetMatterId === matter.id && !moveTargetFolderId;
                  const isCurrent = matter.id === currentMatter?.id;

                  // Recursive folder renderer
                  const renderFolderTree = (parentFolders: Folder[], depth: number = 1): React.ReactNode => {
                    return parentFolders.map(folder => {
                      // Don't allow moving a folder into itself
                      if (selectedFolderIds.has(folder.id)) return null;
                      const childFolders = folders.filter(f => f.case_id === matter.id && f.parent_folder_id === folder.id);
                      const isSelectedFolder = moveTargetMatterId === matter.id && moveTargetFolderId === folder.id;

                      return (
                        <div key={folder.id}>
                          <button
                            onClick={() => {
                              setMoveTargetMatterId(matter.id);
                              setMoveTargetFolderId(folder.id);
                            }}
                            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-all duration-150 ${
                              isSelectedFolder
                                ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 ring-1 ring-blue-300 dark:ring-blue-700'
                                : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                            }`}
                            style={{ paddingLeft: `${depth * 20 + 12}px` }}
                          >
                            <svg className="w-4 h-4 text-yellow-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                              <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                            </svg>
                            <span className="truncate">{folder.name}</span>
                            {isSelectedFolder && (
                              <svg className="w-4 h-4 text-blue-600 ml-auto flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                              </svg>
                            )}
                          </button>
                          {childFolders.length > 0 && renderFolderTree(childFolders, depth + 1)}
                        </div>
                      );
                    });
                  };

                  return (
                    <div key={matter.id} className="mb-1">
                      {/* Matter Row */}
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => {
                            setExpandedMoveMatters(prev => {
                              const next = new Set(prev);
                              if (next.has(matter.id)) next.delete(matter.id);
                              else next.add(matter.id);
                              return next;
                            });
                          }}
                          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                        >
                          <svg className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`} fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                          </svg>
                        </button>
                        <button
                          onClick={() => {
                            setMoveTargetMatterId(matter.id);
                            setMoveTargetFolderId(null);
                            if (!isExpanded) {
                              setExpandedMoveMatters(prev => new Set([...prev, matter.id]));
                            }
                          }}
                          className={`flex-1 flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 ${
                            isSelectedMatter
                              ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 ring-1 ring-blue-300 dark:ring-blue-700'
                              : 'text-gray-900 dark:text-white hover:bg-gray-50 dark:hover:bg-gray-700'
                          }`}
                        >
                          <svg className={`w-5 h-5 flex-shrink-0 ${isCurrent ? 'text-green-500' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                          </svg>
                          <span className="truncate">{matter.name}</span>
                          {isCurrent && (
                            <span className="text-[10px] font-normal text-gray-400 ml-auto flex-shrink-0">current</span>
                          )}
                          {isSelectedMatter && (
                            <svg className="w-4 h-4 text-blue-600 ml-auto flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                            </svg>
                          )}
                        </button>
                      </div>

                      {/* Expanded folder tree */}
                      {isExpanded && matterFolders.length > 0 && (
                        <div className="ml-6 mt-0.5">
                          {renderFolderTree(matterFolders)}
                        </div>
                      )}
                      {isExpanded && matterFolders.length === 0 && (
                        <p className="ml-12 py-1.5 text-xs text-gray-400 italic">No folders — items will be placed at root</p>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Selected destination preview */}
              {moveTargetMatterId && (
                <div className="mx-6 mb-3 px-3 py-2 bg-gray-50 dark:bg-gray-700/50 rounded-lg flex items-center gap-2">
                  <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  <span className="text-xs text-gray-600 dark:text-gray-300 truncate">
                    {cases.find(c => c.id === moveTargetMatterId)?.name}
                    {moveTargetFolderId && ` / ${folders.find(f => f.id === moveTargetFolderId)?.name}`}
                  </span>
                </div>
              )}

              {/* Footer */}
              <div className="flex gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700">
                <button
                  onClick={() => { setShowMoveModal(false); setMoveTargetMatterId(''); setMoveTargetFolderId(null); }}
                  disabled={isMoving}
                  className="flex-1 px-4 py-2.5 text-sm font-medium border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleMoveItems}
                  disabled={isMoving || !moveTargetMatterId}
                  className={`flex-1 px-4 py-2.5 rounded-lg transition-all duration-200 flex items-center justify-center gap-2 text-sm font-medium ${
                    isMoving || !moveTargetMatterId
                      ? 'bg-gray-300 dark:bg-gray-600 cursor-not-allowed text-gray-500'
                      : 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm hover:shadow'
                  }`}
                >
                  {isMoving ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      Moving...
                    </>
                  ) : 'Move here'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Upload Files Modal */}
        {showUploadModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 animate-backdrop-in">
            <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-md max-h-[90vh] overflow-y-auto animate-scale-in">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-gray-900 dark:text-white">Upload Files</h2>
                <button onClick={() => setShowUploadModal(false)} className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Matter *</label>
                  {!showInlineMatterCreate ? (
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <select
                          value={selectedMatter}
                          onChange={(e) => {
                            setSelectedMatter(e.target.value);
                            setSelectedFolder(''); // Clear folder when case changes
                          }}
                          className="w-full appearance-none px-3 py-2 pr-8 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        >
                          <option value="">Select matter</option>
                          {cases.filter(c => c.status === 'active').map(c => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                        <svg className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                      <button
                        onClick={() => setShowInlineMatterCreate(true)}
                        className="px-3 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-900 dark:text-white rounded-lg text-sm"
                        title="Create new case"
                      >
                        +
                      </button>
                    </div>
                  ) : (
                    <div className="border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3">
                      <input
                        type="text"
                        value={newMatterName}
                        onChange={(e) => setNewMatterName(e.target.value)}
                        className="w-full px-3 py-2 mb-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg"
                        placeholder="New matter name"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => setShowInlineMatterCreate(false)}
                          className="flex-1 px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded hover:bg-gray-50 dark:hover:bg-gray-600"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleCreateMatter}
                          className="flex-1 px-3 py-1 text-sm bg-gray-700 dark:bg-gray-600 text-white rounded hover:bg-gray-800 dark:hover:bg-gray-500"
                        >
                          Create
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Folder <span className="text-gray-400 dark:text-gray-500">(optional)</span>
                  </label>
                  {!showInlineFolderCreate ? (
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <select
                          value={selectedFolder}
                          onChange={(e) => setSelectedFolder(e.target.value)}
                          className="w-full appearance-none px-3 py-2 pr-8 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          disabled={!selectedMatter}
                        >
                          <option value="">Matter root (no folder)</option>
                          {folders.filter(f => f.case_id === selectedMatter).map(f => (
                            <option key={f.id} value={f.id}>{f.name}</option>
                          ))}
                        </select>
                        <svg className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                      <button
                        onClick={() => setShowInlineFolderCreate(true)}
                        disabled={!selectedMatter}
                        className="px-3 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-900 dark:text-white rounded-lg text-sm disabled:opacity-50"
                        title="Create new folder"
                      >
                        +
                      </button>
                    </div>
                  ) : (
                    <div className="border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3">
                      <input
                        type="text"
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        className="w-full px-3 py-2 mb-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg"
                        placeholder="New folder name"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => setShowInlineFolderCreate(false)}
                          className="flex-1 px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded hover:bg-gray-50 dark:hover:bg-gray-600"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleCreateFolder}
                          className="flex-1 px-3 py-1 text-sm bg-gray-700 dark:bg-gray-600 text-white rounded hover:bg-gray-800 dark:hover:bg-gray-500"
                        >
                          Create
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Upload Documents</label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept={[...ALLOWED_MIME_TYPES, '.msg'].join(',')}
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                  <input
                    ref={folderInputRef}
                    type="file"
                    multiple
                    // @ts-ignore
                    webkitdirectory=""
                    directory=""
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <div
                      onClick={() => fileInputRef.current?.click()}
                      className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-4 text-center cursor-pointer hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                    >
                      <svg className="mx-auto h-8 w-8 text-gray-400 dark:text-gray-500 mb-2" stroke="currentColor" fill="none" viewBox="0 0 48 48">
                        <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <p className="text-sm text-gray-700 dark:text-gray-300 font-medium">Files</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Individual files</p>
                    </div>
                    <div
                      onClick={() => folderInputRef.current?.click()}
                      className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-4 text-center cursor-pointer hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                    >
                      <svg className="mx-auto h-8 w-8 text-gray-400 dark:text-gray-500 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a4 4 0 004 4h10a4 4 0 004-4V7a4 4 0 00-4-4H7a4 4 0 00-4 4z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9l4 4-4 4" />
                      </svg>
                      <p className="text-sm text-gray-700 dark:text-gray-300 font-medium">Folder</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">With structure</p>
                    </div>
                  </div>
                  {uploadFiles.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {uploadFiles.map((file, i) => (
                        <p key={i} className="text-xs text-gray-600 dark:text-gray-400">
                          {file.name} ({formatFileSize(file.size)})
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex gap-3 mt-6">
                <button
                  onClick={() => setShowUploadModal(false)}
                  disabled={isUploading}
                  className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleUploadSubmit}
                  className={`flex-1 px-4 py-2 rounded-lg transition-colors flex items-center justify-center gap-2 ${
                    isUploading || !selectedMatter || uploadFiles.length === 0
                      ? 'bg-gray-400 cursor-not-allowed text-gray-200'
                      : 'bg-gray-700 dark:bg-gray-600 text-white hover:bg-gray-800 dark:hover:bg-gray-500'
                  }`}
                  disabled={isUploading || !selectedMatter || uploadFiles.length === 0}
                >
                  {isUploading ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      Uploading...
                    </>
                  ) : 'Upload'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Delete Matter Confirmation Modal */}
        {deleteConfirmMatter && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 animate-backdrop-in">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-md w-full mx-4 animate-scale-in">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                  <svg className="w-5 h-5 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Delete Matter</h3>
              </div>
              
              <p className="text-gray-600 dark:text-gray-400 mb-2">
                Are you sure you want to delete <strong>"{deleteConfirmMatter.name}"</strong>?
              </p>
              <p className="text-sm text-red-600 dark:text-red-400 mb-4">
                ⚠️ This will permanently delete all folders and files inside this matter. This action cannot be undone.
              </p>
              
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Type <span className="font-mono bg-gray-100 dark:bg-gray-700 px-1 rounded">DELETE</span> to confirm
                </label>
                <input
                  type="text"
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  placeholder="DELETE"
                />
              </div>
              
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setDeleteConfirmMatter(null);
                    setDeleteConfirmText('');
                  }}
                  className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDeleteMatter}
                  disabled={deleteConfirmText !== 'DELETE' || isLoading}
                  className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isLoading ? 'Deleting...' : 'Delete Matter'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>

    {/* Edit Matter Drawer */}
    {currentMatter && (
      <EditMatterDrawer
        matter={currentMatter}
        open={showEditDrawer}
        onClose={() => setShowEditDrawer(false)}
      />
    )}
    </>
  );
};

export default Vault;
