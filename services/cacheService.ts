/**
 * Production-grade caching layer for Horizon
 * 
 * Features:
 * - In-memory cache with localStorage persistence
 * - Stale-while-revalidate pattern
 * - TTL-based expiration
 * - Background refresh
 * - Cache invalidation on mutations
 */

// Cache configuration
const CACHE_CONFIG = {
  // How long data is considered "fresh" (no background fetch needed)
  FRESH_TTL_MS: 30 * 1000, // 30 seconds
  
  // How long data is usable (stale but still show it, fetch in background)
  STALE_TTL_MS: 5 * 60 * 1000, // 5 minutes
  
  // How long to persist in localStorage
  PERSIST_TTL_MS: 24 * 60 * 60 * 1000, // 24 hours
  
  // Storage key prefix
  PREFIX: 'horizon_cache_',
} as const;

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  version: number;
}

export interface CacheState {
  cases: CacheEntry<any[]> | null;
  folders: CacheEntry<any[]> | null;
  files: CacheEntry<any[]> | null;
  // Per-case file cache
  caseFiles: Map<string, CacheEntry<any[]>>;
  // Per-folder file cache  
  folderFiles: Map<string, CacheEntry<any[]>>;
}

// In-memory cache (fastest)
const memoryCache: CacheState = {
  cases: null,
  folders: null,
  files: null,
  caseFiles: new Map(),
  folderFiles: new Map(),
};

// Cache version for invalidation
let cacheVersion = 1;

// --- Storage Helpers ---

function getStorageKey(key: string): string {
  return `${CACHE_CONFIG.PREFIX}${key}`;
}

function saveToStorage<T>(key: string, data: T): void {
  try {
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      version: cacheVersion,
    };
    localStorage.setItem(getStorageKey(key), JSON.stringify(entry));
  } catch (e) {
    console.warn('Cache save failed:', e);
  }
}

function loadFromStorage<T>(key: string): CacheEntry<T> | null {
  try {
    const raw = localStorage.getItem(getStorageKey(key));
    if (!raw) return null;
    
    const entry: CacheEntry<T> = JSON.parse(raw);
    
    // Check if expired
    if (Date.now() - entry.timestamp > CACHE_CONFIG.PERSIST_TTL_MS) {
      localStorage.removeItem(getStorageKey(key));
      return null;
    }
    
    return entry;
  } catch (e) {
    return null;
  }
}

// --- Cache State Helpers ---

export type CacheStatus = 'fresh' | 'stale' | 'expired' | 'empty';

function getCacheStatus<T>(entry: CacheEntry<T> | null): CacheStatus {
  if (!entry) return 'empty';
  
  const age = Date.now() - entry.timestamp;
  
  if (age < CACHE_CONFIG.FRESH_TTL_MS) return 'fresh';
  if (age < CACHE_CONFIG.STALE_TTL_MS) return 'stale';
  return 'expired';
}

// --- Public API ---

/**
 * Get cached cases with status
 */
export function getCachedCases(): { data: any[] | null; status: CacheStatus } {
  // Try memory first
  if (memoryCache.cases) {
    return { 
      data: memoryCache.cases.data, 
      status: getCacheStatus(memoryCache.cases) 
    };
  }
  
  // Try localStorage
  const stored = loadFromStorage<any[]>('cases');
  if (stored) {
    memoryCache.cases = stored;
    return { data: stored.data, status: getCacheStatus(stored) };
  }
  
  return { data: null, status: 'empty' };
}

/**
 * Set cached cases
 */
export function setCachedCases(cases: any[]): void {
  const entry: CacheEntry<any[]> = {
    data: cases,
    timestamp: Date.now(),
    version: cacheVersion,
  };
  memoryCache.cases = entry;
  saveToStorage('cases', cases);
}

/**
 * Get cached folders with status
 */
export function getCachedFolders(): { data: any[] | null; status: CacheStatus } {
  if (memoryCache.folders) {
    return { 
      data: memoryCache.folders.data, 
      status: getCacheStatus(memoryCache.folders) 
    };
  }
  
  const stored = loadFromStorage<any[]>('folders');
  if (stored) {
    memoryCache.folders = stored;
    return { data: stored.data, status: getCacheStatus(stored) };
  }
  
  return { data: null, status: 'empty' };
}

/**
 * Set cached folders
 */
export function setCachedFolders(folders: any[]): void {
  const entry: CacheEntry<any[]> = {
    data: folders,
    timestamp: Date.now(),
    version: cacheVersion,
  };
  memoryCache.folders = entry;
  saveToStorage('folders', folders);
}

/**
 * Get cached files with status
 */
export function getCachedFiles(): { data: any[] | null; status: CacheStatus } {
  if (memoryCache.files) {
    return { 
      data: memoryCache.files.data, 
      status: getCacheStatus(memoryCache.files) 
    };
  }
  
  const stored = loadFromStorage<any[]>('files');
  if (stored) {
    memoryCache.files = stored;
    return { data: stored.data, status: getCacheStatus(stored) };
  }
  
  return { data: null, status: 'empty' };
}

/**
 * Set cached files
 */
export function setCachedFiles(files: any[]): void {
  const entry: CacheEntry<any[]> = {
    data: files,
    timestamp: Date.now(),
    version: cacheVersion,
  };
  memoryCache.files = entry;
  saveToStorage('files', files);
}

/**
 * Get cached files for a specific case
 */
export function getCachedCaseFiles(caseId: string): { data: any[] | null; status: CacheStatus } {
  const entry = memoryCache.caseFiles.get(caseId);
  if (entry) {
    return { data: entry.data, status: getCacheStatus(entry) };
  }
  
  const stored = loadFromStorage<any[]>(`case_files_${caseId}`);
  if (stored) {
    memoryCache.caseFiles.set(caseId, stored);
    return { data: stored.data, status: getCacheStatus(stored) };
  }
  
  return { data: null, status: 'empty' };
}

/**
 * Set cached files for a specific case
 */
export function setCachedCaseFiles(caseId: string, files: any[]): void {
  const entry: CacheEntry<any[]> = {
    data: files,
    timestamp: Date.now(),
    version: cacheVersion,
  };
  memoryCache.caseFiles.set(caseId, entry);
  saveToStorage(`case_files_${caseId}`, files);
}

// --- Invalidation ---

/**
 * Invalidate all caches (e.g., after logout)
 */
export function invalidateAll(): void {
  cacheVersion++;
  memoryCache.cases = null;
  memoryCache.folders = null;
  memoryCache.files = null;
  memoryCache.caseFiles.clear();
  memoryCache.folderFiles.clear();
  
  // Clear localStorage
  Object.keys(localStorage).forEach(key => {
    if (key.startsWith(CACHE_CONFIG.PREFIX)) {
      localStorage.removeItem(key);
    }
  });
}

/**
 * Invalidate cases cache (after create/update/delete)
 */
export function invalidateCases(): void {
  memoryCache.cases = null;
  localStorage.removeItem(getStorageKey('cases'));
}

/**
 * Invalidate folders cache
 */
export function invalidateFolders(): void {
  memoryCache.folders = null;
  localStorage.removeItem(getStorageKey('folders'));
}

/**
 * Invalidate files cache
 */
export function invalidateFiles(): void {
  memoryCache.files = null;
  localStorage.removeItem(getStorageKey('files'));
  memoryCache.caseFiles.clear();
  memoryCache.folderFiles.clear();
}

/**
 * Invalidate files for a specific case
 */
export function invalidateCaseFiles(caseId: string): void {
  memoryCache.caseFiles.delete(caseId);
  localStorage.removeItem(getStorageKey(`case_files_${caseId}`));
}

// --- Optimistic Updates ---

/**
 * Optimistically add a case to cache
 */
export function optimisticAddCase(newCase: any): void {
  const { data } = getCachedCases();
  if (data) {
    setCachedCases([newCase, ...data]);
  }
}

/**
 * Optimistically remove a case from cache
 */
export function optimisticRemoveCase(caseId: string): void {
  const { data } = getCachedCases();
  if (data) {
    setCachedCases(data.filter(c => c.id !== caseId));
  }
}

/**
 * Optimistically add a file to cache
 */
export function optimisticAddFile(newFile: any): void {
  const { data } = getCachedFiles();
  if (data) {
    setCachedFiles([newFile, ...data]);
  }
  
  // Also update case-specific cache
  if (newFile.case_id) {
    const caseFiles = getCachedCaseFiles(newFile.case_id);
    if (caseFiles.data) {
      setCachedCaseFiles(newFile.case_id, [newFile, ...caseFiles.data]);
    }
  }
}

/**
 * Optimistically update a file in cache
 */
export function optimisticUpdateFile(fileId: string, updates: Partial<any>): void {
  const { data } = getCachedFiles();
  if (data) {
    setCachedFiles(data.map(f => f.id === fileId ? { ...f, ...updates } : f));
  }
}

/**
 * Optimistically remove a file from cache
 */
export function optimisticRemoveFile(fileId: string): void {
  const { data } = getCachedFiles();
  if (data) {
    const file = data.find(f => f.id === fileId);
    setCachedFiles(data.filter(f => f.id !== fileId));
    
    // Also update case-specific cache
    if (file?.case_id) {
      const caseFiles = getCachedCaseFiles(file.case_id);
      if (caseFiles.data) {
        setCachedCaseFiles(file.case_id, caseFiles.data.filter(f => f.id !== fileId));
      }
    }
  }
}

// --- Preloading ---

/**
 * Preload all essential data in background
 * Call this after login
 */
export async function preloadEssentialData(
  fetchCases: () => Promise<any[]>,
  fetchFolders: () => Promise<any[]>,
  fetchFiles: () => Promise<any[]>
): Promise<void> {
  // Run all fetches in parallel
  const [cases, folders, files] = await Promise.all([
    fetchCases().catch(() => []),
    fetchFolders().catch(() => []),
    fetchFiles().catch(() => []),
  ]);
  
  setCachedCases(cases);
  setCachedFolders(folders);
  setCachedFiles(files);
}

/**
 * Check if we should fetch fresh data
 */
export function shouldRefetch(status: CacheStatus): boolean {
  return status === 'empty' || status === 'expired';
}

/**
 * Check if we should fetch in background (stale-while-revalidate)
 */
export function shouldBackgroundRefetch(status: CacheStatus): boolean {
  return status === 'stale';
}

// ═══════════════════════════════════════════════════════════════
// Intelligence Cache — per-matter, per-tab stale-while-revalidate
// ═══════════════════════════════════════════════════════════════

const intelMemoryCache = new Map<string, CacheEntry<any>>();

function intelKey(matterId: string, tab: string): string {
  return `intel_${matterId}_${tab}`;
}

/**
 * Get cached intelligence data for a specific matter + tab
 */
export function getCachedIntelligence<T>(matterId: string, tab: string): { data: T | null; status: CacheStatus } {
  const key = intelKey(matterId, tab);

  // Try memory first (fastest)
  const mem = intelMemoryCache.get(key);
  if (mem) {
    return { data: mem.data as T, status: getCacheStatus(mem) };
  }

  // Try localStorage
  const stored = loadFromStorage<T>(key);
  if (stored) {
    intelMemoryCache.set(key, stored);
    return { data: stored.data, status: getCacheStatus(stored) };
  }

  return { data: null, status: 'empty' };
}

/**
 * Set cached intelligence data for a specific matter + tab
 */
export function setCachedIntelligence<T>(matterId: string, tab: string, data: T): void {
  const key = intelKey(matterId, tab);
  const entry: CacheEntry<T> = {
    data,
    timestamp: Date.now(),
    version: cacheVersion,
  };
  intelMemoryCache.set(key, entry);
  saveToStorage(key, data);
}

/**
 * Invalidate all intelligence cache for a specific matter
 */
export function invalidateIntelligence(matterId: string): void {
  const prefix = intelKey(matterId, '');
  // Clear memory
  for (const key of Array.from(intelMemoryCache.keys())) {
    if (key.startsWith(prefix)) {
      intelMemoryCache.delete(key);
    }
  }
  // Clear localStorage
  const storagePrefix = getStorageKey(prefix);
  Object.keys(localStorage).forEach(key => {
    if (key.startsWith(storagePrefix)) {
      localStorage.removeItem(key);
    }
  });
}

/**
 * Invalidate all intelligence caches (all matters)
 */
export function invalidateAllIntelligence(): void {
  for (const key of Array.from(intelMemoryCache.keys())) {
    if (key.startsWith('intel_')) {
      intelMemoryCache.delete(key);
    }
  }
  const storagePrefix = getStorageKey('intel_');
  Object.keys(localStorage).forEach(key => {
    if (key.startsWith(storagePrefix)) {
      localStorage.removeItem(key);
    }
  });
}
