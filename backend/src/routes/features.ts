/**
 * Features Route
 *
 * Returns feature flags for the authenticated user's plan.
 * Used by the frontend to conditionally render UI based on plan.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/subscription.js';
import { getFlags } from '../services/featureFlagService.js';

const router = Router();

/**
 * GET /api/features — Returns all feature flags for the user's tenant plan.
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).tenantId;

    if (!tenantId) {
      res.json({
        hasSubscription: false,
        flags: null,
      });
      return;
    }

    const flags = await getFlags(tenantId);

    if (!flags) {
      res.json({
        hasSubscription: false,
        flags: null,
      });
      return;
    }

    res.json({
      hasSubscription: true,
      flags,
    });
  } catch (err) {
    console.error('Error fetching features:', err);
    res.status(500).json({ error: 'Failed to fetch feature flags' });
  }
});

export default router;
