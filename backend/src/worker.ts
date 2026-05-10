/**
 * Document Processing Worker
 * Processes documents from the BullMQ queue
 */

import { Worker, Job } from 'bullmq';
import { config } from './config/index.js';
import { getRedisConnection, closeRedisConnection } from './config/redis.js';
import { processDocument } from './services/documentService.js';
import { ProcessDocumentJob, ProcessingResult } from './types/index.js';

const QUEUE_NAME = 'document-processing';

console.log(`\n🔧 Horizon Document Processing Worker`);
console.log(`   Environment: ${config.nodeEnv}`);
console.log(`   Connecting to Redis...`);

const connection = getRedisConnection();

const worker = new Worker<ProcessDocumentJob, ProcessingResult>(
  QUEUE_NAME,
  async (job: Job<ProcessDocumentJob, ProcessingResult>) => {
    console.log(`\n📄 Processing job ${job.id}: ${job.data.filename}`);

    try {
      const result = await processDocument(
        job.data,
        async (progress, message) => {
          // Update job progress
          await job.updateProgress(progress);
          console.log(`   [${progress}%] ${message}`);
        }
      );

      if (result.success) {
        console.log(`✅ Job ${job.id} completed successfully`);
        return result;
      } else {
        throw new Error(result.error || 'Processing failed');
      }
    } catch (error) {
      console.error(`❌ Job ${job.id} failed:`, error);
      throw error;
    }
  },
  {
    connection,
    concurrency: 3, // Process 3 documents in parallel
    limiter: {
      max: 10,      // Max 10 jobs
      duration: 60000, // Per minute
    },
    removeOnComplete: {
      age: 24 * 3600, // Keep completed for 24 hours
      count: 1000,
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // Keep failed for 7 days
    },
  }
);

// Event handlers
worker.on('ready', () => {
  console.log(`✅ Worker ready and listening for jobs`);
});

worker.on('active', (job) => {
  console.log(`🔄 Job ${job.id} started processing`);
});

worker.on('completed', (job, result) => {
  console.log(`✅ Job ${job.id} completed:`, {
    chunks: result.chunks_created,
    time: `${result.processing_time_ms}ms`,
  });
});

worker.on('failed', (job, error) => {
  console.error(`❌ Job ${job?.id} failed:`, error.message);
});

worker.on('error', (error) => {
  console.error('Worker error:', error);
});

worker.on('stalled', (jobId) => {
  console.warn(`⚠️ Job ${jobId} stalled`);
});

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`\n${signal} received. Shutting down worker...`);

  // Stop accepting new jobs
  await worker.close();
  console.log('✅ Worker stopped');

  // Close Redis connection
  await closeRedisConnection();
  console.log('✅ Redis connection closed');

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

console.log(`\n👂 Worker listening for jobs on queue: ${QUEUE_NAME}\n`);
