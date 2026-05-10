/**
 * Health Check Routes
 */

import { Router, Request, Response } from 'express';
import { getQueueStats } from '../services/queueService.js';
import { getRedisConnection } from '../config/redis.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

/**
 * Basic health check
 */
router.get('/', async (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'horizon-backend',
    version: process.env.npm_package_version || '1.0.0',
  });
});

/**
 * Detailed health check with dependency status
 */
router.get('/detailed', async (_req: Request, res: Response) => {
  const checks: Record<string, { status: 'ok' | 'error'; latency?: number; error?: string }> = {};

  // Check Redis
  try {
    const startRedis = Date.now();
    const redis = getRedisConnection();
    await redis.ping();
    checks.redis = {
      status: 'ok',
      latency: Date.now() - startRedis,
    };
  } catch (error) {
    checks.redis = {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  // Check Supabase
  try {
    const startSupabase = Date.now();
    // Use a simple query that works with service_role key
    const { data, error } = await supabaseAdmin.from('vault_assets').select('id').limit(1);
    console.log('Supabase health check:', { data, error });
    // Even if no rows, as long as no error, connection is OK
    if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows returned
    checks.supabase = {
      status: 'ok',
      latency: Date.now() - startSupabase,
    };
  } catch (error: any) {
    console.error('Supabase health check error:', error);
    checks.supabase = {
      status: 'error',
      error: error?.message || error?.code || JSON.stringify(error) || 'Unknown error',
    };
  }

  // Get queue stats
  try {
    const queueStats = await getQueueStats();
    checks.queue = {
      status: 'ok',
      ...queueStats,
    } as any;
  } catch (error) {
    checks.queue = {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  const allHealthy = Object.values(checks).every(c => c.status === 'ok');

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  });
});

/**
 * Liveness probe (for Kubernetes/Railway)
 */
router.get('/live', (_req: Request, res: Response) => {
  res.status(200).send('OK');
});

/**
 * Readiness probe
 */
router.get('/ready', async (_req: Request, res: Response) => {
  try {
    // Quick check - just verify Redis is reachable
    const redis = getRedisConnection();
    await redis.ping();
    res.status(200).send('OK');
  } catch {
    res.status(503).send('Not Ready');
  }
});

export default router;
