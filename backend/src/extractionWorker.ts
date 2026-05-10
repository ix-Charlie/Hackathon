/**
 * Legal Extraction Worker
 * Processes extraction jobs from the BullMQ queue
 */

import { Worker, Job } from 'bullmq';
import { config } from './config/index.js';
import { getRedisConnection, closeRedisConnection } from './config/redis.js';
import { extractLegalIntelligence, ExtractionJob, ExtractionResult } from './services/extractionService.js';
import { generateMatterSummary } from './services/matterSummaryService.js';

const QUEUE_NAME = 'legal-extraction';

console.log(`\n🧠 Horizon Legal Extraction Worker`);
console.log(`   Environment: ${config.nodeEnv}`);
console.log(`   Connecting to Redis...`);

const connection = getRedisConnection();

const worker = new Worker<ExtractionJob, ExtractionResult>(
  QUEUE_NAME,
  async (job: Job<ExtractionJob, ExtractionResult>) => {
    console.log(`\n🧠 Extraction job ${job.id}: ${job.data.filename}`);

    try {
      const result = await extractLegalIntelligence(
        job.data,
        async (progress, message) => {
          await job.updateProgress(progress);
          console.log(`   [${progress}%] ${message}`);
        }
      );

      if (result.success) {
        console.log(`✅ Extraction job ${job.id} completed successfully`);

        // Auto-generate/refresh matter summary after extraction
        try {
          await generateMatterSummary(job.data.case_id, job.data.tenant_id);
          console.log(`📊 Matter summary updated for case ${job.data.case_id}`);
        } catch (summaryError) {
          console.warn(`⚠️ Matter summary generation failed (non-blocking):`, summaryError);
        }

        return result;
      } else {
        throw new Error(result.error || 'Extraction failed');
      }
    } catch (error) {
      console.error(`❌ Extraction job ${job.id} failed:`, error);
      throw error;
    }
  },
  {
    connection,
    concurrency: 2, // Process 2 extractions in parallel (API-bound)
    limiter: {
      max: 5,        // Max 5 jobs
      duration: 60000, // Per minute (rate limiting for OpenAI)
    },
    removeOnComplete: {
      age: 24 * 3600,
      count: 500,
    },
    removeOnFail: {
      age: 7 * 24 * 3600,
    },
  }
);

// Event handlers
worker.on('ready', () => {
  console.log(`✅ Extraction worker ready and listening for jobs`);
});

worker.on('active', (job) => {
  console.log(`🔄 Extraction job ${job.id} started`);
});

worker.on('completed', (job, result) => {
  console.log(`✅ Extraction job ${job.id} completed:`, {
    entities: result.entities_count,
    clauses: result.clauses_count,
    obligations: result.obligations_count,
    dates: result.dates_count,
    risks: result.risks_count,
    tokens: result.tokens_used,
    time: `${result.processing_time_ms}ms`,
  });
});

worker.on('failed', (job, error) => {
  console.error(`❌ Extraction job ${job?.id} failed:`, error.message);
});

worker.on('error', (error) => {
  console.error('Extraction worker error:', error);
});

worker.on('stalled', (jobId) => {
  console.warn(`⚠️ Extraction job ${jobId} stalled`);
});

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`\n${signal} received. Shutting down extraction worker...`);
  await worker.close();
  console.log('✅ Extraction worker stopped');
  await closeRedisConnection();
  console.log('✅ Redis connection closed');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

console.log(`\n👂 Extraction worker listening for jobs on queue: ${QUEUE_NAME}\n`);
