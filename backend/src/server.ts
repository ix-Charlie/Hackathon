/**
 * Server Entry Point
 */

import app from './app.js';
import { config } from './config/index.js';
import { getQueue, closeQueue } from './services/queueService.js';
import { closeRedisConnection } from './config/redis.js';
import { flushPendingUsage } from './services/tokenUsageService.js';
import { supabaseAdmin } from './config/supabase.js';

const server = app.listen(config.port, () => {
  console.log(`\n🚀 Horizon Backend Server`);
  console.log(`   Environment: ${config.nodeEnv}`);
  console.log(`   Port: ${config.port}`);
  console.log(`   Endpoints:`);
  console.log(`     - Health: http://localhost:${config.port}/health`);
  console.log(`     - API: http://localhost:${config.port}/api/documents`);
  console.log(`\n`);

  // Initialize queue connection
  try {
    getQueue();
    console.log('📋 Queue connection established');
  } catch (error) {
    console.error('⚠️ Queue connection failed:', error);
    console.log('   Documents will be processed synchronously');
  }

  // ── Chat temp file cleanup — runs every 6 hours ──────────────────────
  const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
  const TEMP_FILE_TTL_MS = 24 * 60 * 60 * 1000;    // 24 hours

  async function cleanupChatTempFiles() {
    try {
      const { data: folders, error: listError } = await supabaseAdmin.storage
        .from('documents')
        .list('chat-temp', { limit: 100 });

      if (listError || !folders) {
        console.error('[cleanup] Failed to list chat-temp:', listError);
        return;
      }

      const cutoff = Date.now() - TEMP_FILE_TTL_MS;
      let deleted = 0;

      for (const folder of folders) {
        // Each folder is a tenantId
        const { data: files } = await supabaseAdmin.storage
          .from('documents')
          .list(`chat-temp/${folder.name}`, { limit: 500 });

        if (!files) continue;

        const expired = files.filter(f => {
          // Files are named {timestamp}_{filename} — parse timestamp from name
          const ts = parseInt(f.name.split('_')[0], 10);
          return !isNaN(ts) && ts < cutoff;
        });

        if (expired.length > 0) {
          const paths = expired.map(f => `chat-temp/${folder.name}/${f.name}`);
          await supabaseAdmin.storage.from('documents').remove(paths);
          deleted += expired.length;
        }
      }

      if (deleted > 0) {
        console.log(`[cleanup] Deleted ${deleted} expired chat-temp files`);
      }
    } catch (err) {
      console.error('[cleanup] Chat temp cleanup error:', err);
    }
  }

  // Initial cleanup after 1 minute, then every 6 hours
  setTimeout(cleanupChatTempFiles, 60_000);
  setInterval(cleanupChatTempFiles, CLEANUP_INTERVAL_MS);
  console.log('🧹 Chat temp cleanup scheduled (every 6h, 24h TTL)');
});

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`\n${signal} received. Starting graceful shutdown...`);

  // Stop accepting new connections
  server.close(() => {
    console.log('✅ HTTP server closed');
  });

  // Close queue and Redis connections
  try {
    await flushPendingUsage();
    await closeQueue();
    await closeRedisConnection();
    console.log('✅ All connections closed');
  } catch (error) {
    console.error('Error during shutdown:', error);
  }

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
