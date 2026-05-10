/**
 * Express Application
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config/index.js';
import healthRoutes from './routes/health.js';
import documentRoutes from './routes/documents.js';
import extractionRoutes from './routes/extraction.js';
import analysisRoutes from './routes/analysis.js';
import billingRoutes from './routes/billing.js';
import featuresRoutes from './routes/features.js';
import adminRoutes from './routes/admin.js';
import chatRoutes from './routes/chat.js';
import exportRoutes from './routes/export.js';
import artifactRoutes from './routes/artifacts.js';
import {
  generalRateLimit,
  expensiveRateLimit,
  securityHeaders,
} from './middleware/security.js';
import {
  requireAuth as subRequireAuth,
  requireSubscription,
  checkCredits,
} from './middleware/subscription.js';

const app = express();

// ─── CORS (must be BEFORE helmet/security so preflight OPTIONS work) ────────
const corsOptions = {
  origin: config.cors.origins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-client-info', 'apikey'],
  exposedHeaders: ['X-Credit-Warning', 'X-Credit-Used', 'X-Credit-Limit', 'X-Credit-Percent'],
};

// Handle preflight requests first
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

// Security middleware (after CORS)
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: { policy: 'unsafe-none' },
}));
app.use(securityHeaders);

// Request logging
app.use(morgan(config.isProduction ? 'combined' : 'dev'));

// ─── Stripe Webhook (MUST be before express.json — needs raw body) ──────────
app.post(
  '/api/billing/webhook',
  express.raw({ type: 'application/json' }),
  (req, res, next) => {
    // Forward to billing routes (webhook handler)
    // The billing router's POST /webhook middleware will handle it
    next();
  },
);

// Body parsing (after webhook route)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ─── Routes ─────────────────────────────────────────────────────────────────

// Public routes
app.use('/health', healthRoutes);

// Billing routes (mix of public and authenticated)
app.use('/api/billing', billingRoutes);

// Feature flags (authenticated)
app.use('/api/features', featuresRoutes);

// Admin routes (authenticated + admin only)
app.use('/api/admin', adminRoutes);

// Core routes (with subscription + credit enforcement)
app.use('/api/documents', generalRateLimit, subRequireAuth, requireSubscription, checkCredits, documentRoutes);
app.use('/api/matters', generalRateLimit, subRequireAuth, requireSubscription, extractionRoutes);
app.use('/api/analysis', expensiveRateLimit, subRequireAuth, requireSubscription, checkCredits, analysisRoutes);

// Chat with attachments — proxies to edge function after processing files
app.use('/api/chat', generalRateLimit, subRequireAuth, requireSubscription, checkCredits, chatRoutes);

// Export — Word/PDF generation (no subscription gate — export is a basic feature)
app.use('/api/export', generalRateLimit, subRequireAuth, exportRoutes);

// Artifacts — legal document CRUD + export (subscription required)
app.use('/api/artifacts', generalRateLimit, subRequireAuth, requireSubscription, artifactRoutes);

// Root route
app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'Horizon Document Processing Backend',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      documents: '/api/documents',
      matters: '/api/matters',
      analysis: '/api/analysis',
      chat: '/api/chat',
      export: '/api/export',
      artifacts: '/api/artifacts',
      billing: '/api/billing',
      features: '/api/features',
      admin: '/api/admin',
    },
  });
});

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: config.isProduction ? undefined : err.message,
  });
});

export default app;
