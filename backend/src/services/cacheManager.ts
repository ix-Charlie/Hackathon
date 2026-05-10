/**
 * Backend Cache Manager for Horizon
 * 
 * In-memory cache with TTL for frequently-accessed data:
 * - Extraction results (per file_id)
 * - Analytical engine outputs (per case_id + engine type)
 * - Matter summaries (per case_id)
 * - Structured data queries (per case_id + intent hash)
 * 
 * Strategy: Cache DB results in memory to avoid repeated Supabase queries.
 * Invalidation: On document re-processing or new extraction.
 * Uses LRU eviction when cache exceeds max entries.
 */

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
  hits: number;
}

interface CacheConfig {
  maxEntries: number;
  defaultTTLMs: number;
}

const DEFAULT_CONFIG: CacheConfig = {
  maxEntries: 500,
  defaultTTLMs: 10 * 60 * 1000, // 10 minutes
};

// TTL presets for different data types
export const CACHE_TTLS = {
  EXTRACTION_RESULTS: 30 * 60 * 1000,  // 30 min — extraction data is stable
  EXTRACTION_EMPTY: 10 * 1000,         // 10 sec — don't cache empty results long (extraction may still be running)
  ANALYTICAL_ENGINE: 15 * 60 * 1000,   // 15 min — analytical results
  MATTER_SUMMARY: 30 * 60 * 1000,      // 30 min — summaries are stable
  STRUCTURED_QUERY: 5 * 60 * 1000,     // 5 min — structured data queries
  ENTITY_LOOKUP: 20 * 60 * 1000,       // 20 min — entity data
} as const;

/**
 * Helper: pick TTL based on whether a result set is empty.
 * Prevents caching empty results for long periods while extraction is running.
 */
export function extractionTTL(count: number): number {
  return count > 0 ? CACHE_TTLS.EXTRACTION_RESULTS : CACHE_TTLS.EXTRACTION_EMPTY;
}

class CacheManager {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private config: CacheConfig;
  private stats = { hits: 0, misses: 0, evictions: 0, sets: 0 };

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get a cached value. Returns undefined if not found or expired.
   */
  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.misses++;
      return undefined;
    }

    entry.hits++;
    this.stats.hits++;
    return entry.data as T;
  }

  /**
   * Set a cached value with optional custom TTL.
   */
  set<T>(key: string, data: T, ttlMs?: number): void {
    // Evict if at capacity
    if (this.cache.size >= this.config.maxEntries && !this.cache.has(key)) {
      this.evictLRU();
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      expiresAt: Date.now() + (ttlMs ?? this.config.defaultTTLMs),
      hits: 0,
    });
    this.stats.sets++;
  }

  /**
   * Invalidate a specific key.
   */
  invalidate(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Invalidate all keys matching a prefix.
   * Use for case-level invalidation (e.g., invalidateByPrefix('case:abc123'))
   */
  invalidateByPrefix(prefix: string): number {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Invalidate all keys matching a pattern function.
   */
  invalidateWhere(predicate: (key: string) => boolean): number {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (predicate(key)) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Get or compute: returns cached value or executes factory and caches result.
   */
  async getOrCompute<T>(key: string, factory: () => Promise<T>, ttlMs?: number): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;

    const result = await factory();
    this.set(key, result, ttlMs);
    return result;
  }

  /**
   * Get cache statistics.
   */
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0
      ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(1)
      : '0.0';

    return {
      ...this.stats,
      hitRate: `${hitRate}%`,
      size: this.cache.size,
      maxEntries: this.config.maxEntries,
    };
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.cache.clear();
    this.stats = { hits: 0, misses: 0, evictions: 0, sets: 0 };
  }

  /**
   * Evict least recently used entry (lowest hits + oldest timestamp).
   */
  private evictLRU(): void {
    let lruKey: string | null = null;
    let lruScore = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      // Score = hits * 1000 + recency (lower = more evictable)
      const recency = entry.timestamp;
      const score = entry.hits * 1000 + recency / 1000000;
      if (score < lruScore) {
        lruScore = score;
        lruKey = key;
      }
    }

    if (lruKey) {
      this.cache.delete(lruKey);
      this.stats.evictions++;
    }
  }
}

// ─── Key Builders ───────────────────────────────────────────────────────────

export function extractionCacheKey(caseId: string, type: string): string {
  return `extraction:${caseId}:${type}`;
}

export function analysisCacheKey(caseId: string, engine: string): string {
  return `analysis:${caseId}:${engine}`;
}

export function summaryCacheKey(caseId: string): string {
  return `summary:${caseId}`;
}

export function structuredQueryCacheKey(caseId: string, intents: string[]): string {
  return `structured:${caseId}:${intents.sort().join(',')}`;
}

export function entityCacheKey(caseId: string, entityType?: string): string {
  return entityType ? `entity:${caseId}:${entityType}` : `entity:${caseId}`;
}

// ─── Singleton Instance ─────────────────────────────────────────────────────

export const backendCache = new CacheManager({
  maxEntries: 1000,
  defaultTTLMs: 10 * 60 * 1000, // 10 minutes
});

export default CacheManager;
