/**
 * Security Middleware for Horizon Backend
 * 
 * Provides:
 * - In-memory rate limiting (per IP and per user)
 * - UUID validation for route params
 * - Input sanitization helpers
 * - Query param validation
 */

import { Request, Response, NextFunction } from 'express';

// ============================================================================
// RATE LIMITING
// ============================================================================

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory rate limit stores (keyed by IP or user ID)
const rateLimitStores: Map<string, Map<string, RateLimitEntry>> = new Map();

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [, store] of rateLimitStores) {
    for (const [key, entry] of store) {
      if (now > entry.resetAt) {
        store.delete(key);
      }
    }
  }
}, 5 * 60 * 1000);

interface RateLimitConfig {
  windowMs: number;       // Time window in milliseconds
  maxRequests: number;    // Max requests per window
  keyExtractor?: (req: Request) => string; // Custom key extractor
  message?: string;       // Custom error message
  storeName?: string;     // Name for the rate limit store
}

/**
 * Creates a rate limiting middleware.
 * 
 * @example
 * // 100 requests per 15 minutes per IP
 * router.use(rateLimit({ windowMs: 15 * 60 * 1000, maxRequests: 100 }));
 * 
 * // 10 requests per minute per user (for expensive endpoints)
 * router.use(rateLimit({ windowMs: 60 * 1000, maxRequests: 10, keyExtractor: req => (req as any).user?.id || req.ip }));
 */
export function rateLimit(config: RateLimitConfig) {
  const {
    windowMs,
    maxRequests,
    keyExtractor = (req: Request) => req.ip || 'unknown',
    message = 'Too many requests. Please try again later.',
    storeName = 'default',
  } = config;

  if (!rateLimitStores.has(storeName)) {
    rateLimitStores.set(storeName, new Map());
  }
  const store = rateLimitStores.get(storeName)!;

  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyExtractor(req);
    const now = Date.now();
    const entry = store.get(key);

    if (!entry || now > entry.resetAt) {
      // New window
      store.set(key, { count: 1, resetAt: now + windowMs });
      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', maxRequests - 1);
      res.setHeader('X-RateLimit-Reset', Math.ceil((now + windowMs) / 1000));
      return next();
    }

    entry.count++;
    const remaining = Math.max(0, maxRequests - entry.count);
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000));

    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        error: message,
        retry_after_seconds: retryAfter,
      });
    }

    next();
  };
}

// ─── Preset Rate Limits ─────────────────────────────────────────────────────

/** General API rate limit: 200 requests per 15 minutes */
export const generalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  maxRequests: 200,
  storeName: 'general',
});

/** Expensive operations (analysis, extraction): 20 per 15 minutes */
export const expensiveRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  maxRequests: 20,
  storeName: 'expensive',
  message: 'Rate limit exceeded for analytical operations. Please wait before running more analyses.',
  keyExtractor: (req: Request) => (req as any).user?.id || req.ip || 'unknown',
});

/** Write rate limit: 50 per 15 minutes */
export const writeRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  maxRequests: 50,
  storeName: 'write',
  keyExtractor: (req: Request) => (req as any).user?.id || req.ip || 'unknown',
});

// ============================================================================
// UUID VALIDATION
// ============================================================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates that a string is a valid UUID v4.
 */
export function isValidUUID(value: string): boolean {
  return UUID_REGEX.test(value);
}

/**
 * Middleware that validates specified route params are valid UUIDs.
 * 
 * @example
 * router.get('/:caseId/entities', validateUUIDParams('caseId'), handler);
 */
export function validateUUIDParams(...paramNames: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    for (const param of paramNames) {
      const value = req.params[param];
      if (value && !isValidUUID(value)) {
        return res.status(400).json({
          error: `Invalid ${param}: must be a valid UUID`,
        });
      }
    }
    next();
  };
}

// ============================================================================
// INPUT SANITIZATION
// ============================================================================

/**
 * Sanitize a string for use in LIKE/ILIKE patterns.
 * Escapes special PostgreSQL LIKE characters: %, _, \
 */
export function sanitizeLikePattern(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

/**
 * Validate that a query param value is one of the allowed enum values.
 * Returns the value if valid, or undefined if not.
 */
export function validateEnum<T extends string>(value: unknown, allowedValues: T[]): T | undefined {
  if (typeof value === 'string' && allowedValues.includes(value as T)) {
    return value as T;
  }
  return undefined;
}

/**
 * Clamp a numeric value between min and max.
 */
export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Validate that a string looks like an ISO date (loose check).
 */
export function isValidISODate(value: string): boolean {
  const date = new Date(value);
  return !isNaN(date.getTime()) && value.length >= 10;
}

// ============================================================================
// LLM OUTPUT SANITIZATION
// ============================================================================

/**
 * Sanitize LLM-generated text to prevent stored XSS.
 * Strips HTML tags and escapes special characters.
 */
export function sanitizeLLMOutput(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<[^>]*>/g, '')          // Strip HTML tags
    .replace(/&/g, '&amp;')           // Escape ampersands
    .replace(/</g, '&lt;')            // Escape <
    .replace(/>/g, '&gt;')            // Escape >
    .replace(/javascript:/gi, '')     // Remove javascript: URIs
    .replace(/on\w+\s*=/gi, '')       // Remove event handlers
    .trim();
}

/**
 * Sanitize an object's string values recursively.
 * Use on LLM extraction results before DB insertion.
 */
export function sanitizeObject<T extends Record<string, any>>(obj: T): T {
  const sanitized: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      sanitized[key] = sanitizeLLMOutput(value);
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map(item =>
        typeof item === 'string'
          ? sanitizeLLMOutput(item)
          : typeof item === 'object' && item !== null
            ? sanitizeObject(item)
            : item
      );
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeObject(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized as T;
}

// ============================================================================
// SECURITY HEADERS
// ============================================================================

/**
 * Middleware that adds security headers to all responses.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}
