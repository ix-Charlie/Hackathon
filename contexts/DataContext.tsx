/**
 * Global Data Context for Horizon
 * 
 * Provides centralized state management with:
 * - Shared cache across all components
 * - Stale-while-revalidate pattern
 * - Automatic background refresh
 * - Optimistic updates
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { Case, Folder, UploadedFile } from '../types';
import * as caseService from '../services/caseService';
import * as folderService from '../services/folderService';
import * as fileService from '../services/fileService';
import * as cache from '../services/cacheService';

// --- Types ---

interface DataContextState {
  // Data
  
  cases: Case[];
  folders: Folder[];
  files: UploadedFile[];
  
  // Loading states
  isLoadingCases: boolean;
  isLoadingFolders: boolean;
  isLoadingFiles: boolean;
  isInitialLoad: boolean;
  
  // Background sync indicators
  isSyncingCases: boolean;
  isSyncingFolders: boolean;
  isSyncingFiles: boolean;
  
  // Actions
  refreshCases: (force?: boolean) => Promise<void>;
  refreshFolders: (force?: boolean) => Promise<void>;
  refreshFiles: (force?: boolean) => Promise<void>;
  refreshAll: (force?: boolean) => Promise<void>;
  
  // Optimistic updates
  addCase: (newCase: Case) => void;
  updateCase: (caseId: string, updates: Partial<Case>) => void;
  removeCase: (caseId: string) => void;
  
  addFolder: (folder: Folder) => void;
  updateFolder: (folderId: string, updates: Partial<Folder>) => void;
  removeFolder: (folderId: string) => void;
  
  addFile: (file: UploadedFile) => void;
  updateFile: (fileId: string, updates: Partial<UploadedFile>) => void;
  removeFile: (fileId: string) => void;
  
  // Invalidation
  invalidateAll: () => void;
}

const DataContext = createContext<DataContextState | null>(null);

// --- Provider ---

interface DataProviderProps {
  children: React.ReactNode;
  userId: string | null;
}

export const DataProvider: React.FC<DataProviderProps> = ({ children, userId }) => {
  // Initialize state from cache
  const [cases, setCases] = useState<Case[]>(() => cache.getCachedCases().data || []);
  const [folders, setFolders] = useState<Folder[]>(() => cache.getCachedFolders().data || []);
  const [files, setFiles] = useState<UploadedFile[]>(() => {
    const cached = cache.getCachedFiles().data;
    return cached ? fileService.documentFilesToUploadedFiles(cached) : [];
  });
  
  // Loading states
  const [isLoadingCases, setIsLoadingCases] = useState(false);
  const [isLoadingFolders, setIsLoadingFolders] = useState(false);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  
  // Background sync states
  const [isSyncingCases, setIsSyncingCases] = useState(false);
  const [isSyncingFolders, setIsSyncingFolders] = useState(false);
  const [isSyncingFiles, setIsSyncingFiles] = useState(false);
  
  // Refs for tracking fetch state
  const fetchingRef = useRef({ cases: false, folders: false, files: false });
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  
  // --- Fetch Functions ---
  
  const refreshCases = useCallback(async (force = false) => {
    if (fetchingRef.current.cases) return;
    
    const { status } = cache.getCachedCases();
    
    // Determine if we need to show loading or just sync in background
    const needsLoading = force || cache.shouldRefetch(status);
    const needsBackgroundSync = cache.shouldBackgroundRefetch(status);
    
    if (!needsLoading && !needsBackgroundSync) return;
    
    fetchingRef.current.cases = true;
    
    if (needsLoading && cases.length === 0) {
      setIsLoadingCases(true);
    } else {
      setIsSyncingCases(true);
    }
    
    try {
      const fetchedCases = await caseService.fetchCases();
      setCases(fetchedCases);
      cache.setCachedCases(fetchedCases);
    } catch (err) {
      console.error('Error fetching cases:', err);
    } finally {
      setIsLoadingCases(false);
      setIsSyncingCases(false);
      fetchingRef.current.cases = false;
    }
  }, [cases.length]);
  
  const refreshFolders = useCallback(async (force = false) => {
    if (fetchingRef.current.folders) return;
    
    const { status } = cache.getCachedFolders();
    const needsLoading = force || cache.shouldRefetch(status);
    const needsBackgroundSync = cache.shouldBackgroundRefetch(status);
    
    if (!needsLoading && !needsBackgroundSync) return;
    
    fetchingRef.current.folders = true;
    
    if (needsLoading && folders.length === 0) {
      setIsLoadingFolders(true);
    } else {
      setIsSyncingFolders(true);
    }
    
    try {
      const fetchedFolders = await folderService.fetchFolders();
      setFolders(fetchedFolders);
      cache.setCachedFolders(fetchedFolders);
    } catch (err) {
      console.error('Error fetching folders:', err);
    } finally {
      setIsLoadingFolders(false);
      setIsSyncingFolders(false);
      fetchingRef.current.folders = false;
    }
  }, [folders.length]);
  
  const refreshFiles = useCallback(async (force = false) => {
    if (fetchingRef.current.files) return;
    
    const { status } = cache.getCachedFiles();
    const needsLoading = force || cache.shouldRefetch(status);
    const needsBackgroundSync = cache.shouldBackgroundRefetch(status);
    
    if (!needsLoading && !needsBackgroundSync) return;
    
    fetchingRef.current.files = true;
    
    if (needsLoading && files.length === 0) {
      setIsLoadingFiles(true);
    } else {
      setIsSyncingFiles(true);
    }
    
    try {
      const fetchedFiles = await fileService.fetchFiles();
      const converted = fileService.documentFilesToUploadedFiles(fetchedFiles);
      setFiles(converted);
      cache.setCachedFiles(fetchedFiles);
    } catch (err) {
      console.error('Error fetching files:', err);
    } finally {
      setIsLoadingFiles(false);
      setIsSyncingFiles(false);
      fetchingRef.current.files = false;
    }
  }, [files.length]);
  
  const refreshAll = useCallback(async (force = false) => {
    await Promise.all([
      refreshCases(force),
      refreshFolders(force),
      refreshFiles(force),
    ]);
  }, [refreshCases, refreshFolders, refreshFiles]);
  
  // --- Initial Load ---
  
  useEffect(() => {
    if (!userId) {
      // User logged out - clear everything
      cache.invalidateAll();
      setCases([]);
      setFolders([]);
      setFiles([]);
      setIsInitialLoad(true);
      return;
    }
    
    // User is logged in - load data
    const loadInitialData = async () => {
      await refreshAll(false);
      setIsInitialLoad(false);
    };
    
    loadInitialData();
  }, [userId]);
  
  // --- Polling for processing files ---
  
  useEffect(() => {
    const hasProcessingFiles = files.some(
      f => f.status === 'processing' || f.status === 'uploaded'
    );
    
    if (hasProcessingFiles && !pollingRef.current) {
      pollingRef.current = setInterval(() => {
        refreshFiles(true);
      }, 1500); // 1.5s polling for faster stage updates (only when processing)
    } else if (!hasProcessingFiles && pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [files, refreshFiles]);
  
  // --- Optimistic Updates ---
  
  const addCase = useCallback((newCase: Case) => {
    setCases(prev => [newCase, ...prev]);
    cache.optimisticAddCase(newCase);
  }, []);
  
  const updateCase = useCallback((caseId: string, updates: Partial<Case>) => {
    setCases(prev => prev.map(c => c.id === caseId ? { ...c, ...updates } : c));
    // Refresh to ensure consistency
    setTimeout(() => refreshCases(true), 100);
  }, [refreshCases]);
  
  const removeCase = useCallback((caseId: string) => {
    setCases(prev => prev.filter(c => c.id !== caseId));
    cache.optimisticRemoveCase(caseId);
  }, []);
  
  const addFolder = useCallback((folder: Folder) => {
    setFolders(prev => [folder, ...prev]);
  }, []);
  
  const updateFolder = useCallback((folderId: string, updates: Partial<Folder>) => {
    setFolders(prev => prev.map(f => f.id === folderId ? { ...f, ...updates } : f));
  }, []);
  
  const removeFolder = useCallback((folderId: string) => {
    setFolders(prev => prev.filter(f => f.id !== folderId));
  }, []);
  
  const addFile = useCallback((file: UploadedFile) => {
    setFiles(prev => [file, ...prev]);
    cache.optimisticAddFile(file);
  }, []);
  
  const updateFile = useCallback((fileId: string, updates: Partial<UploadedFile>) => {
    setFiles(prev => prev.map(f => f.id === fileId ? { ...f, ...updates } : f));
    cache.optimisticUpdateFile(fileId, updates);
  }, []);
  
  const removeFile = useCallback((fileId: string) => {
    setFiles(prev => prev.filter(f => f.id !== fileId));
    cache.optimisticRemoveFile(fileId);
  }, []);
  
  const invalidateAll = useCallback(() => {
    cache.invalidateAll();
    refreshAll(true);
  }, [refreshAll]);
  
  // --- Context Value ---
  
  const value: DataContextState = {
    cases,
    folders,
    files,
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
    refreshAll,
    addCase,
    updateCase,
    removeCase,
    addFolder,
    updateFolder,
    removeFolder,
    addFile,
    updateFile,
    removeFile,
    invalidateAll,
  };
  
  return (
    <DataContext.Provider value={value}>
      {children}
    </DataContext.Provider>
  );
};

// --- Hook ---

export function useData(): DataContextState {
  const context = useContext(DataContext);
  if (!context) {
    throw new Error('useData must be used within a DataProvider');
  }
  return context;
}

// --- Convenience Hooks ---

export function useCases() {
  const { cases, isLoadingCases, isSyncingCases, refreshCases, addCase, updateCase, removeCase } = useData();
  return { cases, isLoading: isLoadingCases, isSyncing: isSyncingCases, refresh: refreshCases, add: addCase, update: updateCase, remove: removeCase };
}

export function useFolders() {
  const { folders, isLoadingFolders, isSyncingFolders, refreshFolders, addFolder, updateFolder, removeFolder } = useData();
  return { folders, isLoading: isLoadingFolders, isSyncing: isSyncingFolders, refresh: refreshFolders, add: addFolder, update: updateFolder, remove: removeFolder };
}

export function useFiles() {
  const { files, isLoadingFiles, isSyncingFiles, refreshFiles, addFile, updateFile, removeFile } = useData();
  return { files, isLoading: isLoadingFiles, isSyncing: isSyncingFiles, refresh: refreshFiles, add: addFile, update: updateFile, remove: removeFile };
}

/**
 * Get files for a specific case
 */
export function useCaseFiles(caseId: string | null) {
  const { files, isLoadingFiles, isSyncingFiles } = useData();
  
  const caseFiles = caseId 
    ? files.filter(f => f.case_id === caseId)
    : [];
  
  return { files: caseFiles, isLoading: isLoadingFiles, isSyncing: isSyncingFiles };
}

/**
 * Get files for a specific folder
 */
export function useFolderFiles(folderId: string | null) {
  const { files, isLoadingFiles, isSyncingFiles } = useData();
  
  const folderFiles = folderId
    ? files.filter(f => f.folder_id === folderId)
    : [];
  
  return { files: folderFiles, isLoading: isLoadingFiles, isSyncing: isSyncingFiles };
}
